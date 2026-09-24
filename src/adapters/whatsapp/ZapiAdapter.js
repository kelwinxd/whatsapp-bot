import { ProvedorWhatsApp } from "../../core/ports.js";
import { exigirVariaveis } from "../../config.js";

// Adaptador da Z-API. Toda peculiaridade dela mora aqui: o token no header
// "Client-Token", a URL com id e token embutidos, e o "digitando..." em
// segundos (delayTyping, de 1 a 15).

// Cada anexo vem numa propriedade própria do corpo, com a URL num campo de
// nome diferente.
const TIPOS_DE_MIDIA = [
  { campo: "image", tipo: "imagem", url: "imageUrl" },
  { campo: "audio", tipo: "audio", url: "audioUrl" },
  { campo: "video", tipo: "video", url: "videoUrl" },
  { campo: "document", tipo: "documento", url: "documentUrl" },
];

function descreverMidia(corpo) {
  for (const { campo, tipo, url } of TIPOS_DE_MIDIA) {
    const anexo = corpo?.[campo];
    if (!anexo) continue;
    return {
      tipo,
      mimetype: anexo.mimeType ?? "application/octet-stream",
      legenda: anexo.caption,
      referencia: { url: anexo[url] },
    };
  }
  return null;
}

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
    const midia = descreverMidia(corpo);
    const texto = corpo?.text?.message ?? midia?.legenda ?? "";

    // Sem texto e sem anexo não há o que responder (status, recibo, etc.).
    if (!texto && !midia) return null;

    return {
      telefone: corpo.phone,
      nome: corpo.senderName || corpo.chatName || "amigo",
      texto,
      minha: Boolean(corpo.fromMe),
      grupo: Boolean(corpo.isGroup),
      midia: midia && { tipo: midia.tipo, mimetype: midia.mimetype, referencia: midia.referencia },
      bruto: corpo,
    };
  }

  // A Z-API entrega a mídia como URL pública, então aqui é só baixar e
  // converter — diferente da Evolution, que exige uma chamada à API dela.
  async obterMidiaBase64(midia) {
    const resposta = await fetch(midia.referencia.url);
    if (!resposta.ok) {
      throw new Error(`Falha ao baixar mídia da Z-API: ${resposta.status}`);
    }
    const bytes = Buffer.from(await resposta.arrayBuffer());
    return {
      base64: bytes.toString("base64"),
      mimetype: resposta.headers.get("content-type") ?? midia.mimetype,
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
