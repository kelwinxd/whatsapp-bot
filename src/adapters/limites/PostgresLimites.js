import pg from "pg";
import { chaveDoDia } from "../../core/limites.js";

// Contadores de uso em Postgres, para o teto valer entre reinícios e entre
// instâncias. Em memória, reiniciar o bot zera o contador — e quem estivesse
// abusando ganharia cota nova a cada deploy.

export const SQL_TABELA = `
  CREATE TABLE IF NOT EXISTS limites (
    dia DATE NOT NULL,
    chave TEXT NOT NULL,
    contador INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (dia, chave)
  );
`;

export class PostgresLimites {
  constructor({ url, fusoHorario = "America/Sao_Paulo", pool = null }) {
    if (!url && !pool) throw new Error("PostgresLimites precisa de DATABASE_URL");
    this.fusoHorario = fusoHorario;
    this.pool = pool ?? new pg.Pool({ connectionString: url, max: 5 });
  }

  get nome() {
    return "postgres";
  }

  // O incremento é atômico no banco: duas mensagens chegando juntas não
  // sobrescrevem o contador uma da outra.
  async incrementar(nome) {
    const { rows } = await this.pool.query(
      `INSERT INTO limites (dia, chave, contador) VALUES ($1, $2, 1)
       ON CONFLICT (dia, chave) DO UPDATE SET contador = limites.contador + 1
       RETURNING contador`,
      [chaveDoDia(this.fusoHorario), nome],
    );
    return rows[0].contador;
  }

  async valor(nome) {
    const { rows } = await this.pool.query(
      "SELECT contador FROM limites WHERE dia = $1 AND chave = $2",
      [chaveDoDia(this.fusoHorario), nome],
    );
    return rows[0]?.contador ?? 0;
  }

  // Contadores de dias passados não servem para nada depois do relatório.
  async limparAntigos(diasParaManter = 30) {
    await this.pool.query(`DELETE FROM limites WHERE dia < current_date - $1::int`, [
      diasParaManter,
    ]);
  }

  async migrar() {
    await this.pool.query(SQL_TABELA);
  }

  async fechar() {
    await this.pool.end();
  }
}
