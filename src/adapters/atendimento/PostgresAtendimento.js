import pg from "pg";

// Pausas do atendimento humano em Postgres.
//
// Em memória, um deploy no meio de um atendimento devolvia a conversa ao bot:
// a pessoa está resolvendo uma reclamação e o robô volta a responder por cima.
// É o segundo bug de verdade da lista em docs/PERSISTENCIA.md.
//
// Uma linha por conversa pausada, com o prazo. Pausa sem prazo (o "#pausar" do
// dono) guarda NULL em expira_em.

export const SQL_TABELA = `
  CREATE TABLE IF NOT EXISTS pausas (
    telefone TEXT PRIMARY KEY,
    expira_em TIMESTAMPTZ,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const MINUTOS_PADRAO = 30;

export class PostgresAtendimento {
  constructor({ url, minutosPadrao = MINUTOS_PADRAO, pool = null }) {
    if (!url && !pool) throw new Error("PostgresAtendimento precisa de DATABASE_URL");
    this.minutosPadrao = minutosPadrao;
    this.pool = pool ?? new pg.Pool({ connectionString: url, max: 5 });
  }

  get nome() {
    return "postgres";
  }

  async pausar(telefone, minutos = this.minutosPadrao) {
    // O prazo é calculado no banco: se o processo e o Postgres estiverem com
    // relógios diferentes, quem manda é um só.
    const { rows } = await this.pool.query(
      `INSERT INTO pausas (telefone, expira_em)
            VALUES ($1, CASE WHEN $2::int IS NULL THEN NULL ELSE now() + ($2 * INTERVAL '1 minute') END)
       ON CONFLICT (telefone) DO UPDATE SET expira_em = EXCLUDED.expira_em, criado_em = now()
         RETURNING expira_em`,
      [telefone, minutos],
    );
    return { telefone, expiraEm: rows[0]?.expira_em ?? null };
  }

  async estaPausado(telefone) {
    const { rows } = await this.pool.query(
      "SELECT expira_em FROM pausas WHERE telefone = $1 AND (expira_em IS NULL OR expira_em > now())",
      [telefone],
    );
    return rows.length > 0;
  }

  async retomar(telefone) {
    const { rowCount } = await this.pool.query("DELETE FROM pausas WHERE telefone = $1", [telefone]);
    return rowCount > 0;
  }

  async listar() {
    // Limpa as expiradas na leitura, como a versão em memória fazia — evita
    // precisar de rotina de varredura.
    await this.pool.query("DELETE FROM pausas WHERE expira_em IS NOT NULL AND expira_em <= now()");

    const { rows } = await this.pool.query(
      `SELECT telefone, expira_em,
              CEIL(EXTRACT(EPOCH FROM (expira_em - now())) / 60) AS minutos
         FROM pausas ORDER BY criado_em DESC`,
    );

    return rows.map((r) => ({
      telefone: r.telefone,
      expiraEm: r.expira_em ? new Date(r.expira_em).getTime() : null,
      minutosRestantes: r.minutos === null ? null : Number(r.minutos),
    }));
  }

  async migrar() {
    await this.pool.query(SQL_TABELA);
  }

  async fechar() {
    await this.pool.end();
  }
}
