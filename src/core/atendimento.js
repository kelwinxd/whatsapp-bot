// Controle de quem está atendendo cada conversa: o bot ou uma pessoa.
//
// A regra é simples de propósito: quando alguém responde pelo celular, o bot
// sai da frente daquela conversa por um tempo e volta sozinho depois. Sem
// comando, sem botão — o dono só responde, como já faria.
//
// Em memória, como o histórico: uma pausa esquecida por restart é bem menos
// grave que a complexidade de persistir. Quando o RedisRepo existir, a mesma
// interface serve para guardar lá.

const MINUTOS_PADRAO = 30;

export class ControleDeAtendimento {
  constructor({ minutosPadrao = MINUTOS_PADRAO, agora = () => Date.now() } = {}) {
    this.minutosPadrao = minutosPadrao;
    this.agora = agora;
    /** @type {Map<string, number|null>} telefone -> quando a pausa expira (null = sem prazo) */
    this.pausas = new Map();
  }

  /** @param {number|null} minutos  null pausa sem prazo, até alguém retomar. */
  pausar(telefone, minutos = this.minutosPadrao) {
    const expiraEm = minutos === null ? null : this.agora() + minutos * 60_000;
    this.pausas.set(telefone, expiraEm);
    return { telefone, expiraEm };
  }

  estaPausado(telefone) {
    if (!this.pausas.has(telefone)) return false;

    const expiraEm = this.pausas.get(telefone);
    if (expiraEm === null) return true;

    // Expirou: limpa na leitura, que evita precisar de rotina de varredura.
    if (this.agora() >= expiraEm) {
      this.pausas.delete(telefone);
      return false;
    }
    return true;
  }

  retomar(telefone) {
    return this.pausas.delete(telefone);
  }

  /** Conversas pausadas agora, para o painel. */
  listar() {
    return [...this.pausas.keys()]
      .filter((telefone) => this.estaPausado(telefone))
      .map((telefone) => ({
        telefone,
        expiraEm: this.pausas.get(telefone),
        minutosRestantes:
          this.pausas.get(telefone) === null
            ? null
            : Math.ceil((this.pausas.get(telefone) - this.agora()) / 60_000),
      }));
  }
}

// Ids das mensagens que o próprio bot enviou. Serve para distinguir, entre os
// eventos "fromMe", o que saiu daqui do que foi digitado no celular — sem isso
// o bot se pausaria sozinho a cada resposta que dá.
export class IdsEnviados {
  constructor({ validadeMs = 10 * 60_000, agora = () => Date.now() } = {}) {
    this.validadeMs = validadeMs;
    this.agora = agora;
    /** @type {Map<string, number>} */
    this.ids = new Map();
  }

  registrar(id) {
    if (!id) return;
    this.ids.set(id, this.agora());
    this.limpar();
  }

  contem(id) {
    if (!id) return false;
    const quando = this.ids.get(id);
    if (quando === undefined) return false;
    return this.agora() - quando <= this.validadeMs;
  }

  // Mensagem antiga não volta pelo webhook, então guardar id velho só ocuparia
  // memória.
  limpar() {
    const limite = this.agora() - this.validadeMs;
    for (const [id, quando] of this.ids) {
      if (quando < limite) this.ids.delete(id);
    }
  }
}
