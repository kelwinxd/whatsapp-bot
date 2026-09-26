import { config } from "./src/config.js";
import { montarDependencias } from "./src/core/registry.js";
import { BotService } from "./src/core/BotService.js";
import { Metricas } from "./src/core/Metricas.js";
import { Agenda } from "./src/core/Agenda.js";
import { criarServidor } from "./src/server.js";
import { resumoParaPrompt } from "./src/core/formularioLoja.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Ponto de entrada: escolhe as implementações, monta o serviço e sobe o HTTP.
// É o único lugar que conhece todas as peças ao mesmo tempo.

console.log("🔧 Iniciando...");

const dependencias = montarDependencias(config);
const metricas = new Metricas();
const loja = config.loja.dados
  ? { ...config.loja.dados, resumo: resumoParaPrompt(config.loja.dados.respostas) }
  : null;

const bot = new BotService({
  ...dependencias,
  prompt: config.prompt,
  metricas,
  ritmo: config.ritmo,
  imagem: config.imagem,
  base: dependencias.base,
  loja,
});

// Gravação das respostas da loja: o servidor recebe isto por injeção para não
// conhecer disco nem caminho de arquivo.
async function salvarLoja(dados) {
  await mkdir(dirname(config.loja.arquivo), { recursive: true });
  await writeFile(config.loja.arquivo, `${JSON.stringify(dados, null, 2)}\n`, "utf8");
}
const agenda = new Agenda({
  tarefas: config.agenda.tarefas,
  fusoHorario: config.agenda.fusoHorario,
  bot,
  metricas,
});
const app = criarServidor({ bot, metricas, agenda, base: dependencias.base, salvarLoja, config });

const server = app.listen(config.porta, () => {
  // O Node chama este callback mesmo quando a porta está ocupada (com
  // server.listening em false, e o evento "error" chegando depois). Sem esta
  // guarda, o processo que vai falhar imprime o banner de sucesso e agenda as
  // tarefas antes de morrer.
  if (!server.listening) return;

  console.log(`✅ Express rodando em http://localhost:${config.porta}`);
  console.log(`📮 Webhook em POST /webhook`);
  console.log(`📱 WhatsApp: ${dependencias.whatsapp.nome} | 🧠 IA: ${dependencias.ia.nome}`);
  console.log(`💬 Prompt: ${config.prompt.textoCustomizado ? "customizado" : config.prompt.perfil}`);
  console.log(`🖼️  Detalhe de imagem: ${config.imagem.detalhe}`);
  console.log(`📚 Base de conhecimento: ${dependencias.base.nome}`);
  if (loja?.respostas?.nome) console.log(`🏪 Loja: ${loja.respostas.nome}`);
  console.log(`🖥️  Painel em http://localhost:${config.porta}/painel`);
  const quantas = agenda.iniciar();
  if (quantas > 0) console.log(`⏰ ${quantas} tarefa(s) na agenda`);
});

server.on("error", (err) => {
  // Porta ocupada é o erro mais comum aqui, e o stack trace do Node não diz o
  // que fazer. Encerrar também importa: sem isso o processo continua vivo sem
  // servidor, e a agenda dele dispararia as mesmas tarefas de novo — a pessoa
  // receberia a mensagem duplicada.
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ A porta ${config.porta} já está em uso — outro bot está rodando.\n`);
    console.error("   Para ver quem está usando e encerrar:");
    console.error(`     netstat -ano | findstr :${config.porta}`);
    console.error("     taskkill /F /PID <o último número da linha>\n");
    console.error(`   Ou suba numa porta livre:  PORT=3001 npm run dev\n`);
    process.exit(1);
  }

  console.error("❌ Erro no servidor:", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => console.error("❌ uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("❌ unhandledRejection:", err));
