import { montarPromptDeSistema } from "./prompt.js";
import { metricasNulas } from "./Metricas.js";

// Regra do bot, sem saber quem entrega a mensagem nem quem gera o texto:
// recebe as três portas prontas pelo construtor (injeção de dependência).
// É o que torna o fluxo testável sem rede — basta passar dublês.

const MS_POR_CARACTERE = 100; // ~1 s a cada 10 caracteres
const DIGITANDO_MAXIMO_MS = 15_000; // teto da Z-API; a Evolution aceita mais

const ERRO_AO_RESPONDER =
  "Tive um probleminha para responder agora 😕 Tenta de novo em instantes.";

// Só imagem por enquanto: é visão nativa do modelo. Áudio pediria transcrição
// (Whisper) e documento, extração de texto — cada um é outro caminho.
const MIDIA_SUPORTADA = new Set(["imagem"]);

const AVISO_POR_TIPO = {
  audio: "Ainda não consigo ouvir áudio 😅 Pode escrever?",
  video: "Ainda não consigo ver vídeo 😅 Manda uma foto ou escreve?",
  documento: "Ainda não consigo ler documento 😅 Pode escrever o que precisa?",
};

const PERGUNTA_PADRAO_IMAGEM = "O que tem nesta imagem?";

export class BotService {
  constructor({
    whatsapp,
    ia,
    conversas,
    prompt = { perfil: "suplementos" },
    metricas = metricasNulas,
    logger = console,
  }) {
    this.whatsapp = whatsapp;
    this.ia = ia;
    this.conversas = conversas;
    this.prompt = prompt;
    this.metricas = metricas;
    this.logger = logger;
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

  // Tempo de "digitando..." proporcional ao tamanho do texto, em ms. Cada
  // adaptador converte para a unidade da sua API.
  digitandoMs(texto) {
    return Math.min(DIGITANDO_MAXIMO_MS, Math.max(1000, texto.length * MS_POR_CARACTERE));
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
      const { paraIA, paraHistorico } = await this.prepararConteudo(mensagem);

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
      await this.whatsapp.enviarTexto({
        telefone,
        texto: resposta,
        digitandoMs: this.digitandoMs(resposta),
      });

      this.metricas.registrar({
        tipo: "respondida",
        telefone,
        nome,
        pergunta: paraHistorico,
        resposta,
        temImagem: Boolean(midia),
        iaMs,
        envioMs: Date.now() - antesDoEnvio,
        totalMs: Date.now() - inicio,
      });

      this.logger.log(`🤖 ${telefone} (${iaMs}ms): ${resposta}`);
      return { tratada: true, resposta };
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
