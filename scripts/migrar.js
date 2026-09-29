import { config } from "../src/config.js";
import { PostgresRepo } from "../src/adapters/conversas/PostgresRepo.js";
import { PostgresAtendimento } from "../src/adapters/atendimento/PostgresAtendimento.js";
import { PostgresLojas } from "../src/adapters/lojas/PostgresLojas.js";
import { PostgresAgenda } from "../src/adapters/agenda/PostgresAgenda.js";
import { PostgresPreferencias } from "../src/adapters/preferencias/PostgresPreferencias.js";
import { ArquivoLojas } from "../src/adapters/lojas/ArquivoLojas.js";
import { ArquivoAgenda } from "../src/adapters/agenda/ArquivoAgenda.js";
import { ArquivoPreferencias } from "../src/adapters/preferencias/ArquivoPreferencias.js";

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

const pausas = new PostgresAtendimento({ url: config.banco.url });
await pausas.migrar();
await pausas.fechar();

const lojas = new PostgresLojas({ url: config.banco.url });
const agenda = new PostgresAgenda({ url: config.banco.url });
const preferencias = new PostgresPreferencias({ url: config.banco.url });
for (const tabela of [lojas, agenda, preferencias]) await tabela.migrar();

// Importa o que já existe em arquivo, quando a tabela está vazia. Evita que
// migrar signifique recadastrar tudo na mão — e rodar de novo não duplica,
// porque só importa em tabela vazia.
async function importar(rotulo, doArquivo, paraBanco) {
  const existentes = await paraBanco();
  if (existentes.length > 0) {
    console.log(`↷ ${rotulo}: ${existentes.length} já no banco, nada a importar`);
    return;
  }
  const registros = await doArquivo();
  if (registros.length === 0) return;
  console.log(`⬆️  ${rotulo}: importando ${registros.length} de arquivo`);
  return registros;
}

const lojasDeArquivo = await importar(
  "lojas",
  () => new ArquivoLojas({ pasta: config.lojas.pasta }).listar(),
  () => lojas.listar(),
);
for (const registro of lojasDeArquivo ?? []) await lojas.salvar(registro);

const tarefasDeArquivo = await importar(
  "agenda",
  () => new ArquivoAgenda({ arquivo: config.agenda.arquivo }).carregar(),
  () => agenda.carregar(),
);
if (tarefasDeArquivo?.length) await agenda.salvar(tarefasDeArquivo);

const doArquivo = await new ArquivoPreferencias({ arquivo: config.preferenciasArquivo }).ler();
if (Object.keys(await preferencias.ler()).length === 0 && Object.keys(doArquivo).length > 0) {
  console.log(`⬆️  preferências: importando de arquivo`);
  await preferencias.gravar(doArquivo);
}

for (const tabela of [lojas, agenda, preferencias]) await tabela.fechar();
console.log("✅ Tabelas criadas/atualizadas em", config.banco.url.replace(/:[^:@]+@/, ":***@"));
await repo.fechar();
