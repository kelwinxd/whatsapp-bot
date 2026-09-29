import { config } from "../src/config.js";
import { PostgresRepo } from "../src/adapters/conversas/PostgresRepo.js";

// Cria as tabelas do bot:  npm run migrar
//
// O database precisa existir antes. Reaproveitando o Postgres da Evolution:
//   docker exec evolution_postgres psql -U evolution -c "CREATE DATABASE wpbot"

if (!config.banco.url) {
  console.error("❌ Configure DATABASE_URL no .env antes de migrar.");
  process.exit(1);
}

const repo = new PostgresRepo({ url: config.banco.url });
await repo.migrar();
console.log("✅ Tabelas criadas/atualizadas em", config.banco.url.replace(/:[^:@]+@/, ":***@"));
await repo.fechar();
