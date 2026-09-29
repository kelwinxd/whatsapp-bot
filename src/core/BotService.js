import {
  montarPromptDeSistema,
  separarPerfil,
  SEPARADOR_DE_MENSAGENS,
  MARCADOR_HUMANO,
} from "./prompt.js";
import { nomeDoDocumento } from "./lojas.js";
import { apresentacaoDaLoja } from "./formularioLoja.js";
import { ControleDeAtendimento, IdsEnviados, comandoDoDono } from "./atendimento.js";
import { metricasNulas } from "./Metricas.js";
import { custoDeTexto, custoDeTranscricao, somar } from "./billing.js";

// Regra do bot, sem saber quem entrega a mensagem nem quem gera o texto:
// recebe as três portas prontas pelo construtor (injeção de dependência).
// É o que torna o fluxo testável sem rede — basta passar dublês.

// Ritmo do "digitando...". Referência real: pessoa média digita ~40 palavras
// por minuto (≈300ms por caractere), quem é rápido faz ~80 (≈150ms). Só que
// mensagem de 130 caracteres nesse ritmo daria 20s de espera, e com resposta
// picada isso soma por mensagem — a conversa fica insuportável.
//
// 45ms por caractere é o meio termo: dá ~265 palavras por minuto, rápido além
// do humano, mas o tempo varia com o tamanho da frase (2s, 4s, 5s), que é o
// que cria a sensação de alguém digitando. Teto em 5s para não saturar todas
// as mensagens no mesmo valor — saturado, o ritmo volta a parecer robô.
const RITMO_PADRAO = {
  msPorCaractere: 45,
  minimoMs: 1_000,
  maximoMs: 5_000,
  // Intervalo entre uma mensagem e a próxima, antes de o "digitando..."
  // aparecer de novo: é o tempo em que a pessoa pensaria na frase seguinte.
  pausaMs: 800,
  // Variação de ±15% para o tempo não ser idêntico a cada frase do mesmo
  // tamanho — repetição exata é o que denuncia robô.
  variacao: 0.15,
};

// Uma linha contendo só o marcador (aceita espaços e mais hifens em volta).
// String.raw porque num template comum o \s viraria um "s" solto e o \n, uma
// quebra de linha de verdade — a regex casaria a coisa errada, silenciosamente.
const REGEX_SEPARADOR = new RegExp(
  String.raw`\n\s*${SEPARADOR_DE_MENSAGENS}-*\s*(\n|$)`,
);

const ERRO_AO_RESPONDER =
  "Tive um probleminha para responder agora 😕 Tenta de novo em instantes.";

// Imagem é visão nativa do modelo; áudio passa antes por transcrição. Vídeo e
// documento continuam de fora — cada um pediria outro caminho.
const MIDIA_SUPORTADA = new Set(["imagem", "audio"]);

const AVISO_POR_TIPO = {
  video: "Ainda não consigo ver vídeo 😅 Manda uma foto ou escreve?",
  documento: "Ainda não consigo ler documento 😅 Pode escrever o que precisa?",
};

const PERGUNTA_PADRAO_IMAGEM = "O que tem nesta imagem?";

const AUDIO_SEM_FALA =
  "Não consegui entender o áudio 😕 Pode repetir ou escrever?";

export class BotService {
  constructor({
    whatsapp,
    ia,
    conversas,
    base = null,
    // Repositório de lojas: o perfil "loja_<slug>" diz qual delas atende.
    lojas = null,
    prompt = { perfil: "suplementos" },
    metricas = metricasNulas,
    ritmo = {},
    imagem = { detalhe: "auto" },
    atendimento = new ControleDeAtendimento(),
    // Número que recebe o aviso quando o bot encaminha para uma pessoa.
    avisarEm = null,
    logger = console,
    // Injetáveis para o teste não depender de sorteio nem esperar de verdade.
    aleatorio = Math.random,
    dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    this.whatsapp = whatsapp;
    this.ia = ia;
    this.conversas = conversas;
    this.base = base;
    this.lojas = lojas;
    this.prompt = prompt;
    this.metricas = metricas;
    this.ritmo = { ...RITMO_PADRAO, ...ritmo };
    this.imagem = imagem;
    this.atendimento = atendimento;
    this.avisarEm = avisarEm;
    this.idsEnviados = new IdsEnviados();
    this.logger = logger;
    this.aleatorio = aleatorio;
    this.dormir = dormir;
  }

  // Envio avulso, pedido pelo painel: não passa pela IA nem pelo histórico.
  async enviarManual({ telefone, texto }) {
    const inicio = Date.now();
    try {
      await this.enviar({ telefone, texto, digitandoMs: this.digitandoMs(texto) });
      this.metricas.registrar({
        tipo: "envio-manual",
        telefone,
        resposta: texto,
        totalMs: Date.now() - inicio,
      });
      return { enviada: true };
    } catch (erro) {
      this.metricas.registrar({ tipo: "erro", telefone, erro: erro.message });
      throw erro;
    }
  }

  // Os adaptadores podem devolver só o texto (como os dublês dos testes) ou
  // { texto, uso } — com o uso, o custo sai exato em vez de estimado.
  normalizarDaIA(retorno) {
    if (typeof retorno === "string") return { texto: retorno, uso: null };
    return { texto: retorno?.texto ?? "", uso: retorno?.uso ?? null };
  }

  // Qual loja o perfil ativo atende, e a que documento a busca fica restrita.
  // Sem loja no perfil, o comportamento é o de antes: prompt sem dados de
  // loja e busca na base inteira.
  async lojaAtiva() {
    const { slug } = separarPerfil(this.prompt.perfil);
    if (!slug) return { resumo: null, documentos: undefined, apresentacao: null, responsavel: null };

    const loja = this.lojas ? await this.lojas.obter(slug) : null;
    if (!loja) {
      this.logger.error(`❌ Perfil "${this.prompt.perfil}": loja "${slug}" não cadastrada`);
      return {
        resumo: null,
        documentos: [nomeDoDocumento(slug)],
        apresentacao: null,
        responsavel: null,
      };
    }

    return {
      resumo: loja.resumo,
      documentos: [loja.documento],
      apresentacao: apresentacaoDaLoja(loja.respostas),
      responsavel: String(loja.respostas.telefoneResponsavel ?? "").replace(/\D/g, "") || null,
    };
  }

  async buscarNaBase(pergunta, documentos) {
    if (!this.base || !pergunta) return [];
    try {
      return await this.base.buscar(pergunta, undefined, { documentos });
    } catch (erro) {
      this.logger.error("❌ Falha ao consultar a base de conhecimento:", erro);
      return [];
    }
  }

  custoDeUso(uso, tipo) {
    if (!uso) return null;
    return tipo === "transcricao" ? custoDeTranscricao(uso) : custoDeTexto(uso);
  }

  // Tempo de "digitando..." pelo tamanho do texto, em ms. Cada adaptador
  // converte para a unidade da sua API.
  digitandoMs(texto) {
    const { msPorCaractere, minimoMs, maximoMs, variacao } = this.ritmo;
    // (aleatorio() - 0.5) * 2 dá algo entre -1 e 1; multiplicado pela variação,
    // vira o desvio percentual aplicado ao tempo.
    const desvio = 1 + (this.aleatorio() - 0.5) * 2 * variacao;
    const bruto = texto.length * msPorCaractere * desvio;
    return Math.round(Math.min(maximoMs, Math.max(minimoMs, bruto)));
  }

  // Divide no marcador que o modelo inseriu. O excedente é juntado na última
  // mensagem em vez de descartado: perder pedaço de resposta é pior que mandar
  // uma mensagem a mais.
  dividirResposta(resposta, maximo = 1) {
    let partes = resposta
      .split(REGEX_SEPARADOR)
      .map((p) => (p ?? "").trim())
      .filter(Boolean);

    // Na prática o modelo costuma ignorar o marcador e separar por linha em
    // branco, que é a mesma intenção. Aceitar os dois evita depender de ele
    // obedecer ao pedido literal.
    if (partes.length <= 1 && maximo > 1) {
      partes = resposta
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
    }

    if (partes.length <= 1) return [resposta.trim()];
    if (partes.length <= maximo) return partes;

    const inicio = partes.slice(0, maximo - 1);
    return [...inicio, partes.slice(maximo - 1).join("\n\n")];
  }

  // Quais mensagens o bot ignora. Fora daqui para ficar explícito e fácil de
  // mudar (liberar grupos, por exemplo).
  async deveIgnorar(mensagem) {
    if (mensagem.grupo) return "mensagem de grupo";
    // Alguém da equipe está conduzindo esta conversa: o bot fica fora até a
    // pausa expirar. Dois respondendo a mesma coisa é pior que demorar.
    if (await this.atendimento.estaPausado(mensagem.telefone)) {
      return "atendimento humano em andamento";
    }
    return null;
  }

  // Mensagem com fromMe que não saiu daqui = alguém digitou no celular. O bot
  // então cala nessa conversa e volta sozinho depois.
  async tratarMensagemPropria(mensagem) {
    if (this.idsEnviados.contem(mensagem.id)) {
      return { tratada: false, motivo: "mensagem enviada pelo próprio bot" };
    }

    // "#pausar" e "#voltar" digitados no chat do cliente: o dono comanda de
    // onde ele já está, sem abrir painel.
    const comando = comandoDoDono(mensagem.texto);
    if (comando === "pausar") {
      await this.atendimento.pausar(mensagem.telefone, null);
      this.metricas.registrar({
        tipo: "pausada",
        telefone: mensagem.telefone,
        motivo: "#pausar: sem prazo, até #voltar",
      });
      this.logger.log(`🙋 ${mensagem.telefone}: pausado por comando, até #voltar`);
      return { tratada: false, motivo: "pausado por comando" };
    }
    if (comando === "retomar") {
      await this.atendimento.retomar(mensagem.telefone);
      this.metricas.registrar({
        tipo: "retomada",
        telefone: mensagem.telefone,
        motivo: "#voltar: bot reassumiu",
      });
      this.logger.log(`🤖 ${mensagem.telefone}: bot reassumiu por comando`);
      return { tratada: false, motivo: "retomado por comando" };
    }

    const { expiraEm } = await this.atendimento.pausar(mensagem.telefone);
    const minutos = this.atendimento.minutosPadrao;
    this.metricas.registrar({
      tipo: "pausada",
      telefone: mensagem.telefone,
      motivo: `resposta humana detectada; bot pausado por ${minutos} min`,
      expiraEm,
    });
    this.logger.log(`🙋 ${mensagem.telefone}: humano assumiu, bot pausado por ${minutos} min`);
    return { tratada: false, motivo: "humano assumiu a conversa" };
  }

  async processarWebhook(corpo) {
    const mensagem = this.whatsapp.interpretarWebhook(corpo);
    if (!mensagem) return { tratada: false, motivo: "payload sem texto" };

    if (mensagem.minha) return this.tratarMensagemPropria(mensagem);

    const ignorar = await this.deveIgnorar(mensagem);
    if (ignorar) {
      this.metricas.registrar({ tipo: "ignorada", telefone: mensagem.telefone, motivo: ignorar });
      return { tratada: false, motivo: ignorar };
    }

    return this.responder(mensagem);
  }

  // Monta o que vai para a IA nesta rodada e o que fica guardado no histórico.
  // São coisas diferentes de propósito: a imagem vai inteira para o modelo
  // agora, mas no histórico entra só uma marca em texto. Guardar a imagem
  // faria o modelo ser cobrado por ela de novo em toda resposta seguinte da
  // conversa — e imagem no gpt-4o-mini custa 33x em tokens.
  async prepararConteudo({ texto, midia }) {
    if (!midia) return { paraIA: texto, paraHistorico: texto };

    const { base64, mimetype } = await this.whatsapp.obterMidiaBase64(midia);

    // Áudio vira texto antes de chegar ao modelo de conversa: o que ele
    // recebe é indistinguível de alguém que digitou a mesma frase.
    if (midia.tipo === "audio") {
      // trim aqui e não só no adaptador: silêncio costuma voltar como espaços
      // ou string vazia, e a decisão de "não deu para entender" é do núcleo.
      const retorno = await this.ia.transcrever({ base64, mimetype });
      const { texto: bruto, uso } = this.normalizarDaIA(retorno);
      const transcricao = bruto.trim();
      const custo = this.custoDeUso(uso, "transcricao");
      if (!transcricao) return { vazio: true, custo };
      return {
        paraIA: transcricao,
        paraHistorico: `[áudio] ${transcricao}`,
        transcricao,
        custo,
      };
    }

    const pergunta = texto || PERGUNTA_PADRAO_IMAGEM;

    return {
      paraIA: [
        { type: "text", text: pergunta },
        {
          type: "image_url",
          image_url: {
            url: `data:${mimetype};base64,${base64}`,
            // Quanto detalhe o modelo processa — muda custo e precisão.
            detail: this.imagem.detalhe,
          },
        },
      ],
      paraHistorico: `[imagem enviada] ${pergunta}`,
    };
  }

  // Todo envio passa por aqui, para o id ficar registrado: é assim que o
  // webhook distingue a mensagem do bot da que a pessoa digitou no celular.
  async enviar({ telefone, texto, digitandoMs }) {
    const resultado = await this.whatsapp.enviarTexto({ telefone, texto, digitandoMs });
    this.idsEnviados.registrar(resultado?.id);
    return resultado;
  }

  // Separa o marcador de encaminhamento do texto que vai para o cliente. O
  // modelo escreve [HUMANO] quando decide chamar alguém; isso não pode
  // aparecer na mensagem.
  separarEncaminhamento(resposta) {
    const pedeHumano = resposta.includes(MARCADOR_HUMANO);
    const limpa = pedeHumano
      ? resposta.split(MARCADOR_HUMANO).join("").replace(/[ \t]+\n/g, "\n").trim()
      : resposta;
    return { texto: limpa, pedeHumano };
  }

  // Avisa quem atende que a conversa precisa de uma pessoa. Sem isso o
  // encaminhamento seria só uma promessa ao cliente.
  async avisarEquipe({ telefone, nome, pergunta }) {
    // Preferência para o telefone cadastrado na loja; avisarEm é o padrão
    // global, útil quando não há loja (ou ela não preencheu).
    const daLoja = (await this.lojaAtiva()).responsavel;
    const destino = daLoja ?? this.avisarEm;
    if (!destino) return false;

    const aviso = [
      `🙋 Atendimento pedido por ${nome ?? "cliente"} (${telefone})`,
      pergunta ? `Última mensagem: "${pergunta}"` : null,
      "Responda direto na conversa dele; eu fico fora até você terminar.",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      await this.enviar({ telefone: destino, texto: aviso, digitandoMs: 1000 });
      return true;
    } catch (erro) {
      this.logger.error("❌ Falha ao avisar a equipe:", erro);
      return false;
    }
  }

  // Envia a resposta em partes. Sequencial de propósito: a Evolution só envia
  // depois do "digitando...", então esperar cada uma é o que cria o ritmo de
  // conversa. Em paralelo, as mensagens chegariam juntas e fora de ordem.
  async enviarPartes(telefone, resposta) {
    const partes = this.dividirResposta(resposta, this.prompt.maxMensagens ?? 1);

    for (const [indice, parte] of partes.entries()) {
      // Antes da primeira não cabe pausa: a espera da IA já fez esse papel.
      if (indice > 0) await this.dormir(this.ritmo.pausaMs);
      await this.enviar({ telefone, texto: parte, digitandoMs: this.digitandoMs(parte) });
    }

    return partes;
  }

  // Mensagem que o bot inicia, vinda da agenda. Não existe pergunta de
  // ninguém: a instrução da tarefa faz esse papel, e a fonte externa (quando a
  // tarefa tem uma) entra como contexto.
  async executarTarefa({ nome, telefones, telefone, instrucao, contexto }) {
    const inicio = Date.now();
    // Aceita um número ou vários; o texto é gerado uma vez só e enviado a
    // todos — pedir ao modelo por destinatário custaria N vezes mais e cada
    // pessoa receberia uma versão diferente da mesma mensagem.
    const destinos = (telefones ?? [telefone]).filter(Boolean);

    const pedido = contexto
      ? `${instrucao}\n\nUse estes dados, recém-buscados, como base:\n${contexto}`
      : instrucao;

    try {
      const antesDaIA = Date.now();
      const { texto: resposta, uso } = this.normalizarDaIA(
        await this.ia.responder({
          sistema: montarPromptDeSistema({
            nome: "amigo",
            ...this.prompt,
            loja: (await this.lojaAtiva()).resumo,
          }),
          mensagens: [{ role: "user", content: pedido }],
        }),
      );
      const iaMs = Date.now() - antesDaIA;

      let partes = [];
      for (const destino of destinos) {
        partes = await this.enviarPartes(destino, resposta);
        // Só a resposta entra no histórico: a instrução é nossa, não da
        // pessoa, e ficaria como se ela tivesse pedido isso.
        await this.conversas.acrescentar(destino, { role: "assistant", content: resposta });
      }

      this.metricas.registrar({
        tipo: "agendada",
        tarefa: nome,
        telefone: destinos.join(", "),
        destinos: destinos.length,
        pergunta: instrucao,
        resposta,
        temFonte: Boolean(contexto),
        partes: partes.length,
        iaMs,
        totalMs: Date.now() - inicio,
        custoUsd: this.custoDeUso(uso),
      });

      this.logger.log(
        `⏰ Tarefa "${nome}" enviada para ${destinos.length} número(s): ${destinos.join(", ")}`,
      );
      return { enviada: true, resposta, partes };
    } catch (erro) {
      this.logger.error(`❌ Tarefa "${nome}" falhou:`, erro);
      this.metricas.registrar({
        tipo: "erro",
        tarefa: nome,
        telefone: destinos.join(", "),
        erro: erro.message,
        totalMs: Date.now() - inicio,
      });
      throw erro;
    }
  }

  async responder(mensagem) {
    const { telefone, nome, texto, midia } = mensagem;

    if (midia && !MIDIA_SUPORTADA.has(midia.tipo)) {
      const aviso = AVISO_POR_TIPO[midia.tipo] ?? "Ainda não consigo abrir esse tipo de arquivo 😅";
      await this.enviar({ telefone, texto: aviso, digitandoMs: this.digitandoMs(aviso) }).catch(
        (e) => this.logger.error("❌ Falha ao avisar sobre a mídia:", e),
      );
      const motivo = `mídia não suportada: ${midia.tipo}`;
      this.metricas.registrar({ tipo: "ignorada", telefone, motivo });
      return { tratada: false, motivo };
    }

    const inicio = Date.now();

    try {
      const { paraIA, paraHistorico, transcricao, vazio, custo: custoDaMidia } =
        await this.prepararConteudo(mensagem);

      // Áudio sem fala reconhecível: avisa em vez de mandar vazio para a IA.
      if (vazio) {
        await this.enviar({
          telefone,
          texto: AUDIO_SEM_FALA,
          digitandoMs: this.digitandoMs(AUDIO_SEM_FALA),
        });
        this.metricas.registrar({ tipo: "ignorada", telefone, motivo: "áudio sem fala" });
        return { tratada: false, motivo: "áudio sem fala" };
      }

      // Consulta a base de conhecimento, quando há uma. Falha na base não
      // derruba a resposta: o bot responde sem os trechos, como antes.
      const { resumo: resumoDaLoja, documentos, apresentacao } = await this.lojaAtiva();

      // Histórico vazio = primeira mensagem desta conversa. É o gancho para o
      // bot se apresentar uma vez, e só uma.
      const historico = await this.conversas.historico(telefone);
      const primeiraMensagem = historico.length === 0;
      const trechos = await this.buscarNaBase(
        typeof paraIA === "string" ? paraIA : (transcricao ?? texto),
        documentos,
      );

      const antesDaIA = Date.now();
      const { texto: resposta, uso } = this.normalizarDaIA(
        await this.ia.responder({
          sistema: montarPromptDeSistema({
            nome,
            ...this.prompt,
            trechos,
            loja: resumoDaLoja,
            apresentar: primeiraMensagem ? apresentacao : null,
          }),
          mensagens: [...historico, { role: "user", content: paraIA }],
        }),
      );
      const iaMs = Date.now() - antesDaIA;
      const custoUsd = somar(custoDaMidia, this.custoDeUso(uso));

      // Só guarda depois de dar certo: falha na IA não deixa a pergunta órfã
      // no histórico.
      await this.conversas.acrescentar(telefone, { role: "user", content: paraHistorico });
      await this.conversas.acrescentar(telefone, { role: "assistant", content: resposta });

      const antesDoEnvio = Date.now();
      const { texto: paraEnviar, pedeHumano } = this.separarEncaminhamento(resposta);
      const partes = await this.enviarPartes(telefone, paraEnviar);

      // Encaminhou: pausa de verdade e chama a equipe.
      if (pedeHumano) {
        await this.atendimento.pausar(telefone, null);
        const avisou = await this.avisarEquipe({ telefone, nome, pergunta: texto });
        this.metricas.registrar({
          tipo: "pausada",
          telefone,
          motivo: avisou
            ? "bot encaminhou para uma pessoa (equipe avisada)"
            : "bot encaminhou para uma pessoa (sem número de aviso configurado)",
        });
        this.logger.log(`🙋 ${telefone}: encaminhado para atendimento humano`);
      }

      this.metricas.registrar({
        tipo: "respondida",
        telefone,
        nome,
        pergunta: paraHistorico,
        resposta,
        midiaTipo: midia?.tipo ?? null,
        transcricao,
        partes: partes.length,
        iaMs,
        envioMs: Date.now() - antesDoEnvio,
        totalMs: Date.now() - inicio,
        trechos: trechos.length,
        abertura: primeiraMensagem,
        custoUsd,
      });

      if (transcricao) this.logger.log(`🎤 ${telefone} disse: ${transcricao}`);
      this.logger.log(`🤖 ${telefone} (${iaMs}ms, ${partes.length}x): ${resposta}`);
      return { tratada: true, resposta, partes };
    } catch (erro) {
      this.logger.error("❌ Erro ao responder:", erro);
      this.metricas.registrar({
        tipo: "erro",
        telefone,
        pergunta: texto,
        erro: erro.message,
        totalMs: Date.now() - inicio,
      });
      // Silêncio é o pior resultado para quem está do outro lado: avisa que
      // deu errado, mas sem deixar uma falha no aviso derrubar o fluxo.
      await this.enviar({ telefone, texto: ERRO_AO_RESPONDER }).catch((e) =>
        this.logger.error("❌ Falha também no aviso de erro:", e),
      );
      return { tratada: false, motivo: "erro", erro };
    }
  }
}
