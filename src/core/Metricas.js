// Registro de eventos e números do bot, em memória. Some no restart, igual ao
// histórico das conversas — serve para acompanhar o que está acontecendo
// agora, não para relatório histórico. Quando isso fizer falta, o caminho é o
// mesmo das outras portas: uma implementação que grave em banco.

const percentil = (valores, p) => {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  // Índice pelo método do "nearest rank": simples e suficiente aqui.
  const indice = Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1);
  return ordenados[Math.max(0, indice)];
};

const media = (valores) =>
  valores.length === 0 ? null : Math.round(valores.reduce((a, b) => a + b, 0) / valores.length);

export class Metricas {
  constructor({ maxEventos = 50 } = {}) {
    this.maxEventos = maxEventos;
    /** @type {Array<object>} mais recente primeiro */
    this.eventos = [];
    this.iniciadoEm = Date.now();
  }

  registrar(evento) {
    this.eventos.unshift({ ...evento, em: new Date().toISOString() });
    if (this.eventos.length > this.maxEventos) this.eventos.length = this.maxEventos;
  }

  resumo() {
    const respondidas = this.eventos.filter((e) => e.tipo === "respondida");
    const temposIA = respondidas.map((e) => e.iaMs).filter((n) => typeof n === "number");
    const temposTotais = respondidas.map((e) => e.totalMs).filter((n) => typeof n === "number");

    return {
      desde: new Date(this.iniciadoEm).toISOString(),
      respondidas: respondidas.length,
      ignoradas: this.eventos.filter((e) => e.tipo === "ignorada").length,
      erros: this.eventos.filter((e) => e.tipo === "erro").length,
      enviadasManualmente: this.eventos.filter((e) => e.tipo === "envio-manual").length,
      iaMedioMs: media(temposIA),
      iaP95Ms: percentil(temposIA, 95),
      totalMedioMs: media(temposTotais),
    };
  }
}

// Usado quando ninguém injeta métricas (nos testes, por exemplo): aceita tudo
// e não guarda nada, para o BotService não precisar de if em volta da chamada.
export const metricasNulas = { registrar() {}, resumo: () => ({}), eventos: [] };
