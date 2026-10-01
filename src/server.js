import express from "express";
import { timingSafeEqual } from "node:crypto";
import {
  criarToken,
  tokenValido,
  senhaConfere,
  lerCookie,
  segredoPadrao,
  FreioDeTentativas,
} from "./core/autenticacao.js";
import { fileURLToPath } from "node:url";
import { perfisDisponiveis, separarPerfil } from "./core/prompt.js";
import { vocabulario } from "./core/horarios.js";
import { normalizarTelefone } from "./core/telefone.js";
import { PERGUNTAS, montarDocumento, contarRespostas } from "./core/formularioLoja.js";

// Camada HTTP: só traduz requisição em chamada de serviço. Recebe o BotService
// pronto, então dá para subir o servidor com um serviço falso em teste.

const PASTA_PUBLICA = fileURLToPath(new URL("../public", import.meta.url));

export function criarServidor({
  bot,
  metricas,
  agenda,
  base,
  lojas = null,
  aoTrocarPerfil = async () => {},
  config = {},
  logger = console,
}) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // --- Autenticação do painel ----------------------------------------------
  // Só o webhook e a tela de login ficam fora: todo o resto manda mensagem,
  // lê conversa ou muda configuração.
  const COOKIE = "wpbot_sessao";
  const senha = config.painel?.senha ?? null;
  const segredo = config.painel?.segredo ?? (senha ? segredoPadrao(senha) : null);
  const freio = new FreioDeTentativas();

  const liberado = (req) =>
    req.path.startsWith("/webhook") ||
    req.path === "/health" ||
    req.path === "/painel/login.html" ||
    req.path === "/api/login";

  app.use((req, res, next) => {
    if (!senha || liberado(req)) return next();

    if (tokenValido({ token: lerCookie(req.get("cookie"), COOKIE), segredo })) return next();

    // Página pede a tela de login; chamada de API recebe 401 para o painel
    // saber redirecionar sozinho.
    if (req.method === "GET" && req.accepts("html") && !req.path.startsWith("/api/")) {
      return res.redirect("/painel/login.html");
    }
    return res.status(401).json({ erro: "não autenticado" });
  });

  app.post("/api/login", (req, res) => {
    if (!senha) return res.json({ autenticado: true, aviso: "painel sem senha configurada" });

    const origem = req.ip ?? "desconhecida";
    if (freio.bloqueado(origem)) {
      logger.log(`🚫 Login bloqueado por tentativas: ${origem}`);
      return res.status(429).json({ erro: "muitas tentativas; tente de novo em alguns minutos" });
    }

    if (!senhaConfere(req.body?.senha, senha)) {
      const restantes = freio.errou(origem);
      logger.log(`🚫 Senha incorreta (${origem}), ${Math.max(restantes, 0)} tentativa(s)`);
      return res.status(401).json({ erro: "senha incorreta" });
    }

    freio.acertou(origem);
    const token = criarToken({ segredo, horas: config.painel.horasDeSessao });
    // httpOnly: JavaScript da página não lê o cookie, então um XSS não leva a
    // sessão embora. SameSite=Strict: outro site não consegue usar a sessão.
    res.cookie?.(COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      maxAge: config.painel.horasDeSessao * 60 * 60 * 1000,
    });
    logger.log("🔓 Painel: sessão iniciada");
    res.json({ autenticado: true });
  });

  app.post("/api/logout", (req, res) => {
    res.clearCookie?.(COOKIE);
    res.json({ autenticado: false });
  });

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

  // O webhook é a única rota que precisa ser pública, então é a única que fica
  // exposta quando o túnel está no ar. Sem segredo, qualquer um que descubra a
  // URL faz o bot responder (e gastar OpenAI) mandando payload falso.
  //
  // Comparação em tempo constante: comparar com === vaza, pelo tempo de
  // resposta, quantos caracteres do token estavam certos.
  const tokenConfere = (recebido) => {
    if (!config.webhook?.token) return true; // sem token configurado, segue aberto
    const esperado = Buffer.from(config.webhook.token);
    const veio = Buffer.from(String(recebido ?? ""));
    return veio.length === esperado.length && timingSafeEqual(veio, esperado);
  };

  const receberWebhook = (req, res) => {
    // 404 em vez de 401: não confirma que existe um webhook aqui.
    if (!tokenConfere(req.params.token ?? req.get("x-webhook-token"))) {
      logger.log("🚫 Webhook recusado: token inválido");
      return res.sendStatus(404);
    }

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
  };

  // Duas formas: token no caminho (o provedor só precisa de uma URL) ou no
  // cabeçalho x-webhook-token, para quem consegue configurar cabeçalho.
  app.post("/webhook", receberWebhook);
  app.post("/webhook/:token", receberWebhook);

  // --- Painel ---------------------------------------------------------------
  // Serve a página e os dados que ela consome. Não tem autenticação: é para
  // uso local, e o endpoint de envio manda mensagem de verdade. Ao ir para uma
  // VPS, isso fica atrás do firewall (ou de um túnel SSH), nunca aberto.
  app.use("/painel", express.static(PASTA_PUBLICA));

  app.get("/api/estado", async (_req, res) =>
    res.json({
      whatsapp: bot.whatsapp.nome,
      ia: bot.ia.nome,
      prompt: bot.prompt.textoCustomizado ? "customizado" : bot.prompt.perfil,
      numeroTeste: config.numeroTeste ?? null,
      contatos: config.contatos ?? [],
      perfil: bot.prompt?.perfil ?? null,
      imagemDetalhe: bot.imagem?.detalhe ?? null,
      tarefas: agenda?.listar() ?? [],
      pausados: (await bot.atendimento?.listar()) ?? [],
      tetos: {
        ...bot.tetos,
        usadoHoje: (await bot.limites?.valor("global")) ?? 0,
      },
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

  // --- Perfil ativo ---
  // Lista o que dá para escolher: os perfis fixos e um por loja cadastrada.
  app.get("/api/perfis", async (_req, res) => {
    const cadastradas = lojas ? await lojas.listar() : [];
    res.json({
      ativo: bot.prompt.perfil,
      fixos: perfisDisponiveis,
      lojas: cadastradas.map((l) => ({ perfil: l.perfil, nome: l.nome })),
    });
  });

  // Troca o perfil em uso, sem reiniciar, e guarda a escolha.
  app.put("/api/perfil", async (req, res) => {
    const perfil = String(req.body?.perfil ?? "").trim();
    const { perfil: base_, slug } = separarPerfil(perfil);

    if (!perfisDisponiveis.includes(base_)) {
      return res.status(400).json({ erro: `perfil desconhecido: "${perfil}"` });
    }
    // Perfil de loja só vale se a loja existir — senão o bot atenderia sem
    // dado nenhum e ninguém saberia por quê.
    if (slug && !(await lojas?.obter(slug))) {
      return res.status(400).json({ erro: `loja "${slug}" não cadastrada` });
    }

    bot.prompt.perfil = perfil;
    await aoTrocarPerfil(perfil);
    logger.log(`💬 Perfil trocado para ${perfil}`);
    res.json({ perfil });
  });

  // --- Atendimento humano ---
  // Pausar e retomar pelo painel, além dos comandos #pausar/#voltar que o dono
  // usa no próprio chat.
  app.post("/api/atendimento/:telefone/pausar", async (req, res) => {
    // Normaliza aqui: "(19) 99372-3677" precisa virar 5519993723677, que é
    // como o WhatsApp identifica a conversa.
    const telefone = normalizarTelefone(req.params.telefone);
    const minutos = req.body?.minutos === undefined ? null : Number(req.body.minutos);
    const pausa = await bot.atendimento.pausar(telefone, minutos);
    logger.log(`🙋 ${telefone}: pausado pelo painel`);
    res.json({ pausado: true, ...pausa });
  });

  app.post("/api/atendimento/:telefone/retomar", async (req, res) => {
    const telefone = normalizarTelefone(req.params.telefone);
    const retomou = await bot.atendimento.retomar(telefone);
    logger.log(`🤖 ${telefone}: retomado pelo painel`);
    res.json({ retomado: retomou });
  });

  // --- Lojas (formulário guiado) ---
  // O esquema das perguntas vem do servidor: o painel monta a tela a partir
  // dele, então acrescentar pergunta é mexer num arquivo só.
  app.get("/api/loja/formulario", (_req, res) => res.json({ secoes: PERGUNTAS }));

  app.get("/api/lojas", async (_req, res) => {
    if (!lojas) return res.json({ lojas: [], perfilAtivo: null });
    res.json({ lojas: await lojas.listar(), perfilAtivo: bot.prompt.perfil ?? null });
  });

  app.get("/api/lojas/:slug", async (req, res) => {
    const loja = await lojas.obter(req.params.slug);
    if (!loja) return res.status(404).json({ erro: "loja não cadastrada" });
    res.json({ ...loja, progresso: contarRespostas(loja.respostas) });
  });

  // Prévia: mostra o documento que sairia, sem salvar nem indexar. Ver o
  // resultado antes de gravar é o que dá confiança no formulário.
  app.post("/api/lojas/previa", (req, res) => {
    const respostas = req.body?.respostas ?? {};
    res.json({ documento: montarDocumento(respostas), progresso: contarRespostas(respostas) });
  });

  // Salva e indexa. Sem slug, ele sai do nome da loja — cadastrar "Sara
  // Modas" cria o perfil loja_sara-modas.
  // Duas rotas em vez de ":slug?": o Express 5 não aceita mais parâmetro
  // opcional no caminho.
  const salvarLoja = async (req, res) => {
    const respostas = req.body?.respostas;
    if (!respostas || typeof respostas !== "object") {
      return res.status(400).json({ erro: "envie as respostas" });
    }

    try {
      const salva = await lojas.salvar({ slug: req.params.slug, respostas });
      res.json({ salva: true, ...salva, progresso: contarRespostas(respostas) });
    } catch (erro) {
      logger.error("❌ Erro ao salvar a loja:", erro);
      res.status(502).json({ erro: erro.message });
    }
  };

  app.put("/api/lojas", salvarLoja);
  app.put("/api/lojas/:slug", salvarLoja);

  app.delete("/api/lojas/:slug", async (req, res) => {
    try {
      const resultado = await lojas.remover(req.params.slug);
      if (!resultado.removida) return res.status(404).json({ erro: "loja não cadastrada" });
      logger.log(`🗑️  Loja "${req.params.slug}" removida`);
      res.json(resultado);
    } catch (erro) {
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
    const telefone = normalizarTelefone(req.body?.telefone ?? config.numeroTeste ?? "");
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
