import express from "express";

// Camada HTTP: só traduz requisição em chamada de serviço. Recebe o BotService
// pronto, então dá para subir o servidor com um serviço falso em teste.

export function criarServidor({ bot, logger = console }) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/", (_req, res) => res.send("Bot vivo 🚀"));

  // Saúde: útil para monitoramento e para conferir qual provedor está ativo.
  app.get("/health", (_req, res) =>
    res.json({ ok: true, whatsapp: bot.whatsapp.nome, ia: bot.ia.nome }),
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
