// Teto de mensagens por dia, por contato e no total.
//
// Existe por dois motivos concretos: crédito da OpenAI (um laço, ou alguém
// mal-intencionado, queima a conta em minutos) e risco de banimento do número
// (volume anormal é o que a Meta caça).
//
// A janela é o dia no fuso configurado, não 24h móveis: "quantas hoje" é o que
// a pessoa entende, e o contador reinicia à meia-noite.

export const chaveDoDia = (fusoHorario = "America/Sao_Paulo", agora = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: fusoHorario,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora); // AAAA-MM-DD

export class MemoriaLimites {
  constructor({ fusoHorario = "America/Sao_Paulo" } = {}) {
    this.fusoHorario = fusoHorario;
    /** @type {Map<string, number>} "dia:chave" -> contador */
    this.contadores = new Map();
  }

  get nome() {
    return "memoria";
  }

  chave(nome) {
    return `${chaveDoDia(this.fusoHorario)}:${nome}`;
  }

  async incrementar(nome) {
    const chave = this.chave(nome);
    const valor = (this.contadores.get(chave) ?? 0) + 1;
    this.contadores.set(chave, valor);

    // Limpa os dias anteriores: sem isso o mapa cresce para sempre.
    const hoje = chaveDoDia(this.fusoHorario);
    for (const existente of this.contadores.keys()) {
      if (!existente.startsWith(hoje)) this.contadores.delete(existente);
    }

    return valor;
  }

  async valor(nome) {
    return this.contadores.get(this.chave(nome)) ?? 0;
  }
}

/**
 * Decide se a mensagem passa. Devolve também se é a primeira vez que o limite
 * estourou, porque só aí vale avisar a pessoa — repetir o aviso a cada
 * mensagem seria justamente o comportamento que o limite quer evitar.
 */
export async function verificarLimites({ limites, telefone, porContato, global }) {
  const doContato = await limites.incrementar(`contato:${telefone}`);
  const doDia = await limites.incrementar("global");

  if (global && doDia > global) {
    return { permitido: false, motivo: "limite global do dia", avisar: false, doContato, doDia };
  }
  if (porContato && doContato > porContato) {
    return {
      permitido: false,
      motivo: "limite do contato no dia",
      // Avisa só na primeira mensagem depois de estourar.
      avisar: doContato === porContato + 1,
      doContato,
      doDia,
    };
  }

  return { permitido: true, doContato, doDia };
}
