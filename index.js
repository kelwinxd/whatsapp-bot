import { config } from "./src/config.js";
import { montarDependencias } from "./src/core/registry.js";
import { BotService } from "./src/core/BotService.js";
import { Metricas } from "./src/core/Metricas.js";
import { Agenda } from "./src/core/Agenda.js";
import { criarServidor } from "./src/server.js";

// Ponto de entrada: escolhe as implementações, monta o serviço e sobe o HTTP.
// É o único lugar que conhece todas as peças ao mesmo tempo.

console.log("🔧 Iniciando...");

const dependencias = montarDependencias(config);
const metricas = new Metricas();
const bot = new BotService({ ...dependencias, prompt: config.prompt, metricas, ritmo: config.ritmo });
const agenda = new Agenda({
  tarefas: config.agenda.tarefas,
  fusoHorario: config.agenda.fusoHorario,
  bot,
  metricas,
});
const app = criarServidor({ bot, metricas, agenda, config });

const server = app.listen(config.porta, () => {
  console.log(`✅ Express rodando em http://localhost:${config.porta}`);
  console.log(`📮 Webhook em POST /webhook`);
  console.log(`📱 WhatsApp: ${dependencias.whatsapp.nome} | 🧠 IA: ${dependencias.ia.nome}`);
  console.log(`💬 Prompt: ${config.prompt.textoCustomizado ? "customizado" : config.prompt.perfil}`);
  console.log(`🖥️  Painel em http://localhost:${config.porta}/painel`);
  const quantas = agenda.iniciar();
  if (quantas > 0) console.log(`⏰ ${quantas} tarefa(s) na agenda`);
});

server.on("error", (err) => console.error("❌ Erro no servidor:", err));
process.on("uncaughtException", (err) => console.error("❌ uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("❌ unhandledRejection:", err));
