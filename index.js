import { config } from "./src/config.js";
import { montarDependencias } from "./src/core/registry.js";
import { BotService } from "./src/core/BotService.js";
import { Metricas } from "./src/core/Metricas.js";
import { criarServidor } from "./src/server.js";

// Ponto de entrada: escolhe as implementações, monta o serviço e sobe o HTTP.
// É o único lugar que conhece todas as peças ao mesmo tempo.

console.log("🔧 Iniciando...");

const dependencias = montarDependencias(config);
const metricas = new Metricas();
const bot = new BotService({ ...dependencias, prompt: config.prompt, metricas });
const app = criarServidor({ bot, metricas, config });

const server = app.listen(config.porta, () => {
  console.log(`✅ Express rodando em http://localhost:${config.porta}`);
  console.log(`📮 Webhook em POST /webhook`);
  console.log(`📱 WhatsApp: ${dependencias.whatsapp.nome} | 🧠 IA: ${dependencias.ia.nome}`);
  console.log(`💬 Prompt: ${config.prompt.textoCustomizado ? "customizado" : config.prompt.perfil}`);
  console.log(`🖥️  Painel em http://localhost:${config.porta}/painel`);
});

server.on("error", (err) => console.error("❌ Erro no servidor:", err));
process.on("uncaughtException", (err) => console.error("❌ uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("❌ unhandledRejection:", err));
