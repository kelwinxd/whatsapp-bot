import pg from "pg";
import { RepositorioDeConversas } from "../../core/ports.js";

// Histórico das conversas em Postgres. Substitui o MemoriaRepo quando o bot
// precisa lembrar entre reinícios — e ele reinicia mais do que parece: cada
// salvar de arquivo em desenvolvimento, cada deploy em produção.
//
// O sintoma de não ter isto é traiçoeiro: o bot trata toda mensagem como a
// primeira da conversa, e fica se apresentando de novo a cada resposta.
//
// Guarda tudo e lê só as últimas: o corte é de quanto vai para o modelo, não
// de quanto fica registrado. Conversa antiga serve para auditoria e relatório,
// e apagar é decisão de política de retenção, não de tamanho de prompt.

export const SQL_TABELA = `
  CREATE TABLE IF NOT EXISTS conversas (
    id BIGSERIAL PRIMARY KEY,
    telefone TEXT NOT NULL,
    papel TEXT NOT NULL,
    conteudo TEXT NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS conversas_telefone_id ON conversas (telefone, id DESC);
`;

export class PostgresRepo extends RepositorioDeConversas {
  constructor({ url, maxHistorico = 10, pool = null }) {
    super();
    if (!url && !pool) throw new Error("PostgresRepo precisa de DATABASE_URL");
    this.maxHistorico = maxHistorico;
    this.pool = pool ?? new pg.Pool({ connectionString: url, max: 5 });
  }

  get nome() {
    return "postgres";
  }

  async historico(telefone) {
    // Busca as N mais recentes e devolve na ordem cronológica: o modelo lê a
    // conversa de cima para baixo.
    const { rows } = await this.pool.query(
      `SELECT papel, conteudo
         FROM (
           SELECT papel, conteudo, id FROM conversas
            WHERE telefone = $1 ORDER BY id DESC LIMIT $2
         ) recentes
        ORDER BY id ASC`,
      [telefone, this.maxHistorico],
    );
    return rows.map((r) => ({ role: r.papel, content: r.conteudo }));
  }

  async acrescentar(telefone, mensagem) {
    await this.pool.query(
      "INSERT INTO conversas (telefone, papel, conteudo) VALUES ($1, $2, $3)",
      [telefone, mensagem.role, mensagem.content],
    );
  }

  async limpar(telefone) {
    await this.pool.query("DELETE FROM conversas WHERE telefone = $1", [telefone]);
  }

  /** Cria a tabela; chamado pelo script de migração. */
  async migrar() {
    await this.pool.query(SQL_TABELA);
  }

  async fechar() {
    await this.pool.end();
  }
}
