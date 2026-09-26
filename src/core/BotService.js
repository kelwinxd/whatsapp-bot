import { montarPromptDeSistema, SEPARADOR_DE_MENSAGENS } from "./prompt.js";
import { metricasNulas } from "./Metricas.js";

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
    prompt = { perfil: "suplementos" },
    metricas = metricasNulas,
    ritmo = {},
    logger = console,
    // Injetáveis para o teste não depender de sorteio nem esperar de verdade.
    aleatorio = Math.random,
    dormir = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    this.whatsapp = whatsapp;
    this.ia = ia;
    this.conversas = conversas;
    this.prompt = prompt;
    this.metricas = metricas;
    this.ritmo = { ...RITMO_PADRAO, ...ritmo };
    this.logger = logger;
    this.aleatorio = aleatorio;
    this.dormir = dormir;
  }

  // Envio avulso, pedido pelo painel: não passa pela IA nem pelo histórico.
  async enviarManual({ telefone, texto }) {
    const inicio = Date.now();
    try {
      await this.whatsapp.enviarTexto({ telefone, texto, digitandoMs: this.digitandoMs(texto) });
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
  deveIgnorar(mensagem) {
    if (mensagem.minha) return "mensagem enviada pelo próprio bot";
    if (mensagem.grupo) return "mensagem de grupo";
    return null;
  }

  async processarWebhook(corpo) {
    const mensagem = this.whatsapp.interpretarWebhook(corpo);
    if (!mensagem) return { tratada: false, motivo: "payload sem texto" };

    const ignorar = this.deveIgnorar(mensagem);
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
      const transcricao = ((await this.ia.transcrever({ base64, mimetype })) ?? "").trim();
      if (!transcricao) return { vazio: true };
      return {
        paraIA: transcricao,
        paraHistorico: `[áudio] ${transcricao}`,
        transcricao,
      };
    }

    const pergunta = texto || PERGUNTA_PADRAO_IMAGEM;

    return {
      paraIA: [
        { type: "text", text: pergunta },
        { type: "image_url", image_url: { url: `data:${mimetype};base64,${base64}` } },
      ],
      paraHistorico: `[imagem enviada] ${pergunta}`,
    };
  }

  async responder(mensagem) {
    const { telefone, nome, texto, midia } = mensagem;

    if (midia && !MIDIA_SUPORTADA.has(midia.tipo)) {
      const aviso = AVISO_POR_TIPO[midia.tipo] ?? "Ainda não consigo abrir esse tipo de arquivo 😅";
      await this.whatsapp
        .enviarTexto({ telefone, texto: aviso, digitandoMs: this.digitandoMs(aviso) })
        .catch((e) => this.logger.error("❌ Falha ao avisar sobre a mídia:", e));
      const motivo = `mídia não suportada: ${midia.tipo}`;
      this.metricas.registrar({ tipo: "ignorada", telefone, motivo });
      return { tratada: false, motivo };
    }

    const inicio = Date.now();

    try {
      const { paraIA, paraHistorico, transcricao, vazio } = await this.prepararConteudo(mensagem);

      // Áudio sem fala reconhecível: avisa em vez de mandar vazio para a IA.
      if (vazio) {
        await this.whatsapp.enviarTexto({
          telefone,
          texto: AUDIO_SEM_FALA,
          digitandoMs: this.digitandoMs(AUDIO_SEM_FALA),
        });
        this.metricas.registrar({ tipo: "ignorada", telefone, motivo: "áudio sem fala" });
        return { tratada: false, motivo: "áudio sem fala" };
      }

      const antesDaIA = Date.now();
      const resposta = await this.ia.responder({
        sistema: montarPromptDeSistema({ nome, ...this.prompt }),
        mensagens: [
          ...(await this.conversas.historico(telefone)),
          { role: "user", content: paraIA },
        ],
      });
      const iaMs = Date.now() - antesDaIA;

      // Só guarda depois de dar certo: falha na IA não deixa a pergunta órfã
      // no histórico.
      await this.conversas.acrescentar(telefone, { role: "user", content: paraHistorico });
      await this.conversas.acrescentar(telefone, { role: "assistant", content: resposta });

      const antesDoEnvio = Date.now();
      const partes = this.dividirResposta(resposta, this.prompt.maxMensagens ?? 1);
      // Sequencial de propósito: a Evolution só envia depois do "digitando...",
      // então esperar cada uma é o que cria o ritmo de conversa. Em paralelo,
      // as mensagens chegariam juntas e fora de ordem.
      for (const [indice, parte] of partes.entries()) {
        // Antes da primeira não cabe pausa: a espera da IA já fez esse papel.
        if (indice > 0) await this.dormir(this.ritmo.pausaMs);
        await this.whatsapp.enviarTexto({
          telefone,
          texto: parte,
          digitandoMs: this.digitandoMs(parte),
        });
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
      await this.whatsapp
        .enviarTexto({ telefone, texto: ERRO_AO_RESPONDER })
        .catch((e) => this.logger.error("❌ Falha também no aviso de erro:", e));
      return { tratada: false, motivo: "erro", erro };
    }
  }
}
