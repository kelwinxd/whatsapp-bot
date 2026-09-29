import { config } from "../src/config.js";
import { montarDependencias } from "../src/core/registry.js";
import { ArquivoLojas } from "../src/adapters/lojas/ArquivoLojas.js";
import { ArquivoAgenda } from "../src/adapters/agenda/ArquivoAgenda.js";
import { ArquivoPreferencias } from "../src/adapters/preferencias/ArquivoPreferencias.js";

// Prepara o armazenamento escolhido no .env:  npm run migrar
//
// O script não sabe que banco é: pede os adaptadores ao registry e chama
// migrar() em quem tiver. Trocar Postgres por MySQL um dia é escrever os
// adaptadores e mudar a configuração — este arquivo continua igual.
//
// Para Postgres, o database precisa existir antes:
//   docker exec evolution_postgres psql -U evolution -d postgres -c "CREATE DATABASE wpbot"

const dependencias = montarDependencias(config);

const armazenamentos = [
  ["histórico", dependencias.conversas],
  ["pausas", dependencias.atendimento],
  ["lojas", dependencias.lojas],
  ["agenda", dependencias.agenda],
  ["preferências", dependencias.preferencias],
];

for (const [rotulo, adaptador] of armazenamentos) {
  // Adaptador de arquivo não tem o que migrar — e isso não é erro.
  if (typeof adaptador.migrar !== "function") {
    console.log(`↷ ${rotulo}: ${adaptador.nome}, nada a preparar`);
    continue;
  }
  await adaptador.migrar();
  console.log(`✅ ${rotulo}: ${adaptador.nome} pronto`);
}

// --- Importação do que já existe em arquivo ---------------------------------
// Só acontece quando o destino está vazio: migrar não pode significar
// recadastrar na mão, e rodar de novo não pode duplicar.

async function importar(rotulo, destino, lerDoArquivo, gravar) {
  if (destino.nome === "arquivo") return;

  const jaExistem = await destino.carregar?.().catch(() => []) ?? (await destino.listar?.() ?? []);
  if (jaExistem.length > 0) {
    console.log(`↷ ${rotulo}: ${jaExistem.length} já no destino, nada a importar`);
    return;
  }

  const registros = await lerDoArquivo();
  if (registros.length === 0) return;

  await gravar(registros);
  console.log(`⬆️  ${rotulo}: ${registros.length} importado(s) de arquivo`);
}

await importar(
  "lojas",
  dependencias.lojas,
  () => new ArquivoLojas({ pasta: config.lojas.pasta }).listar(),
  async (registros) => {
    for (const registro of registros) await dependencias.lojas.salvar(registro);
  },
);

await importar(
  "agenda",
  dependencias.agenda,
  () => new ArquivoAgenda({ arquivo: config.agenda.arquivo }).carregar(),
  (tarefas) => dependencias.agenda.salvar(tarefas),
);

if (dependencias.preferencias.nome !== "arquivo") {
  const noDestino = await dependencias.preferencias.ler();
  const doArquivo = await new ArquivoPreferencias({ arquivo: config.preferenciasArquivo }).ler();
  if (Object.keys(noDestino).length === 0 && Object.keys(doArquivo).length > 0) {
    await dependencias.preferencias.gravar(doArquivo);
    console.log("⬆️  preferências: importadas de arquivo");
  }
}

// Fecha as conexões que os adaptadores tenham aberto, para o script encerrar.
for (const [, adaptador] of armazenamentos) await adaptador.fechar?.();
console.log("\n✅ Armazenamento pronto.");
