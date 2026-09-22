import { montarPromptDeSistema } from "./prompt.js";

// Regra do bot, sem saber quem entrega a mensagem nem quem gera o texto:
// recebe as três portas prontas pelo construtor (injeção de dependência).
// É o que torna o fluxo testável sem rede — basta passar dublês.

const MS_POR_CARACTERE = 100; // ~1 s a cada 10 caracteres
const DIGITANDO_MAXIMO_MS = 15_000; // teto da Z-API; a Evolution aceita mais

const ERRO_AO_RESPONDER =
  "Tive um probleminha para responder agora 😕 Tenta de novo em instantes.";

export class BotService {
  constructor({ whatsapp, ia, conversas, logger = console }) {
    this.whatsapp = whatsapp;
    this.ia = ia;
    this.conversas = conversas;
    this.logger = logger;
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
    if (ignorar) return { tratada: false, motivo: ignorar };

    return this.responder(mensagem);
  }

  async responder(mensagem) {
    const { telefone, nome, texto } = mensagem;

    try {
      await this.conversas.acrescentar(telefone, { role: "user", content: texto });

      const resposta = await this.ia.responder({
        sistema: montarPromptDeSistema({ nome }),
        mensagens: await this.conversas.historico(telefone),
      });

      await this.conversas.acrescentar(telefone, { role: "assistant", content: resposta });

      await this.whatsapp.enviarTexto({
        telefone,
        texto: resposta,
        digitandoMs: this.digitandoMs(resposta),
      });

      this.logger.log(`🤖 ${telefone}: ${resposta}`);
      return { tratada: true, resposta };
    } catch (erro) {
      this.logger.error("❌ Erro ao responder:", erro);
      // Silêncio é o pior resultado para quem está do outro lado: avisa que
      // deu errado, mas sem deixar uma falha no aviso derrubar o fluxo.
      await this.whatsapp
        .enviarTexto({ telefone, texto: ERRO_AO_RESPONDER })
        .catch((e) => this.logger.error("❌ Falha também no aviso de erro:", e));
      return { tratada: false, motivo: "erro", erro };
    }
  }
}
