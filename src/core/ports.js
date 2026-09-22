// Contratos (portas) que o núcleo do bot conhece. As implementações concretas
// ficam em src/adapters e são escolhidas em tempo de execução pelo registry de
// cada porta. O núcleo nunca importa um adaptador direto — é isso que permite
// trocar Z-API por Evolution, ou OpenAI por outro modelo, sem tocar na regra
// de negócio.
//
// São classes-base em vez de só documentação porque, esquecendo de implementar
// um método, o erro aparece na hora da chamada com o nome da classe, em vez de
// um "não é uma função" solto.

/**
 * Mensagem recebida, já normalizada. Todo adaptador de WhatsApp traduz o
 * payload do seu provedor para este formato — é o "idioma" interno do bot.
 *
 * @typedef {object} MensagemRecebida
 * @property {string} telefone  Só dígitos, com DDI (ex.: 5519999999999)
 * @property {string} nome      Nome exibido pelo contato
 * @property {string} texto     Conteúdo da mensagem
 * @property {boolean} minha    true quando fui eu (o número do bot) que enviei
 * @property {boolean} grupo    true quando veio de um grupo
 * @property {object} bruto     Payload original, para log e depuração
 */

export class ProvedorWhatsApp {
  /** @returns {string} Nome curto, usado em log. */
  get nome() {
    return this.constructor.name;
  }

  /**
   * Traduz o corpo do webhook do provedor para MensagemRecebida.
   * Devolve null quando o payload não é uma mensagem de texto tratável
   * (evento de status, recibo de entrega, mídia, etc.).
   *
   * @param {object} corpo
   * @returns {MensagemRecebida | null}
   */
  interpretarWebhook(corpo) {
    throw new Error(`${this.nome} não implementou interpretarWebhook()`);
  }

  /**
   * Envia texto. O tempo de "digitando..." é informado em milissegundos e
   * cada adaptador converte para a unidade que a sua API usa.
   *
   * @param {{ telefone: string, texto: string, digitandoMs?: number }} params
   */
  async enviarTexto(params) {
    throw new Error(`${this.nome} não implementou enviarTexto()`);
  }
}

export class ProvedorIA {
  get nome() {
    return this.constructor.name;
  }

  /**
   * Gera a resposta a partir do prompt de sistema e do histórico da conversa.
   *
   * @param {{ sistema: string, mensagens: Array<{ role: 'user'|'assistant', content: string }> }} params
   * @returns {Promise<string>}
   */
  async responder(params) {
    throw new Error(`${this.nome} não implementou responder()`);
  }
}

export class RepositorioDeConversas {
  get nome() {
    return this.constructor.name;
  }

  /** @returns {Promise<Array<{ role: 'user'|'assistant', content: string }>>} */
  async historico(telefone) {
    throw new Error(`${this.nome} não implementou historico()`);
  }

  async acrescentar(telefone, mensagem) {
    throw new Error(`${this.nome} não implementou acrescentar()`);
  }

  async limpar(telefone) {
    throw new Error(`${this.nome} não implementou limpar()`);
  }
}
