import { ProvedorIA } from "../../core/ports.js";
import { exigirVariaveis } from "../../config.js";

// Adaptador da OpenAI via API de Chat Completions. Usa o fetch nativo do Node
// 20 de propósito: uma dependência a menos, e a chamada é uma só.

export class OpenAIAdapter extends ProvedorIA {
  constructor({ apiKey, modelo, maxTokens }) {
    super();
    exigirVariaveis(["OPENAI_API_KEY"], { OPENAI_API_KEY: apiKey });
    this.apiKey = apiKey;
    this.modelo = modelo;
    this.maxTokens = maxTokens;
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
        messages: [{ role: "system", content: sistema }, ...mensagens],
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
}
