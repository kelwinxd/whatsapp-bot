import { ProvedorWhatsApp } from "../../core/ports.js";
import { exigirVariaveis } from "../../config.js";

// Adaptador da Evolution API (v2, self-hosted). Diferenças em relação à Z-API,
// todas contidas aqui: autenticação pelo header "apikey", instância no caminho
// da URL, "digitando..." em milissegundos (delay + presence) e o telefone que
// chega como JID ("5519999999999@s.whatsapp.net").

// Grupo no WhatsApp termina em @g.us; conversa normal, em @s.whatsapp.net.
const SUFIXO_GRUPO = "@g.us";

const soDigitos = (jid = "") => jid.split("@")[0].split(":")[0];

export class EvolutionAdapter extends ProvedorWhatsApp {
  constructor({ baseUrl, instancia, apiKey }) {
    super();
    exigirVariaveis(
      ["EVOLUTION_BASE_URL", "EVOLUTION_INSTANCE", "EVOLUTION_API_KEY"],
      {
        EVOLUTION_BASE_URL: baseUrl,
        EVOLUTION_INSTANCE: instancia,
        EVOLUTION_API_KEY: apiKey,
      },
    );
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.instancia = instancia;
    this.apiKey = apiKey;
  }

  get nome() {
    return "evolution";
  }

  interpretarWebhook(corpo) {
    // A Evolution manda vários eventos no mesmo endpoint; só mensagem nova
    // interessa. O nome vem em dois formatos conforme a versão.
    const evento = String(corpo?.event ?? "").toLowerCase().replace("_", ".");
    if (evento !== "messages.upsert") return null;

    // Em algumas versões data é um array de mensagens.
    const dado = Array.isArray(corpo.data) ? corpo.data[0] : corpo.data;
    const chave = dado?.key;
    if (!chave) return null;

    // conversation: mensagem simples. extendedTextMessage: quando tem citação,
    // link com preview ou menção.
    const texto =
      dado.message?.conversation ?? dado.message?.extendedTextMessage?.text;
    if (!texto) return null;

    const jid = chave.remoteJid ?? "";

    return {
      telefone: soDigitos(jid),
      nome: dado.pushName || "amigo",
      texto,
      minha: Boolean(chave.fromMe),
      grupo: jid.endsWith(SUFIXO_GRUPO),
      bruto: corpo,
    };
  }

  async enviarTexto({ telefone, texto, digitandoMs = 0 }) {
    const resposta = await fetch(
      `${this.baseUrl}/message/sendText/${this.instancia}`,
      {
        method: "POST",
        headers: { apikey: this.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          number: telefone,
          text: texto,
          delay: digitandoMs,
          presence: "composing",
          linkPreview: false,
        }),
      },
    );

    if (!resposta.ok) {
      throw new Error(`Evolution respondeu ${resposta.status}: ${await resposta.text()}`);
    }
    return resposta.json();
  }
}
