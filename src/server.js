import express from "express";
import { fileURLToPath } from "node:url";
import { perfisDisponiveis } from "./core/prompt.js";
import { vocabulario } from "./core/horarios.js";
import {
  PERGUNTAS,
  montarDocumento,
  resumoParaPrompt,
  contarRespostas,
} from "./core/formularioLoja.js";

// Camada HTTP: só traduz requisição em chamada de serviço. Recebe o BotService
// pronto, então dá para subir o servidor com um serviço falso em teste.

const PASTA_PUBLICA = fileURLToPath(new URL("../public", import.meta.url));

const NOME_DO_DOCUMENTO = "loja.md";

export function criarServidor({
  bot,
  metricas,
  agenda,
  base,
  salvarLoja = async () => {},
  config = {},
  logger = console,
}) {
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
      contatos: config.contatos ?? [],
      loja: bot.loja?.respostas?.nome ?? null,
      imagemDetalhe: bot.imagem?.detalhe ?? null,
      tarefas: agenda?.listar() ?? [],
      resumo: metricas.resumo(),
      eventos: metricas.eventos,
    }),
  );

  // O vocabulário de horários, para o painel montar as sugestões sem
  // duplicar as tabelas em JavaScript do navegador.
  app.get("/api/horarios", (_req, res) => res.json(vocabulario()));

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

  // --- Formulário da loja ---
  // O esquema das perguntas vem do servidor: o painel monta a tela a partir
  // dele, então acrescentar pergunta é mexer num arquivo só.
  app.get("/api/loja/formulario", (_req, res) => res.json({ secoes: PERGUNTAS }));

  app.get("/api/loja", async (_req, res) => {
    const respostas = bot.loja?.respostas ?? {};
    res.json({
      respostas,
      progresso: contarRespostas(respostas),
      documento: montarDocumento(respostas),
      indexadoEm: bot.loja?.indexadoEm ?? null,
    });
  });

  // Prévia: mostra o documento que sairia, sem salvar nem indexar. Existe
  // porque ver o resultado antes de gravar é o que dá confiança no formulário.
  app.post("/api/loja/previa", (req, res) => {
    const respostas = req.body?.respostas ?? {};
    res.json({ documento: montarDocumento(respostas), progresso: contarRespostas(respostas) });
  });

  // Salva as respostas, monta o documento e indexa. O resumo estruturado passa
  // a valer na resposta seguinte, sem reiniciar o servidor.
  app.put("/api/loja", async (req, res) => {
    const respostas = req.body?.respostas;
    if (!respostas || typeof respostas !== "object") {
      return res.status(400).json({ erro: "envie as respostas" });
    }

    const documento = montarDocumento(respostas);

    try {
      let pedacos = null;
      // Sem RAG ligado, as respostas são salvas e o resumo estruturado já
      // funciona; só o documento não vai para a busca.
      if (base && base.nome !== "nenhum") {
        ({ pedacos } = await base.indexar({ nome: NOME_DO_DOCUMENTO, texto: documento }));
      }

      await salvarLoja({ respostas, indexadoEm: new Date().toISOString() });
      bot.loja = { respostas, resumo: resumoParaPrompt(respostas), indexadoEm: new Date().toISOString() };

      logger.log(`🏪 Loja salva${pedacos ? ` e indexada em ${pedacos} pedaço(s)` : " (RAG desligado)"}`);
      res.json({ salva: true, documento, pedacos, progresso: contarRespostas(respostas) });
    } catch (erro) {
      logger.error("❌ Erro ao salvar a loja:", erro);
      res.status(502).json({ erro: erro.message });
    }
  });

  // --- Base de conhecimento (RAG) ---
  app.get("/api/base", async (_req, res) => {
    if (!base) return res.json({ provedor: "nenhum", documentos: [] });
    res.json({ provedor: base.nome, documentos: await base.documentos() });
  });

  // Testa a busca sem gastar uma resposta: mostra os trechos e a distância de
  // cada um, que é o jeito de calibrar o limiar sem adivinhar.
  app.post("/api/base/buscar", async (req, res) => {
    const pergunta = String(req.body?.pergunta ?? "").trim();
    if (!pergunta) return res.status(400).json({ erro: "informe a pergunta" });

    try {
      res.json({ trechos: await base.buscar(pergunta) });
    } catch (erro) {
      logger.error("❌ Erro ao buscar na base:", erro);
      res.status(502).json({ erro: erro.message });
    }
  });

  app.delete("/api/base/:nome", async (req, res) => {
    try {
      const removidos = await base.remover(req.params.nome);
      res.json({ removidos });
    } catch (erro) {
      res.status(502).json({ erro: erro.message });
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
