import express from "express";
import { fileURLToPath } from "node:url";
import { perfisDisponiveis } from "./core/prompt.js";
import { HORAS, DIAS, FREQUENCIAS } from "./core/horarios.js";

// Camada HTTP: só traduz requisição em chamada de serviço. Recebe o BotService
// pronto, então dá para subir o servidor com um serviço falso em teste.

const PASTA_PUBLICA = fileURLToPath(new URL("../public", import.meta.url));

export function criarServidor({ bot, metricas, agenda, config = {}, logger = console }) {
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
      tarefas: agenda?.listar() ?? [],
      resumo: metricas.resumo(),
      eventos: metricas.eventos,
    }),
  );

  // O vocabulário de horários, para o painel montar as sugestões sem
  // duplicar as tabelas em JavaScript do navegador.
  app.get("/api/horarios", (_req, res) =>
    res.json({
      horas: Object.keys(HORAS),
      dias: Object.keys(DIAS),
      frequencias: Object.keys(FREQUENCIAS),
    }),
  );

  // Salva a agenda inteira e reagenda na hora. Substitui a lista toda em vez
  // de editar item por item: o painel manda o que está na tela, e o arquivo
  // passa a ser exatamente aquilo.
  app.put("/api/tarefas", async (req, res) => {
    if (!agenda) return res.status(404).json({ erro: "agenda não configurada" });

    try {
      const tarefas = await agenda.salvar(req.body?.tarefas);
      logger.log(`💾 Agenda salva: ${tarefas.length} tarefa(s)`);
      res.json({ salva: true, tarefas });
    } catch (erro) {
      res.status(400).json({ erro: erro.message, problemas: erro.problemas ?? [] });
    }
  });

  // Dispara uma tarefa agora, sem esperar o horário — é assim que se testa
  // uma tarefa nova sem mexer no cron.
  app.post("/api/tarefas/:nome/executar", async (req, res) => {
    if (!agenda) return res.status(404).json({ erro: "agenda não configurada" });

    try {
      const { resposta } = await agenda.executar(req.params.nome);
      res.json({ executada: true, resposta });
    } catch (erro) {
      logger.error("❌ Erro ao executar tarefa:", erro);
      res.status(400).json({ erro: erro.message });
    }
  });

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
