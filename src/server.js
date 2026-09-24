import express from "express";
import { perfisDisponiveis } from "./core/prompt.js";

// Camada HTTP: só traduz requisição em chamada de serviço. Recebe o BotService
// pronto, então dá para subir o servidor com um serviço falso em teste.

export function criarServidor({ bot, logger = console }) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/", (_req, res) => res.send("Bot vivo 🚀"));

  // Saúde: útil para monitoramento e para conferir, sem abrir o .env, o que
  // está valendo agora — inclusive quais perfis de prompt existem.
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      whatsapp: bot.whatsapp.nome,
      ia: bot.ia.nome,
      prompt: bot.prompt.textoCustomizado ? "customizado" : bot.prompt.perfil,
      perfisDisponiveis,
    }),
  );

  app.post("/webhook", (req, res) => {
    // Responde antes de processar: o provedor só quer saber se o webhook
    // chegou, e a resposta da IA demora mais que o timeout dele.
    res.sendStatus(200);

    logger.log("\n📩 Webhook recebido:");
    logger.log(JSON.stringify(req.body, null, 2));

    bot
      .processarWebhook(req.body)
      .then((r) => {
        if (!r.tratada) logger.log(`↩️  Ignorada: ${r.motivo}`);
      })
      .catch((erro) => logger.error("❌ Erro no webhook:", erro));
  });

  return app;
}
