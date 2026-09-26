import cron from "node-cron";
import { writeFile } from "node:fs/promises";
import { resolverHorario, descreverHorario, decomporHorario } from "./horarios.js";

// Mensagens que o bot manda por conta própria, na hora marcada — o inverso do
// resto do projeto, que só reage a webhook. Cada tarefa é uma linha do
// agenda.json: quando disparar, para quem, e o que pedir ao modelo.
//
// Roda no mesmo processo do servidor, como no suplementos-project. Funciona
// porque hospedamos em algo persistente (VPS, Railway); em serverless o
// processo morre entre requisições e o cron nunca dispararia.

const LIMITE_DA_FONTE = 4_000; // caracteres enviados ao modelo

export class Agenda {
  constructor({
    tarefas = [],
    bot,
    metricas,
    logger = console,
    fusoHorario = "America/Sao_Paulo",
    // Onde gravar quando o painel salvar. O mesmo arquivo lido na subida.
    arquivo = process.env.AGENDA_ARQUIVO ?? "agenda.json",
  }) {
    this.tarefas = tarefas;
    this.arquivo = arquivo;
    this.bot = bot;
    this.metricas = metricas;
    this.logger = logger;
    this.fusoHorario = fusoHorario;
    /** @type {Map<string, import('node-cron').ScheduledTask>} */
    this.agendadas = new Map();
  }

  // Valida antes de agendar: expressão errada só apareceria na hora de
  // disparar, e aí a mensagem simplesmente nunca chegaria.
  iniciar() {
    for (const tarefa of this.tarefas) {
      if (!tarefa.ativa) continue;

      // O agenda.json pode trazer um nome ("TODO_DIA_8AM"), um horário
      // ("08:30") ou cron cru — aqui tudo vira cron.
      const expressao = resolverHorario(tarefa.cron);
      if (!expressao || !cron.validate(expressao)) {
        this.logger.error(`❌ Tarefa "${tarefa.nome}": horário inválido (${tarefa.cron})`);
        continue;
      }
      if (!tarefa.telefone || !tarefa.instrucao) {
        this.logger.error(`❌ Tarefa "${tarefa.nome}": falta telefone ou instrucao`);
        continue;
      }

      const agendada = cron.schedule(
        expressao,
        () => {
          this.executar(tarefa.nome).catch((erro) =>
            this.logger.error(`❌ Tarefa "${tarefa.nome}" falhou:`, erro),
          );
        },
        { timezone: this.fusoHorario },
      );

      this.agendadas.set(tarefa.nome, agendada);
      this.logger.log(
        `⏰ Tarefa "${tarefa.nome}" agendada: ${descreverHorario(expressao)}`,
      );
    }

    return this.agendadas.size;
  }

  parar() {
    for (const agendada of this.agendadas.values()) agendada.stop();
    this.agendadas.clear();
  }

  listar() {
    return this.tarefas.map((t) => ({
      nome: t.nome,
      cron: t.cron,
      quando: descreverHorario(resolverHorario(t.cron) ?? t.cron),
      // Hora/dias/frequência separados, para o painel abrir os selects já na
      // posição certa sem reinterpretar o valor salvo.
      horario: decomporHorario(t.cron),
      ativa: Boolean(t.ativa),
      telefone: t.telefone,
      instrucao: t.instrucao,
      fonte: t.fonte ?? null,
      agendada: this.agendadas.has(t.nome),
    }));
  }

  // Valida antes de salvar. Devolve a lista de problemas em texto, para o
  // painel mostrar qual campo está errado — em vez de gravar algo que só
  // falharia no horário do disparo.
  validar(tarefas) {
    if (!Array.isArray(tarefas)) return ["formato inválido: esperava uma lista de tarefas"];

    const problemas = [];
    const vistos = new Set();

    tarefas.forEach((tarefa, indice) => {
      const onde = tarefa?.nome ? `"${tarefa.nome}"` : `tarefa ${indice + 1}`;

      if (!tarefa?.nome?.trim()) problemas.push(`${onde}: falta o nome`);
      else if (vistos.has(tarefa.nome)) problemas.push(`${onde}: nome repetido`);
      else vistos.add(tarefa.nome);

      if (!String(tarefa?.telefone ?? "").replace(/\D/g, "")) {
        problemas.push(`${onde}: falta o telefone`);
      }
      if (!tarefa?.instrucao?.trim()) problemas.push(`${onde}: falta a instrução`);

      const expressao = resolverHorario(tarefa?.cron);
      if (!expressao || !cron.validate(expressao)) {
        problemas.push(`${onde}: horário inválido (${tarefa?.cron ?? "vazio"})`);
      }
      if (tarefa?.fonte && !/^https?:\/\//.test(tarefa.fonte)) {
        problemas.push(`${onde}: a fonte precisa ser uma URL http(s)`);
      }
    });

    return problemas;
  }

  // Substitui a agenda inteira: grava no arquivo e reagenda na hora, sem
  // reiniciar o servidor. Se a validação falhar, nada é gravado.
  async salvar(tarefas) {
    const problemas = this.validar(tarefas);
    if (problemas.length > 0) {
      const erro = new Error(problemas.join("; "));
      erro.problemas = problemas;
      throw erro;
    }

    const normalizadas = tarefas.map((t) => ({
      nome: t.nome.trim(),
      cron: String(t.cron).trim(),
      ativa: Boolean(t.ativa),
      telefone: String(t.telefone).replace(/\D/g, ""),
      instrucao: t.instrucao.trim(),
      ...(t.fonte ? { fonte: t.fonte.trim() } : {}),
    }));

    await writeFile(
      this.arquivo,
      `${JSON.stringify({ fusoHorario: this.fusoHorario, tarefas: normalizadas }, null, 2)}\n`,
      "utf8",
    );

    this.tarefas = normalizadas;
    this.parar();
    this.iniciar();

    return this.listar();
  }

  // Busca a fonte externa, quando a tarefa tem uma. É o que permite "trazer a
  // informação" em vez de só gerar texto: o conteúdo vai como contexto para o
  // modelo. Falha na fonte não cancela a tarefa — o modelo é avisado de que o
  // dado não veio, e decide o que dizer.
  async buscarFonte(url) {
    try {
      const resposta = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resposta.ok) return `(a fonte ${url} respondeu ${resposta.status})`;
      const texto = await resposta.text();
      return texto.slice(0, LIMITE_DA_FONTE);
    } catch (erro) {
      return `(não foi possível ler a fonte ${url}: ${erro.message})`;
    }
  }

  async executar(nome) {
    const tarefa = this.tarefas.find((t) => t.nome === nome);
    if (!tarefa) throw new Error(`Tarefa desconhecida: ${nome}`);

    this.logger.log(`⏰ Executando tarefa "${nome}"...`);
    const contexto = tarefa.fonte ? await this.buscarFonte(tarefa.fonte) : null;

    return this.bot.executarTarefa({
      nome,
      telefone: tarefa.telefone,
      instrucao: tarefa.instrucao,
      contexto,
    });
  }
}
