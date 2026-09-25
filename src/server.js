import express from "express";
import { fileURLToPath } from "node:url";
import { perfisDisponiveis } from "./core/prompt.js";

// Camada HTTP: só traduz requisição em chamada de serviço. Recebe o BotService
// pronto, então dá para subir o servidor com um serviço falso em teste.

const PASTA_PUBLICA = fileURLToPath(new URL("../public", import.meta.url));

export function criarServidor({ bot, metricas, config = {}, logger = console }) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/", (_req, res) => res.send("Bot vivo 🚀 — painel em /painel"));

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

  // --- Painel ---------------------------------------------------------------
  // Serve a página e os dados que ela consome. Não tem autenticação: é para
  // uso local, e o endpoint de envio manda mensagem de verdade. Ao ir para uma
  // VPS, isso fica atrás do firewall (ou de um túnel SSH), nunca aberto.
  app.use("/painel", express.static(PASTA_PUBLICA));

  app.get("/api/estado", (_req, res) =>
    res.json({
      whatsapp: bot.whatsapp.nome,
      ia: bot.ia.nome,
      prompt: bot.prompt.textoCustomizado ? "customizado" : bot.prompt.perfil,
      numeroTeste: config.numeroTeste ?? null,
      resumo: metricas.resumo(),
      eventos: metricas.eventos,
    }),
  );

  app.post("/api/enviar", async (req, res) => {
    const telefone = String(req.body?.telefone ?? config.numeroTeste ?? "").replace(/\D/g, "");
    const texto = String(req.body?.texto ?? "").trim();

    if (!telefone) return res.status(400).json({ erro: "informe um telefone" });
    if (!texto) return res.status(400).json({ erro: "informe o texto" });

    try {
      await bot.enviarManual({ telefone, texto });
      res.json({ enviada: true, telefone });
    } catch (erro) {
      logger.error("❌ Erro no envio manual:", erro);
      res.status(502).json({ erro: erro.message });
    }
  });

  return app;
}
