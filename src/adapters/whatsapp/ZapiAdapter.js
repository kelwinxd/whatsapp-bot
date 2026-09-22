import { ProvedorWhatsApp } from "../../core/ports.js";
import { exigirVariaveis } from "../../config.js";

// Adaptador da Z-API. Toda peculiaridade dela mora aqui: o token no header
// "Client-Token", a URL com id e token embutidos, e o "digitando..." em
// segundos (delayTyping, de 1 a 15).

export class ZapiAdapter extends ProvedorWhatsApp {
  constructor({ instanceId, instanceToken, clientToken }) {
    super();
    exigirVariaveis(
      ["ZAPI_INSTANCE_ID", "ZAPI_INSTANCE_TOKEN", "ZAPI_CLIENT_TOKEN"],
      {
        ZAPI_INSTANCE_ID: instanceId,
        ZAPI_INSTANCE_TOKEN: instanceToken,
        ZAPI_CLIENT_TOKEN: clientToken,
      },
    );
    this.baseUrl = `https://api.z-api.io/instances/${instanceId}/token/${instanceToken}`;
    this.clientToken = clientToken;
  }

  get nome() {
    return "z-api";
  }

  interpretarWebhook(corpo) {
    const texto = corpo?.text?.message;
    if (!texto) return null; // status, recibo de entrega, mídia...

    return {
      telefone: corpo.phone,
      nome: corpo.senderName || corpo.chatName || "amigo",
      texto,
      minha: Boolean(corpo.fromMe),
      grupo: Boolean(corpo.isGroup),
      bruto: corpo,
    };
  }

  async enviarTexto({ telefone, texto, digitandoMs = 0 }) {
    const resposta = await fetch(`${this.baseUrl}/send-text`, {
      method: "POST",
      headers: {
        "Client-Token": this.clientToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phone: telefone,
        message: texto,
        // A Z-API trabalha em segundos e aceita de 1 a 15.
        delayTyping: Math.min(15, Math.max(1, Math.round(digitandoMs / 1000))),
      }),
    });

    if (!resposta.ok) {
      throw new Error(`Z-API respondeu ${resposta.status}: ${await resposta.text()}`);
    }
    return resposta.json();
  }
}
