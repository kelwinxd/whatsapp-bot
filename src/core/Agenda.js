import cron from "node-cron";
import { resolverHorario, descreverHorario } from "./horarios.js";

// Mensagens que o bot manda por conta própria, na hora marcada — o inverso do
// resto do projeto, que só reage a webhook. Cada tarefa é uma linha do
// agenda.json: quando disparar, para quem, e o que pedir ao modelo.
//
// Roda no mesmo processo do servidor, como no suplementos-project. Funciona
// porque hospedamos em algo persistente (VPS, Railway); em serverless o
// processo morre entre requisições e o cron nunca dispararia.

const LIMITE_DA_FONTE = 4_000; // caracteres enviados ao modelo

export class Agenda {
  constructor({ tarefas = [], bot, metricas, logger = console, fusoHorario = "America/Sao_Paulo" }) {
    this.tarefas = tarefas;
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
      ativa: Boolean(t.ativa),
      telefone: t.telefone,
      instrucao: t.instrucao,
      fonte: t.fonte ?? null,
      agendada: this.agendadas.has(t.nome),
    }));
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
