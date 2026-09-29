import pg from "pg";

// Tarefas da agenda em Postgres. Com arquivo, cada instância teria a sua
// versão da lista.
//
// (Duas instâncias ainda dispararão a mesma tarefa no mesmo horário: quem
// resolve isso é uma trava por execução, não o armazenamento. Fica para quando
// existir a segunda instância.)

export const SQL_TABELA = `
  CREATE TABLE IF NOT EXISTS tarefas (
    nome TEXT PRIMARY KEY,
    cron TEXT NOT NULL,
    ativa BOOLEAN NOT NULL DEFAULT false,
    telefones TEXT[] NOT NULL DEFAULT '{}',
    instrucao TEXT NOT NULL,
    fonte TEXT,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

export class PostgresAgenda {
  constructor({ url, pool = null }) {
    if (!url && !pool) throw new Error("PostgresAgenda precisa de DATABASE_URL");
    this.pool = pool ?? new pg.Pool({ connectionString: url, max: 5 });
  }

  get nome() {
    return "postgres";
  }

  async carregar() {
    const { rows } = await this.pool.query("SELECT * FROM tarefas ORDER BY nome");
    return rows.map((r) => ({
      nome: r.nome,
      cron: r.cron,
      ativa: r.ativa,
      telefones: r.telefones ?? [],
      instrucao: r.instrucao,
      ...(r.fonte ? { fonte: r.fonte } : {}),
    }));
  }

  // O painel manda a lista inteira, então salvar é substituir: tarefa que
  // sumiu da tela tem que sumir do banco. Em transação, para não existir um
  // instante com a agenda vazia.
  async salvar(tarefas) {
    const cliente = await this.pool.connect();
    try {
      await cliente.query("BEGIN");
      await cliente.query("DELETE FROM tarefas");
      for (const t of tarefas) {
        await cliente.query(
          `INSERT INTO tarefas (nome, cron, ativa, telefones, instrucao, fonte)
                VALUES ($1, $2, $3, $4, $5, $6)`,
          [t.nome, t.cron, Boolean(t.ativa), t.telefones ?? [], t.instrucao, t.fonte ?? null],
        );
      }
      await cliente.query("COMMIT");
      return tarefas;
    } catch (erro) {
      await cliente.query("ROLLBACK");
      throw erro;
    } finally {
      cliente.release();
    }
  }

  async migrar() {
    await this.pool.query(SQL_TABELA);
  }

  async fechar() {
    await this.pool.end();
  }
}
