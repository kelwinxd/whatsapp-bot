import pg from "pg";

// Preferências em Postgres: chave/valor, para o perfil ativo escolhido no
// painel valer para todas as instâncias — com arquivo, cada processo lê a sua
// cópia e duas instâncias discordariam sobre qual perfil está em uso.

export const SQL_TABELA = `
  CREATE TABLE IF NOT EXISTS preferencias (
    chave TEXT PRIMARY KEY,
    valor JSONB NOT NULL,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

export class PostgresPreferencias {
  constructor({ url, pool = null }) {
    if (!url && !pool) throw new Error("PostgresPreferencias precisa de DATABASE_URL");
    this.pool = pool ?? new pg.Pool({ connectionString: url, max: 5 });
  }

  get nome() {
    return "postgres";
  }

  async ler() {
    const { rows } = await this.pool.query("SELECT chave, valor FROM preferencias");
    return Object.fromEntries(rows.map((r) => [r.chave, r.valor]));
  }

  async gravar(preferencias) {
    // Grava chave a chave: assim uma preferência nova não apaga as outras.
    for (const [chave, valor] of Object.entries(preferencias)) {
      await this.pool.query(
        `INSERT INTO preferencias (chave, valor) VALUES ($1, $2)
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
        [chave, JSON.stringify(valor)],
      );
    }
    return preferencias;
  }

  async migrar() {
    await this.pool.query(SQL_TABELA);
  }

  async fechar() {
    await this.pool.end();
  }
}
