import { RepositorioDeConversas } from "../../core/ports.js";

// Histórico guardado em memória: some quando o servidor reinicia e não é
// compartilhado entre instâncias do processo. Serve bem para um bot só.
// Quando precisar sobreviver a restart, entra um RedisRepo ou PostgresRepo
// implementando esta mesma porta — nada mais no projeto muda.

export class MemoriaRepo extends RepositorioDeConversas {
  constructor({ maxHistorico }) {
    super();
    this.maxHistorico = maxHistorico;
    /** @type {Map<string, Array<{ role: string, content: string }>>} */
    this.conversas = new Map();
  }

  get nome() {
    return "memoria";
  }

  async historico(telefone) {
    return this.conversas.get(telefone) ?? [];
  }

  async acrescentar(telefone, mensagem) {
    const atual = this.conversas.get(telefone) ?? [];
    atual.push(mensagem);
    // Corta as mais antigas: o custo da chamada cresce com o histórico, e o
    // começo de uma conversa longa raramente importa para a próxima resposta.
    this.conversas.set(telefone, atual.slice(-this.maxHistorico));
  }

  async limpar(telefone) {
    this.conversas.delete(telefone);
  }
}
