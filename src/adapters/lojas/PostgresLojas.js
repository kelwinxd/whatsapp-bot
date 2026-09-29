import pg from "pg";

// Lojas em Postgres. Etapa 3 da migração: é o que permite duas instâncias do
// bot sem uma sobrescrever o cadastro da outra — com arquivo, quem gravou por
// último apagava o trabalho do outro, sem erro nenhum aparecendo.
//
// As respostas ficam em JSONB: o formulário muda de campo com frequência, e
// uma coluna por pergunta viraria migração a cada pergunta nova. O que precisa
// ser consultado (slug) é coluna de verdade.

export const SQL_TABELA = `
  CREATE TABLE IF NOT EXISTS lojas (
    slug TEXT PRIMARY KEY,
    respostas JSONB NOT NULL,
    indexado_em TIMESTAMPTZ,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const paraRegistro = (linha) => ({
  slug: linha.slug,
  respostas: linha.respostas ?? {},
  indexadoEm: linha.indexado_em ? new Date(linha.indexado_em).toISOString() : null,
});

export class PostgresLojas {
  constructor({ url, pool = null }) {
    if (!url && !pool) throw new Error("PostgresLojas precisa de DATABASE_URL");
    this.pool = pool ?? new pg.Pool({ connectionString: url, max: 5 });
  }

  get nome() {
    return "postgres";
  }

  async listar() {
    const { rows } = await this.pool.query("SELECT * FROM lojas ORDER BY slug");
    return rows.map(paraRegistro);
  }

  async obter(slug) {
    const { rows } = await this.pool.query("SELECT * FROM lojas WHERE slug = $1", [slug]);
    return rows[0] ? paraRegistro(rows[0]) : null;
  }

  async salvar({ slug, respostas, indexadoEm }) {
    const { rows } = await this.pool.query(
      `INSERT INTO lojas (slug, respostas, indexado_em)
            VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE
               SET respostas = EXCLUDED.respostas,
                   indexado_em = EXCLUDED.indexado_em,
                   atualizado_em = now()
         RETURNING *`,
      [slug, JSON.stringify(respostas), indexadoEm],
    );
    return paraRegistro(rows[0]);
  }

  async remover(slug) {
    const { rowCount } = await this.pool.query("DELETE FROM lojas WHERE slug = $1", [slug]);
    return rowCount > 0;
  }

  async migrar() {
    await this.pool.query(SQL_TABELA);
  }

  async fechar() {
    await this.pool.end();
  }
}
