import { ProvedorIA } from "../../core/ports.js";
import { exigirVariaveis } from "../../config.js";

// Adaptador da OpenAI via API de Chat Completions. Usa o fetch nativo do Node
// 20 de propósito: uma dependência a menos, e a chamada é uma só.

// O Whisper identifica o formato pela extensão do arquivo enviado, então o
// mimetype que o WhatsApp manda precisa virar um nome de arquivo plausível.
// Áudio de WhatsApp é quase sempre ogg/opus.
const EXTENSAO_POR_MIME = {
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

const extensaoDe = (mimetype = "") =>
  EXTENSAO_POR_MIME[mimetype.split(";")[0].trim()] ?? "ogg";

export class OpenAIAdapter extends ProvedorIA {
  constructor({ apiKey, modelo, maxTokens, modeloTranscricao }) {
    super();
    exigirVariaveis(["OPENAI_API_KEY"], { OPENAI_API_KEY: apiKey });
    this.apiKey = apiKey;
    this.modelo = modelo;
    this.maxTokens = maxTokens;
    this.modeloTranscricao = modeloTranscricao;
  }

  get nome() {
    return `openai:${this.modelo}`;
  }

  async responder({ sistema, mensagens }) {
    const resposta = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelo,
        max_tokens: this.maxTokens,
        // sistema nulo = perfil "puro": vai só a conversa, sem nenhuma
        // instrução nossa antes.
        messages: sistema ? [{ role: "system", content: sistema }, ...mensagens] : mensagens,
      }),
    });

    if (!resposta.ok) {
      throw new Error(`OpenAI respondeu ${resposta.status}: ${await resposta.text()}`);
    }

    const dados = await resposta.json();
    const texto = dados.choices?.[0]?.message?.content?.trim();
    if (!texto) throw new Error("OpenAI devolveu resposta vazia");
    return texto;
  }

  async transcrever({ base64, mimetype }) {
    // multipart/form-data: o FormData e o Blob são nativos no Node 20, e o
    // fetch monta o cabeçalho com o boundary sozinho — por isso aqui não
    // mandamos Content-Type na mão.
    const formulario = new FormData();
    formulario.append("model", this.modeloTranscricao);
    formulario.append("language", "pt");
    formulario.append(
      "file",
      new Blob([Buffer.from(base64, "base64")], { type: mimetype }),
      `audio.${extensaoDe(mimetype)}`,
    );

    const resposta = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: formulario,
    });

    if (!resposta.ok) {
      throw new Error(
        `OpenAI respondeu ${resposta.status} ao transcrever: ${await resposta.text()}`,
      );
    }

    const dados = await resposta.json();
    return (dados.text ?? "").trim();
  }
}
