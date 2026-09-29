import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { readFile, rm } from "node:fs/promises";
import { ZapiAdapter } from "./src/adapters/whatsapp/ZapiAdapter.js";
import { EvolutionAdapter } from "./src/adapters/whatsapp/EvolutionAdapter.js";
import { MemoriaRepo } from "./src/adapters/conversas/MemoriaRepo.js";
import { BotService } from "./src/core/BotService.js";
import { montarPromptDeSistema, perfisDisponiveis } from "./src/core/prompt.js";
import { montarDocumento, resumoParaPrompt, contarRespostas, apresentacaoDaLoja } from "./src/core/formularioLoja.js";
import { Lojas, gerarSlug, nomeDoDocumento } from "./src/core/lojas.js";
import { separarPerfil } from "./src/core/prompt.js";
import { ControleDeAtendimento, IdsEnviados, comandoDoDono } from "./src/core/atendimento.js";
import { normalizarTelefone } from "./src/core/telefone.js";
import { carregarPreferencias, salvarPreferencias } from "./src/core/preferencias.js";
import { PostgresRepo } from "./src/adapters/conversas/PostgresRepo.js";
import { PostgresAtendimento } from "./src/adapters/atendimento/PostgresAtendimento.js";
import { Metricas } from "./src/core/Metricas.js";
import { custoDeTexto, custoDeTranscricao, custoDeImagemGerada, custoDeBusca, somar } from "./src/core/billing.js";
import { Agenda, normalizarTelefones } from "./src/core/Agenda.js";
import { quebrarEmPedacos } from "./src/core/chunker.js";
import { MemoriaBase, BaseNula } from "./src/adapters/base/MemoriaBase.js";
import { resolverHorario, descreverHorario, decomporHorario, vocabulario } from "./src/core/horarios.js";

// Rode com: npm test
// Nada aqui toca a rede: os adaptadores de WhatsApp e IA são substituídos por
// dublês, o que só é possível porque o BotService depende das portas, não das
// implementações.

const zapi = new ZapiAdapter({
  instanceId: "x",
  instanceToken: "y",
  clientToken: "z",
});
const evolution = new EvolutionAdapter({
  baseUrl: "http://localhost:8080",
  instancia: "bot",
  apiKey: "k",
});

test("Z-API e Evolution produzem a mesma mensagem normalizada", () => {
  const daZapi = zapi.interpretarWebhook({
    phone: "5519999999999",
    senderName: "Kelwin",
    fromMe: false,
    isGroup: false,
    text: { message: "oi" },
  });

  const daEvolution = evolution.interpretarWebhook({
    event: "messages.upsert",
    instance: "bot",
    data: {
      key: { remoteJid: "5519999999999@s.whatsapp.net", fromMe: false, id: "ABC" },
      pushName: "Kelwin",
      message: { conversation: "oi" },
    },
  });

  // id e bruto ficam de fora: são o que cada provedor tem de próprio.
  const semProvedor = ({ bruto, id, ...resto }) => resto;
  assert.deepEqual(semProvedor(daZapi), semProvedor(daEvolution));
  assert.equal(daZapi.telefone, "5519999999999");
  // Mas o id é lido de onde cada um o põe.
  assert.equal(daEvolution.id, "ABC");
});

test("Evolution: extendedTextMessage, grupo e eventos ignorados", () => {
  const citada = evolution.interpretarWebhook({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5519999999999@s.whatsapp.net", fromMe: false },
      message: { extendedTextMessage: { text: "e a dose?" } },
    },
  });
  assert.equal(citada.texto, "e a dose?");

  const grupo = evolution.interpretarWebhook({
    event: "MESSAGES_UPSERT",
    data: {
      key: { remoteJid: "12345-67890@g.us", fromMe: false },
      message: { conversation: "oi galera" },
    },
  });
  assert.equal(grupo.grupo, true);

  assert.equal(evolution.interpretarWebhook({ event: "messages.update", data: {} }), null);
  assert.equal(evolution.interpretarWebhook({ event: "messages.upsert", data: { key: {} } }), null);
});

test("Z-API ignora payload sem texto", () => {
  assert.equal(zapi.interpretarWebhook({ phone: "551999", status: "RECEIVED" }), null);
});

// Dublês: respondem ao contrato das portas sem sair da máquina.
function montarBot({ respostaIA = "Olá! 🤖" } = {}) {
  const enviadas = [];
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async (p) => enviadas.push(p),
    },
    ia: { nome: "falsa", responder: async () => respostaIA },
    conversas: new MemoriaRepo({ maxHistorico: 4 }),
    logger: { log() {}, error() {} },
  });
  return { bot, enviadas };
}

const webhook = (texto, extra = {}) => ({
  phone: "5519999999999",
  senderName: "Kelwin",
  fromMe: false,
  text: { message: texto },
  ...extra,
});

test("responde uma mensagem normal e guarda o histórico", async () => {
  const { bot, enviadas } = montarBot();

  const r = await bot.processarWebhook(webhook("oi"));

  assert.equal(r.tratada, true);
  assert.equal(enviadas.length, 1);
  assert.equal(enviadas[0].telefone, "5519999999999");
  // Ritmo do "digitando...": entre o mínimo e o teto de 3s.
  assert.ok(enviadas[0].digitandoMs >= 800 && enviadas[0].digitandoMs <= 3000);

  const historico = await bot.conversas.historico("5519999999999");
  assert.deepEqual(historico.map((m) => m.role), ["user", "assistant"]);
});

test("ignora mensagem própria e de grupo", async () => {
  const { bot, enviadas } = montarBot();

  assert.equal((await bot.processarWebhook(webhook("oi", { fromMe: true }))).tratada, false);
  assert.equal((await bot.processarWebhook(webhook("oi", { isGroup: true }))).tratada, false);
  assert.equal(enviadas.length, 0);
});

test("avisa a pessoa quando a IA falha", async () => {
  const enviadas = [];
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async (p) => enviadas.push(p),
    },
    ia: { nome: "falsa", responder: async () => { throw new Error("429"); } },
    conversas: new MemoriaRepo({ maxHistorico: 4 }),
    logger: { log() {}, error() {} },
  });

  const r = await bot.processarWebhook(webhook("oi"));

  assert.equal(r.tratada, false);
  assert.equal(enviadas.length, 1);
  assert.match(enviadas[0].texto, /probleminha/);
});

test("histórico corta as mensagens mais antigas", async () => {
  const repo = new MemoriaRepo({ maxHistorico: 2 });
  for (const c of ["a", "b", "c"]) await repo.acrescentar("551", { role: "user", content: c });
  assert.deepEqual((await repo.historico("551")).map((m) => m.content), ["b", "c"]);
});

test("perfis de prompt: suplementos, whatsapp, puro e customizado", () => {
  const comNome = { nome: "Kelwin" };

  assert.match(montarPromptDeSistema({ ...comNome, perfil: "suplementos" }), /suplementos e alimentação/);
  assert.match(montarPromptDeSistema({ ...comNome, perfil: "whatsapp" }), /português do Brasil/);
  assert.doesNotMatch(montarPromptDeSistema({ ...comNome, perfil: "whatsapp" }), /suplementos/);

  // Puro: nada é enviado antes da conversa.
  assert.equal(montarPromptDeSistema({ ...comNome, perfil: "puro" }), null);

  // Texto próprio vence o perfil.
  assert.equal(
    montarPromptDeSistema({ ...comNome, perfil: "suplementos", textoCustomizado: "Seja um pirata." }),
    "Seja um pirata.",
  );

  assert.throws(() => montarPromptDeSistema({ ...comNome, perfil: "inexistente" }), /Perfil de prompt desconhecido/);
});

test("o perfil escolhido chega na IA", async () => {
  const recebidos = [];
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async () => {},
    },
    ia: { nome: "falsa", responder: async (p) => { recebidos.push(p.sistema); return "ok"; } },
    conversas: new MemoriaRepo({ maxHistorico: 4 }),
    prompt: { perfil: "puro" },
    logger: { log() {}, error() {} },
  });

  await bot.processarWebhook(webhook("qual a capital da França?"));

  assert.equal(recebidos[0], null);
});

// --- Imagem recebida -------------------------------------------------------

const webhookEvolutionImagem = (legenda) => ({
  event: "messages.upsert",
  data: {
    key: { remoteJid: "5519999999999@s.whatsapp.net", fromMe: false, id: "MSG1" },
    pushName: "Kelwin",
    message: { imageMessage: { mimetype: "image/jpeg", caption: legenda } },
  },
});

test("Evolution: imagem vira mídia com a legenda como texto", () => {
  const comLegenda = evolution.interpretarWebhook(webhookEvolutionImagem("o que tem nesse rótulo?"));
  assert.equal(comLegenda.texto, "o que tem nesse rótulo?");
  assert.equal(comLegenda.midia.tipo, "imagem");
  assert.equal(comLegenda.midia.mimetype, "image/jpeg");
  // A chave é o que o endpoint de download pede.
  assert.equal(comLegenda.midia.referencia.id, "MSG1");

  // Imagem sem legenda continua sendo mensagem tratável.
  const semLegenda = evolution.interpretarWebhook(webhookEvolutionImagem(undefined));
  assert.equal(semLegenda.texto, "");
  assert.equal(semLegenda.midia.tipo, "imagem");

  // Áudio é reconhecido, para o bot poder avisar que não trata.
  const audio = evolution.interpretarWebhook({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5519999999999@s.whatsapp.net", fromMe: false },
      message: { audioMessage: { mimetype: "audio/ogg" } },
    },
  });
  assert.equal(audio.midia.tipo, "audio");
});

test("Z-API: imagem vira mídia com URL para baixar", () => {
  const m = zapi.interpretarWebhook({
    phone: "5519999999999",
    senderName: "Kelwin",
    fromMe: false,
    image: { imageUrl: "https://exemplo/foto.jpg", mimeType: "image/jpeg", caption: "olha isso" },
  });
  assert.equal(m.texto, "olha isso");
  assert.equal(m.midia.tipo, "imagem");
  assert.equal(m.midia.referencia.url, "https://exemplo/foto.jpg");
});

// Dublê com download de mídia, para o fluxo de imagem.
function montarBotComMidia({ base64 = "AAAA", mimetype = "image/jpeg" } = {}) {
  const enviadas = [];
  const recebidosPelaIA = [];
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => evolution.interpretarWebhook(c),
      enviarTexto: async (p) => enviadas.push(p),
      obterMidiaBase64: async () => ({ base64, mimetype }),
    },
    ia: {
      nome: "falsa",
      responder: async (p) => { recebidosPelaIA.push(p.mensagens); return "Vejo um rótulo de creatina."; },
    },
    conversas: new MemoriaRepo({ maxHistorico: 6 }),
    logger: { log() {}, error() {} },
  });
  return { bot, enviadas, recebidosPelaIA };
}

test("imagem chega na IA como conteúdo multimodal", async () => {
  const { bot, enviadas, recebidosPelaIA } = montarBotComMidia();

  const r = await bot.processarWebhook(webhookEvolutionImagem("que suplemento é esse?"));

  assert.equal(r.tratada, true);
  assert.equal(enviadas.length, 1);

  const conteudo = recebidosPelaIA[0].at(-1).content;
  assert.ok(Array.isArray(conteudo));
  assert.deepEqual(conteudo[0], { type: "text", text: "que suplemento é esse?" });
  assert.equal(conteudo[1].image_url.url, "data:image/jpeg;base64,AAAA");
});

test("imagem sem legenda ganha pergunta padrão", async () => {
  const { bot, recebidosPelaIA } = montarBotComMidia();

  await bot.processarWebhook(webhookEvolutionImagem(undefined));

  assert.match(recebidosPelaIA[0].at(-1).content[0].text, /O que tem nesta imagem/);
});

test("o histórico guarda só a marca em texto, nunca a imagem", async () => {
  const { bot, recebidosPelaIA } = montarBotComMidia();

  await bot.processarWebhook(webhookEvolutionImagem("é bom?"));
  // Segunda mensagem, agora de texto: o histórico não pode carregar a imagem.
  await bot.processarWebhook({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5519999999999@s.whatsapp.net", fromMe: false },
      pushName: "Kelwin",
      message: { conversation: "e a dose?" },
    },
  });

  const historico = await bot.conversas.historico("5519999999999");
  assert.deepEqual(historico.map((m) => m.content), [
    "[imagem enviada] é bom?",
    "Vejo um rótulo de creatina.",
    "e a dose?",
    "Vejo um rótulo de creatina.",
  ]);

  // Nenhuma mensagem da segunda chamada leva image_url.
  assert.ok(recebidosPelaIA[1].every((m) => typeof m.content === "string"));
});

test("vídeo recebe aviso e não gasta chamada de IA", async () => {
  const { bot, enviadas, recebidosPelaIA } = montarBotComMidia();

  const r = await bot.processarWebhook({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5519999999999@s.whatsapp.net", fromMe: false },
      pushName: "Kelwin",
      message: { videoMessage: { mimetype: "video/mp4" } },
    },
  });

  assert.equal(r.tratada, false);
  assert.match(r.motivo, /vídeo|video/);
  assert.equal(recebidosPelaIA.length, 0);
  assert.match(enviadas[0].texto, /ver vídeo/);
});

// --- Áudio recebido --------------------------------------------------------

const webhookAudio = () => ({
  event: "messages.upsert",
  data: {
    key: { remoteJid: "5519999999999@s.whatsapp.net", fromMe: false, id: "AUD1" },
    pushName: "Kelwin",
    message: { audioMessage: { mimetype: "audio/ogg; codecs=opus" } },
  },
});

function montarBotComAudio({ transcricao = "qual a dose de creatina?" } = {}) {
  const enviadas = [];
  const recebidosPelaIA = [];
  const transcritos = [];
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => evolution.interpretarWebhook(c),
      enviarTexto: async (p) => enviadas.push(p),
      obterMidiaBase64: async () => ({ base64: "T2dnUw==", mimetype: "audio/ogg" }),
    },
    ia: {
      nome: "falsa",
      responder: async (p) => { recebidosPelaIA.push(p.mensagens); return "De 3 a 5 g por dia."; },
      transcrever: async (p) => { transcritos.push(p); return transcricao; },
    },
    conversas: new MemoriaRepo({ maxHistorico: 6 }),
    logger: { log() {}, error() {} },
  });
  return { bot, enviadas, recebidosPelaIA, transcritos };
}

test("áudio é transcrito e segue como texto comum", async () => {
  const { bot, enviadas, recebidosPelaIA, transcritos } = montarBotComAudio();

  const r = await bot.processarWebhook(webhookAudio());

  assert.equal(r.tratada, true);
  // O modelo de conversa recebe texto puro, não áudio.
  assert.equal(recebidosPelaIA[0].at(-1).content, "qual a dose de creatina?");
  assert.equal(transcritos[0].mimetype, "audio/ogg");
  assert.equal(enviadas[0].texto, "De 3 a 5 g por dia.");

  // No histórico fica marcado que veio de áudio.
  const historico = await bot.conversas.historico("5519999999999");
  assert.equal(historico[0].content, "[áudio] qual a dose de creatina?");
});

test("áudio sem fala vira aviso, sem chamar o modelo de conversa", async () => {
  const { bot, enviadas, recebidosPelaIA } = montarBotComAudio({ transcricao: "   " });

  const r = await bot.processarWebhook(webhookAudio());

  assert.equal(r.tratada, false);
  assert.equal(r.motivo, "áudio sem fala");
  assert.equal(recebidosPelaIA.length, 0);
  assert.match(enviadas[0].texto, /Não consegui entender o áudio/);
  assert.deepEqual(await bot.conversas.historico("5519999999999"), []);
});

// --- Métricas --------------------------------------------------------------

test("Metricas: agrega contagens e tempos", () => {
  const m = new Metricas({ maxEventos: 3 });
  m.registrar({ tipo: "respondida", iaMs: 100, totalMs: 150 });
  m.registrar({ tipo: "respondida", iaMs: 300, totalMs: 400 });
  m.registrar({ tipo: "erro", erro: "429" });

  const r = m.resumo();
  assert.equal(r.respondidas, 2);
  assert.equal(r.erros, 1);
  assert.equal(r.iaMedioMs, 200);
  assert.equal(r.iaP95Ms, 300);
  assert.equal(r.totalMedioMs, 275);

  // Mais recente primeiro, e o buffer não cresce além do limite.
  assert.equal(m.eventos[0].tipo, "erro");
  m.registrar({ tipo: "ignorada", motivo: "grupo" });
  assert.equal(m.eventos.length, 3);
});

test("o BotService registra tempos e erros nas métricas", async () => {
  const metricas = new Metricas();
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async () => {},
    },
    ia: { nome: "falsa", responder: async () => "oi!" },
    conversas: new MemoriaRepo({ maxHistorico: 4 }),
    metricas,
    logger: { log() {}, error() {} },
  });

  await bot.processarWebhook(webhook("oi"));
  await bot.processarWebhook(webhook("oi", { isGroup: true }));

  const r = metricas.resumo();
  assert.equal(r.respondidas, 1);
  assert.equal(r.ignoradas, 1);
  assert.equal(typeof metricas.eventos.at(-1).iaMs, "number");
  assert.equal(metricas.eventos.at(-1).resposta, "oi!");
});

test("enviarManual registra o disparo do painel", async () => {
  const metricas = new Metricas();
  const enviadas = [];
  const bot = new BotService({
    whatsapp: { nome: "falso", enviarTexto: async (p) => enviadas.push(p) },
    ia: { nome: "falsa", responder: async () => "" },
    conversas: new MemoriaRepo({ maxHistorico: 4 }),
    metricas,
    logger: { log() {}, error() {} },
  });

  await bot.enviarManual({ telefone: "5519999999999", texto: "teste" });

  assert.equal(enviadas[0].texto, "teste");
  assert.equal(metricas.resumo().enviadasManualmente, 1);
  // Disparo manual não entra no histórico da conversa.
  assert.deepEqual(await bot.conversas.historico("5519999999999"), []);
});

test("limite de palavras entra no prompt e some no perfil puro", () => {
  const comLimite = montarPromptDeSistema({ nome: "Kelwin", perfil: "whatsapp", limitePalavras: 60 });
  assert.match(comLimite, /No máximo 60 palavras/);
  assert.match(comLimite, /ofereça detalhar/);

  // Sem limite configurado, nenhuma instrução de tamanho é enviada.
  const semLimite = montarPromptDeSistema({ nome: "Kelwin", perfil: "whatsapp", limitePalavras: null });
  assert.doesNotMatch(semLimite, /No máximo/);

  // Puro continua puro: nem tamanho é imposto.
  assert.equal(montarPromptDeSistema({ nome: "Kelwin", perfil: "puro", limitePalavras: 60 }), null);
});

// --- Resposta picada em várias mensagens -----------------------------------

test("divide a resposta no marcador e respeita o máximo", () => {
  const bot = new BotService({ whatsapp: {}, ia: {}, conversas: {} });
  const resposta = "Primeira.\n---\nSegunda.\n---\nTerceira.";

  assert.deepEqual(bot.dividirResposta(resposta, 3), ["Primeira.", "Segunda.", "Terceira."]);

  // Excedente é juntado na última, não descartado.
  assert.deepEqual(bot.dividirResposta(resposta, 2), ["Primeira.", "Segunda.\n\nTerceira."]);

  // Sem marcador, uma mensagem só.
  assert.deepEqual(bot.dividirResposta("Uma frase.", 3), ["Uma frase."]);

  // Marcador com espaços ou hifens extras também vale.
  assert.deepEqual(bot.dividirResposta("A\n  ----  \nB", 2), ["A", "B"]);
});

test("envia uma mensagem por parte, em ordem", async () => {
  const enviadas = [];
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async (p) => { enviadas.push(p.texto); },
    },
    ia: { nome: "falsa", responder: async () => "Oi!\n---\nTudo bem?" },
    conversas: new MemoriaRepo({ maxHistorico: 4 }),
    prompt: { perfil: "whatsapp", maxMensagens: 3 },
    logger: { log() {}, error() {} },
  });

  const r = await bot.processarWebhook(webhook("oi"));

  assert.equal(r.tratada, true);
  assert.deepEqual(enviadas, ["Oi!", "Tudo bem?"]);

  // No histórico fica a resposta inteira, para o modelo ter o contexto.
  const historico = await bot.conversas.historico("5519999999999");
  assert.equal(historico[1].content, "Oi!\n---\nTudo bem?");
});

test("a instrução de quebra só aparece quando o máximo é maior que 1", () => {
  const varias = montarPromptDeSistema({ nome: "K", perfil: "whatsapp", limitePalavras: 60, maxMensagens: 3 });
  assert.match(varias, /3 é o teto, não a meta/);
  // O padrão pedido é mensagem única; quebrar é a exceção.
  assert.match(varias, /O normal é UMA mensagem só/);

  const unica = montarPromptDeSistema({ nome: "K", perfil: "whatsapp", limitePalavras: 60, maxMensagens: 1 });
  assert.doesNotMatch(unica, /é o teto/);
});

// --- Ritmo de digitação ----------------------------------------------------

test("digitandoMs usa o ritmo configurado, com variação e limites", () => {
  const semVariacao = (r) => new BotService({ whatsapp: {}, ia: {}, conversas: {}, ritmo: r, aleatorio: () => 0.5 });

  // 200 caracteres a 45ms = 9s, limitado ao teto.
  assert.equal(semVariacao({}).digitandoMs("x".repeat(200)), 5000);
  // 60 caracteres = 2,7s, dentro da faixa.
  assert.equal(semVariacao({}).digitandoMs("x".repeat(60)), 2700);
  // Texto curto respeita o mínimo.
  assert.equal(semVariacao({}).digitandoMs("oi"), 1000);

  // A variação move o tempo para as pontas: aleatorio()=1 é +15%, 0 é -15%.
  const base = new BotService({ whatsapp: {}, ia: {}, conversas: {}, aleatorio: () => 1 });
  const menor = new BotService({ whatsapp: {}, ia: {}, conversas: {}, aleatorio: () => 0 });
  assert.equal(base.digitandoMs("x".repeat(60)), Math.round(2700 * 1.15));
  assert.equal(menor.digitandoMs("x".repeat(60)), Math.round(2700 * 0.85));

  // Ritmo pode ser sobrescrito pela configuração.
  assert.equal(semVariacao({ msPorCaractere: 10, minimoMs: 0 }).digitandoMs("x".repeat(30)), 300);
});

test("pausa entre as mensagens, mas não antes da primeira", async () => {
  const pausas = [];
  const enviadas = [];
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async (p) => enviadas.push(p.texto),
    },
    ia: { nome: "falsa", responder: async () => "Um.\n---\nDois.\n---\nTrês." },
    conversas: new MemoriaRepo({ maxHistorico: 8 }),
    prompt: { perfil: "whatsapp", maxMensagens: 3 },
    ritmo: { pausaMs: 800 },
    dormir: async (ms) => pausas.push(ms),
    logger: { log() {}, error() {} },
  });

  await bot.processarWebhook(webhook("oi"));

  assert.equal(enviadas.length, 3);
  assert.deepEqual(pausas, [800, 800]);
});

// --- Agenda (tarefas no cron) ---------------------------------------------

function montarBotDeTarefa({ resposta = "Bom dia! Bebe água 💧" } = {}) {
  const enviadas = [];
  const recebidosPelaIA = [];
  const metricas = new Metricas();
  const bot = new BotService({
    whatsapp: { nome: "falso", enviarTexto: async (p) => enviadas.push(p.texto) },
    ia: { nome: "falsa", responder: async (p) => { recebidosPelaIA.push(p.mensagens[0].content); return resposta; } },
    conversas: new MemoriaRepo({ maxHistorico: 6 }),
    prompt: { perfil: "whatsapp", maxMensagens: 3 },
    metricas,
    dormir: async () => {},
    logger: { log() {}, error() {} },
  });
  return { bot, enviadas, recebidosPelaIA, metricas };
}

const TAREFA = {
  nome: "lembrete-agua",
  cron: "0 10 * * *",
  ativa: true,
  telefones: ["5519999999999"],
  instrucao: "Lembra de beber água.",
};

test("Agenda: agenda só as tarefas válidas e ativas", () => {
  const erros = [];
  const agenda = new Agenda({
    tarefas: [
      TAREFA,
      { ...TAREFA, nome: "desativada", ativa: false },
      { ...TAREFA, nome: "cron-ruim", cron: "todo dia às 10" },
      { ...TAREFA, nome: "sem-telefone", telefones: [] },
    ],
    bot: {},
    logger: { log() {}, error: (m) => erros.push(m) },
  });

  assert.equal(agenda.iniciar(), 1);
  assert.equal(erros.length, 2); // cron inválido e falta telefone
  assert.deepEqual(
    agenda.listar().map((t) => [t.nome, t.agendada]),
    [["lembrete-agua", true], ["desativada", false], ["cron-ruim", false], ["sem-telefone", false]],
  );

  agenda.parar();
  assert.equal(agenda.listar().every((t) => !t.agendada), true);
});

test("tarefa gera mensagem sem ninguém ter perguntado", async () => {
  const { bot, enviadas, recebidosPelaIA, metricas } = montarBotDeTarefa();
  const agenda = new Agenda({ tarefas: [TAREFA], bot, logger: { log() {}, error() {} } });

  const r = await agenda.executar("lembrete-agua");

  assert.equal(r.enviada, true);
  assert.deepEqual(enviadas, ["Bom dia! Bebe água 💧"]);
  assert.equal(recebidosPelaIA[0], "Lembra de beber água.");

  // Só a resposta entra no histórico; a instrução é nossa, não da pessoa.
  const historico = await bot.conversas.historico("5519999999999");
  assert.deepEqual(historico, [{ role: "assistant", content: "Bom dia! Bebe água 💧" }]);

  assert.equal(metricas.eventos[0].tipo, "agendada");
  assert.equal(metricas.eventos[0].tarefa, "lembrete-agua");
});

test("tarefa com fonte manda os dados buscados como contexto", async () => {
  const { bot, recebidosPelaIA } = montarBotDeTarefa();
  const agenda = new Agenda({
    tarefas: [{ ...TAREFA, nome: "dolar", fonte: "https://exemplo/cotacao" }],
    bot,
    logger: { log() {}, error() {} },
  });
  agenda.buscarFonte = async () => '{"USDBRL":{"bid":"5.40"}}';

  await agenda.executar("dolar");

  assert.match(recebidosPelaIA[0], /Lembra de beber água/);
  assert.match(recebidosPelaIA[0], /recém-buscados/);
  assert.match(recebidosPelaIA[0], /5\.40/);
});

test("tarefa desconhecida falha explicitamente", async () => {
  const agenda = new Agenda({ tarefas: [TAREFA], bot: {}, logger: { log() {}, error() {} } });
  await assert.rejects(() => agenda.executar("inexistente"), /Tarefa desconhecida/);
});

// --- Horários com nome ------------------------------------------------------

test("resolverHorario compõe hora + dias", () => {
  assert.equal(resolverHorario("9_AM+EVERY_DAY"), "0 9 * * *");
  assert.equal(resolverHorario("10_PM+MONDAY_TO_FRIDAY"), "0 22 * * 1-5");
  assert.equal(resolverHorario("00_AM+WEEKEND"), "0 0 * * 0,6");
  assert.equal(resolverHorario("6_PM+SATURDAY"), "0 18 * * 6");

  // Sem dias, vale para todos.
  assert.equal(resolverHorario("7_AM"), "0 7 * * *");

  // Maiúscula, minúscula e espaços em volta do + não importam.
  assert.equal(resolverHorario(" 9_am + monday_to_friday "), "0 9 * * 1-5");

  // 12_AM é meia-noite, 12_PM é meio-dia, e 00_AM é o mesmo que 12_AM.
  assert.equal(resolverHorario("12_AM+EVERY_DAY"), "0 0 * * *");
  assert.equal(resolverHorario("12_PM+EVERY_DAY"), "0 12 * * *");
  assert.equal(resolverHorario("00_AM"), resolverHorario("12_AM"));

  // Minuto quando a hora cheia não serve.
  assert.equal(resolverHorario("08:30+MONDAY_TO_FRIDAY"), "30 8 * * 1-5");
  assert.equal(resolverHorario("7:05"), "5 7 * * *");

  // Frequências e cron cru.
  assert.equal(resolverHorario("EVERY_5_MINUTES"), "*/5 * * * *");
  assert.equal(resolverHorario("0 10,14,17 * * 1-5"), "0 10,14,17 * * 1-5");

  // O que não bate é recusado, não chutado.
  assert.equal(resolverHorario("9_AM+SEGUNDA"), null);
  assert.equal(resolverHorario("13_AM+EVERY_DAY"), null);
  assert.equal(resolverHorario("amanhã cedo"), null);
  assert.equal(resolverHorario("25:00"), null);
  assert.equal(resolverHorario(undefined), null);
});

test("descreverHorario explica o cron em português", () => {
  assert.equal(descreverHorario("0 9 * * 1-5"), "09:00, de segunda a sexta");
  assert.equal(descreverHorario("30 10 * * 0,6"), "10:30, sábado e domingo");
  assert.equal(descreverHorario("0 18 * * 6"), "18:00, sábado");
  assert.equal(descreverHorario("0 10,14,17 * * *"), "10:00, 14:00, 17:00, todos os dias");
});

test("Agenda entende horário por nome", () => {
  const agenda = new Agenda({
    tarefas: [
      { ...TAREFA, cron: "9_AM+MONDAY_TO_FRIDAY" },
      { ...TAREFA, nome: "ruim", cron: "9_AM+SEGUNDA" },
    ],
    bot: {},
    logger: { log() {}, error() {} },
  });

  assert.equal(agenda.iniciar(), 1);
  assert.equal(agenda.listar()[0].quando, "09:00, de segunda a sexta");
  agenda.parar();
});

test("Agenda.validar aponta cada problema", () => {
  const agenda = new Agenda({ tarefas: [], bot: {}, logger: { log() {}, error() {} } });

  assert.deepEqual(agenda.validar([TAREFA]), []);

  const problemas = agenda.validar([
    { ...TAREFA, nome: "" },
    { ...TAREFA, telefones: [] },
    { ...TAREFA, instrucao: " " },
    { ...TAREFA, nome: "horario-ruim", cron: "9 da manhã" },
    { ...TAREFA, nome: "fonte-ruim", fonte: "bible-api.com" },
    { ...TAREFA, nome: "lembrete-agua" },
    { ...TAREFA, nome: "lembrete-agua" },
  ]);

  assert.match(problemas.join("\n"), /falta o nome/);
  assert.match(problemas.join("\n"), /falta o telefone/);
  assert.match(problemas.join("\n"), /falta a instrução/);
  assert.match(problemas.join("\n"), /horário inválido \(9 da manhã\)/);
  assert.match(problemas.join("\n"), /fonte precisa ser uma URL/);
  assert.match(problemas.join("\n"), /nome repetido/);

  assert.deepEqual(agenda.validar("não é lista"), [
    "formato inválido: esperava uma lista de tarefas",
  ]);
});

test("Agenda.salvar grava, normaliza e reagenda", async () => {
  const caminho = `${tmpdir()}/agenda-teste-${Date.now()}.json`;
  const agenda = new Agenda({
    tarefas: [],
    bot: {},
    arquivo: caminho,
    logger: { log() {}, error() {} },
  });

  const salvas = await agenda.salvar([
    { nome: "  versiculo  ", cron: "8_AM+EVERY_DAY", ativa: true, telefones: ["+55 (19) 99999-9999"], instrucao: " manda o versículo " },
    { nome: "desligada", cron: "EVERY_HOUR", ativa: false, telefones: ["5519999999999"], instrucao: "nada" },
  ]);

  // Só a ativa vai para o cron; as duas ficam no arquivo.
  assert.deepEqual(salvas.map((t) => [t.nome, t.agendada]), [["versiculo", true], ["desligada", false]]);

  const gravado = JSON.parse(await readFile(caminho, "utf8"));
  assert.equal(gravado.tarefas.length, 2);
  // Espaços aparados e telefone só com dígitos.
  assert.equal(gravado.tarefas[0].nome, "versiculo");
  assert.deepEqual(gravado.tarefas[0].telefones, ["5519999999999"]);
  assert.equal(gravado.tarefas[0].instrucao, "manda o versículo");
  assert.equal(gravado.fusoHorario, "America/Sao_Paulo");

  agenda.parar();
  await rm(caminho, { force: true });
});

test("Agenda.salvar recusa tarefa inválida sem gravar nada", async () => {
  const caminho = `${tmpdir()}/agenda-invalida-${Date.now()}.json`;
  const agenda = new Agenda({ tarefas: [TAREFA], bot: {}, arquivo: caminho, logger: { log() {}, error() {} } });

  await assert.rejects(
    () => agenda.salvar([{ ...TAREFA, cron: "qualquer coisa" }]),
    /horário inválido/,
  );

  // Nada foi escrito e a agenda em memória continua a anterior.
  await assert.rejects(() => readFile(caminho, "utf8"), { code: "ENOENT" });
  assert.equal(agenda.tarefas[0].cron, TAREFA.cron);
});

test("decomporHorario é o caminho inverso do resolverHorario", () => {
  assert.deepEqual(decomporHorario("8_AM+EVERY_DAY"), { hora: "8_AM", dias: "EVERY_DAY" });
  assert.deepEqual(decomporHorario("10_PM+WEEKEND"), { hora: "10_PM", dias: "WEEKEND" });

  // Sem dias, assume todos; 00_AM cai no 12_AM, que é o que existe no select.
  assert.deepEqual(decomporHorario("7_AM"), { hora: "7_AM", dias: "EVERY_DAY" });
  assert.deepEqual(decomporHorario("00_AM"), { hora: "12_AM", dias: "EVERY_DAY" });

  assert.deepEqual(decomporHorario("EVERY_5_MINUTES"), { frequencia: "EVERY_5_MINUTES" });

  // O que os selects não representam vira "avançado", e o valor não se perde.
  assert.deepEqual(decomporHorario("0 10,14 * * 1-5"), { avancado: "0 10,14 * * 1-5" });
  assert.deepEqual(decomporHorario("08:30+MONDAY"), { avancado: "08:30+MONDAY" });
});

test("vocabulario traz rótulos em português, sem hora repetida", () => {
  const v = vocabulario();

  // 24 horas: 00_AM é apelido de 12_AM e fica fora da lista.
  assert.equal(v.horas.length, 24);
  assert.equal(v.horas.find((h) => h.valor === "8_AM").rotulo, "08:00 (8 AM)");
  assert.equal(v.horas.some((h) => h.valor === "00_AM"), false);

  assert.equal(v.dias.find((d) => d.valor === "MONDAY_TO_FRIDAY").rotulo, "De segunda a sexta");
  assert.equal(v.dias.find((d) => d.valor === "SATURDAY").rotulo, "Sábado");
  assert.equal(v.frequencias.find((f) => f.valor === "EVERY_HOUR").rotulo, "A cada hora");

  // Todo valor exposto no painel precisa ser resolvível de volta.
  for (const { valor } of v.frequencias) assert.ok(resolverHorario(valor));
  for (const { valor } of v.horas) assert.ok(resolverHorario(`${valor}+EVERY_DAY`));
  for (const { valor } of v.dias) assert.ok(resolverHorario(`8_AM+${valor}`));
});

test("Agenda.listar entrega o horário já decomposto para o painel", () => {
  const agenda = new Agenda({
    tarefas: [{ ...TAREFA, cron: "10_PM+WEEKEND" }],
    bot: {},
    logger: { log() {}, error() {} },
  });

  assert.deepEqual(agenda.listar()[0].horario, { hora: "10_PM", dias: "WEEKEND" });
  assert.equal(agenda.listar()[0].quando, "22:00, sábado e domingo");
});

test("o detalhe da imagem configurado chega na chamada", async () => {
  const chamadas = [];
  const montar = (imagem) =>
    new BotService({
      whatsapp: {
        nome: "falso",
        interpretarWebhook: (c) => evolution.interpretarWebhook(c),
        enviarTexto: async () => {},
        obterMidiaBase64: async () => ({ base64: "AAAA", mimetype: "image/jpeg" }),
      },
      ia: { nome: "falsa", responder: async (p) => { chamadas.push(p.mensagens.at(-1).content); return "ok"; } },
      conversas: new MemoriaRepo({ maxHistorico: 4 }),
      ...(imagem ? { imagem } : {}),
      dormir: async () => {},
      logger: { log() {}, error() {} },
    });

  await montar({ detalhe: "high" }).processarWebhook(webhookEvolutionImagem("lê o rótulo"));
  assert.equal(chamadas[0][1].image_url.detail, "high");

  await montar({ detalhe: "low" }).processarWebhook(webhookEvolutionImagem("que comida é essa?"));
  assert.equal(chamadas[1][1].image_url.detail, "low");

  // Sem configuração, "auto": deixa a OpenAI decidir pelo tamanho da imagem.
  await montar(null).processarWebhook(webhookEvolutionImagem("e isso?"));
  assert.equal(chamadas[2][1].image_url.detail, "auto");
});

// --- Vários números por tarefa ---------------------------------------------

test("normalizarTelefones aceita um, vários e string com vírgula", () => {
  assert.deepEqual(normalizarTelefones({ telefone: "5519999999999" }), ["5519999999999"]);
  assert.deepEqual(normalizarTelefones({ telefones: ["5519999999999", "5511888888888"] }), [
    "5519999999999",
    "5511888888888",
  ]);
  // Como vem do campo do painel: uma string com vírgulas e formatação.
  assert.deepEqual(normalizarTelefones({ telefones: "+55 (19) 99999-9999, 5511888888888" }), [
    "5519999999999",
    "5511888888888",
  ]);
  assert.deepEqual(normalizarTelefones({}), []);
  // telefones tem prioridade sobre o campo antigo.
  assert.deepEqual(normalizarTelefones({ telefone: "111", telefones: ["222"] }), ["222"]);
});

test("tarefa dispara para todos os números, gerando o texto uma vez", async () => {
  const enviadas = [];
  let chamadasNaIA = 0;
  const metricas = new Metricas();
  const bot = new BotService({
    whatsapp: { nome: "falso", enviarTexto: async (p) => enviadas.push([p.telefone, p.texto]) },
    ia: { nome: "falsa", responder: async () => { chamadasNaIA++; return "Bebe água 💧"; } },
    conversas: new MemoriaRepo({ maxHistorico: 6 }),
    prompt: { perfil: "whatsapp", maxMensagens: 3 },
    metricas,
    dormir: async () => {},
    logger: { log() {}, error() {} },
  });

  const agenda = new Agenda({
    tarefas: [{ ...TAREFA, telefones: ["5519999999999", "5511888888888"] }],
    bot,
    logger: { log() {}, error() {} },
  });

  await agenda.executar("lembrete-agua");

  // Uma chamada de IA, duas entregas.
  assert.equal(chamadasNaIA, 1);
  assert.deepEqual(enviadas, [
    ["5519999999999", "Bebe água 💧"],
    ["5511888888888", "Bebe água 💧"],
  ]);

  // Cada um tem seu próprio histórico.
  assert.equal((await bot.conversas.historico("5511888888888")).length, 1);
  assert.equal(metricas.eventos[0].destinos, 2);
});

test("valida cada número da lista", () => {
  const agenda = new Agenda({ tarefas: [], bot: {}, logger: { log() {}, error() {} } });

  assert.deepEqual(agenda.validar([{ ...TAREFA, telefones: ["5519999999999", "5511888888888"] }]), []);

  const problemas = agenda.validar([{ ...TAREFA, telefones: ["5519999999999", "99999"] }]);
  assert.match(problemas.join(" "), /telefone incompleto \(99999\)/);
});

// --- Custos ----------------------------------------------------------------

test("billing calcula o custo de cada operação", () => {
  // 190 tokens de entrada e 60 de saída, que é a média medida de uma resposta.
  const texto = custoDeTexto({ modelo: "gpt-4o-mini", tokensEntrada: 190, tokensSaida: 60 });
  assert.ok(texto > 0.00006 && texto < 0.00008);

  // O gpt-4o é ~16x mais caro no mesmo consumo.
  const grande = custoDeTexto({ modelo: "gpt-4o", tokensEntrada: 190, tokensSaida: 60 });
  assert.ok(grande / texto > 15);

  assert.equal(custoDeTranscricao({ modelo: "whisper-1", segundos: 60 }), 0.006);
  assert.equal(custoDeTranscricao({ modelo: "whisper-1", segundos: 30 }), 0.003);
  assert.equal(custoDeImagemGerada({ modelo: "gpt-image-1.5", qualidade: "high" }), 0.133);

  // Busca: taxa por chamada mais o bloco fixo de 8.000 tokens de entrada.
  const busca = custoDeBusca({ modelo: "gpt-4o-mini", chamadas: 1 });
  assert.ok(busca > 0.0111 && busca < 0.0113);

  // Modelo desconhecido devolve null, não zero: zero apareceria como grátis.
  assert.equal(custoDeTexto({ modelo: "modelo-que-nao-existe", tokensEntrada: 10 }), null);
  assert.equal(custoDeTranscricao({ modelo: "xxx", segundos: 10 }), null);
  assert.equal(custoDeImagemGerada({ modelo: "gpt-image-1.5", qualidade: "ultra" }), null);

  // somar ignora o que não soubemos calcular.
  assert.equal(somar(0.001, null, 0.002), 0.003);
});

test("o custo real da chamada entra nas métricas", async () => {
  const metricas = new Metricas();
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async () => {},
    },
    // Adaptador que devolve { texto, uso }, como o da OpenAI faz.
    ia: {
      nome: "falsa",
      responder: async () => ({
        texto: "oi!",
        uso: { modelo: "gpt-4o-mini", tokensEntrada: 190, tokensSaida: 60 },
      }),
    },
    conversas: new MemoriaRepo({ maxHistorico: 4 }),
    metricas,
    dormir: async () => {},
    logger: { log() {}, error() {} },
  });

  await bot.processarWebhook(webhook("oi"));

  const evento = metricas.eventos[0];
  assert.ok(evento.custoUsd > 0);
  assert.equal(metricas.resumo().custoTotalUsd, evento.custoUsd);

  // Dublê que devolve só string continua funcionando — sem custo calculado.
  const semUso = new BotService({
    whatsapp: { nome: "falso", interpretarWebhook: (c) => zapi.interpretarWebhook(c), enviarTexto: async () => {} },
    ia: { nome: "falsa", responder: async () => "texto puro" },
    conversas: new MemoriaRepo({ maxHistorico: 4 }),
    metricas: new Metricas(),
    dormir: async () => {},
    logger: { log() {}, error() {} },
  });
  const r = await semUso.processarWebhook(webhook("oi"));
  assert.equal(r.tratada, true);
  assert.equal(semUso.metricas.resumo().custoTotalUsd, null);
});

// --- RAG: chunker, base em memória e integração ----------------------------

test("chunker quebra em parágrafo, com sobreposição", () => {
  const paragrafo = (n) => `Parágrafo ${n}. `.repeat(20).trim(); // ~280 chars

  const texto = [paragrafo(1), paragrafo(2), paragrafo(3), paragrafo(4)].join("\n\n");
  const pedacos = quebrarEmPedacos(texto, { tamanho: 600, sobreposicao: 100 });

  assert.ok(pedacos.length >= 2);
  // Nenhum pedaço estoura o tamanho pedido (com folga da sobreposição).
  for (const p of pedacos) assert.ok(p.length <= 700, `pedaço com ${p.length}`);
  // Todo o conteúdo continua presente em algum pedaço.
  assert.ok(pedacos.join(" ").includes("Parágrafo 4"));

  // Texto vazio não gera pedaço nenhum.
  assert.deepEqual(quebrarEmPedacos("   "), []);

  // Parágrafo único e gigante é dividido por frase, não descartado.
  const gigante = "Frase curta. ".repeat(200);
  const divididos = quebrarEmPedacos(gigante, { tamanho: 500, sobreposicao: 0 });
  assert.ok(divididos.length > 1);
  for (const p of divididos) assert.ok(p.length <= 500);
});

// Embeddings determinísticos: vetor de 3 dimensões contando palavras-chave.
// Permite testar ordenação e limiar sem chamar a OpenAI.
const vetorizarFalso = async (textos) => ({
  vetores: textos.map((t) => {
    const minusculo = t.toLowerCase();
    return [
      (minusculo.match(/creatina/g) ?? []).length + 0.01,
      (minusculo.match(/água|agua/g) ?? []).length + 0.01,
      (minusculo.match(/treino/g) ?? []).length + 0.01,
    ];
  }),
  uso: { modelo: "falso", tokens: textos.join(" ").length },
});

const baseDeTeste = () =>
  new MemoriaBase({
    vetorizar: vetorizarFalso,
    arquivo: `${tmpdir()}/base-teste-${Date.now()}-${Math.random()}.json`,
    limiar: 0.6,
    k: 3,
    // Pedaço pequeno para o texto curto do teste render mais de um.
    pedaco: { tamanho: 45, sobreposicao: 0 },
  });

test("MemoriaBase indexa, busca por proximidade e persiste", async () => {
  const base = baseDeTeste();

  const { pedacos } = await base.indexar({
    nome: "suplementos.txt",
    texto: "Creatina aumenta força no treino.\n\nÁgua deve ser bebida ao longo do dia.",
  });
  assert.equal(pedacos, 2);

  const sobreCreatina = await base.buscar("quanto de creatina tomar?");
  assert.equal(sobreCreatina[0].documento, "suplementos.txt");
  assert.match(sobreCreatina[0].conteudo, /Creatina/);

  const sobreAgua = await base.buscar("preciso beber mais água");
  assert.match(sobreAgua[0].conteudo, /Água/);

  // Sobrevive a recarregar do arquivo.
  const outra = new MemoriaBase({ vetorizar: vetorizarFalso, arquivo: base.arquivo, limiar: 0.6 });
  assert.equal((await outra.documentos())[0].pedacos, 2);

  await rm(base.arquivo, { force: true });
});

test("o limiar corta trecho irrelevante", async () => {
  const base = baseDeTeste();
  await base.indexar({ nome: "doc.txt", texto: "Creatina creatina creatina." });

  // Pergunta do mesmo assunto passa...
  assert.equal((await base.buscar("creatina")).length, 1);
  // ...e pergunta sobre outra coisa é cortada, em vez de trazer o trecho mais
  // próximo de qualquer jeito.
  assert.equal((await base.buscar("água")).length, 0);
});

test("reindexar substitui o documento e remover apaga", async () => {
  const base = baseDeTeste();

  await base.indexar({ nome: "doc.txt", texto: "Creatina.\n\nTreino.\n\nÁgua." });
  await base.indexar({ nome: "doc.txt", texto: "Só creatina agora." });
  assert.equal((await base.documentos())[0].pedacos, 1);

  assert.equal(await base.remover("doc.txt"), 1);
  assert.deepEqual(await base.documentos(), []);
  assert.deepEqual(await base.buscar("creatina"), []);

  await rm(base.arquivo, { force: true });
});

test("BaseNula não quebra o fluxo e recusa indexação", async () => {
  const nula = new BaseNula();
  assert.deepEqual(await nula.buscar("qualquer coisa"), []);
  assert.deepEqual(await nula.documentos(), []);
  await assert.rejects(() => nula.indexar({ nome: "x", texto: "y" }), /RAG desligado/);
});

test("os trechos entram no prompt com regra de citação", () => {
  const prompt = montarPromptDeSistema({
    nome: "Kelwin",
    perfil: "whatsapp",
    limitePalavras: 60,
    trechos: [
      { conteudo: "Creatina: 3 a 5 g por dia.", documento: "manual.txt", posicao: 0, distancia: 0.1 },
    ],
  });

  assert.match(prompt, /\[1\] \(manual\.txt, parte 1\) Creatina/);
  assert.match(prompt, /cite o número entre colchetes/);
  assert.match(prompt, /não encontrou no material/);

  // Sem trechos, nada disso aparece.
  const semTrechos = montarPromptDeSistema({ nome: "Kelwin", perfil: "whatsapp", limitePalavras: 60 });
  assert.doesNotMatch(semTrechos, /base de conhecimento/);
});

test("o BotService consulta a base e sobrevive a falha dela", async () => {
  const perguntasBuscadas = [];
  const montar = (base) =>
    new BotService({
      whatsapp: {
        nome: "falso",
        interpretarWebhook: (c) => zapi.interpretarWebhook(c),
        enviarTexto: async () => {},
      },
      ia: { nome: "falsa", responder: async (p) => ({ texto: "ok", uso: null, sistema: p.sistema }) },
      conversas: new MemoriaRepo({ maxHistorico: 4 }),
      base,
      metricas: new Metricas(),
      dormir: async () => {},
      logger: { log() {}, error() {} },
    });

  const comBase = montar({
    nome: "falsa",
    buscar: async (pergunta) => {
      perguntasBuscadas.push(pergunta);
      return [{ conteudo: "trecho", documento: "d.txt", posicao: 0, distancia: 0.2 }];
    },
  });
  await comBase.processarWebhook(webhook("quanto de creatina?"));
  assert.deepEqual(perguntasBuscadas, ["quanto de creatina?"]);
  assert.equal(comBase.metricas.eventos[0].trechos, 1);

  // Base quebrada: responde sem os trechos em vez de falhar a mensagem.
  const comBaseQuebrada = montar({
    nome: "quebrada",
    buscar: async () => { throw new Error("banco fora do ar"); },
  });
  const r = await comBaseQuebrada.processarWebhook(webhook("oi"));
  assert.equal(r.tratada, true);
  assert.equal(comBaseQuebrada.metricas.eventos[0].trechos, 0);
});

// --- Formulário da loja ----------------------------------------------------

const RESPOSTAS_DA_LOJA = {
  nome: "Empório da Serra",
  ramo: "Produtos naturais",
  horarioSemana: "9h às 18h30",
  horarioDomingo: "Fechado",
  taxaEntrega: "R$ 8 em Serra Negra",
  condicoesTroca: "Só produto lacrado. Não trocamos alimento aberto.",
  perguntasFrequentes:
    "Tem sem lactose? | Sim, linha completa.\nAceitam encomenda? | Sim, com 50% de entrada.\nlinha sem separador",
};

test("resumoParaPrompt traz só os campos exatos, sem os vazios", () => {
  const resumo = resumoParaPrompt(RESPOSTAS_DA_LOJA);

  assert.match(resumo, /- Nome: Empório da Serra/);
  assert.match(resumo, /- Horário seg-sex: 9h às 18h30/);
  assert.match(resumo, /- Taxa de entrega: R\$ 8 em Serra Negra/);
  // Campo não respondido não aparece como linha vazia.
  assert.doesNotMatch(resumo, /Parcelamento/);
  // Texto corrido fica para o RAG, não para o resumo.
  assert.doesNotMatch(resumo, /lacrado/);

  assert.equal(resumoParaPrompt({}), null);
});

test("montarDocumento organiza por seção e separa cada FAQ", () => {
  const documento = montarDocumento(RESPOSTAS_DA_LOJA);

  assert.match(documento, /^# Empório da Serra/);
  assert.match(documento, /## Horários\n/);
  assert.match(documento, /Segunda a sexta: 9h às 18h30/);
  assert.match(documento, /Não trocamos alimento aberto/);

  // Cada pergunta frequente é um parágrafo próprio, que é a unidade da busca.
  assert.match(documento, /## Tem sem lactose\?\nSim, linha completa\./);
  assert.match(documento, /## Aceitam encomenda\?\nSim, com 50% de entrada\./);
  // Linha sem o separador "|" é ignorada em vez de virar lixo no documento.
  assert.doesNotMatch(documento, /linha sem separador/);

  // Seção sem nenhuma resposta não entra.
  assert.doesNotMatch(documento, /## Pagamento/);

  // Parágrafos separados por linha em branco: é como o chunker corta.
  assert.ok(documento.includes("\n\n"));
});

test("contarRespostas mede o progresso do formulário", () => {
  const { total, respondidos } = contarRespostas(RESPOSTAS_DA_LOJA);
  assert.equal(respondidos, Object.keys(RESPOSTAS_DA_LOJA).length);
  assert.ok(total > respondidos);
  assert.equal(contarRespostas({}).respondidos, 0);
});

test("perfil loja mantém o comportamento de WhatsApp e recebe os dados da loja", () => {
  const prompt = montarPromptDeSistema({
    nome: "Kelwin",
    perfil: "loja",
    limitePalavras: 60,
    maxMensagens: 3,
    loja: resumoParaPrompt(RESPOSTAS_DA_LOJA),
    trechos: [{ conteudo: "Whey a partir de R$ 119.", documento: "loja.md", posicao: 0, distancia: 0.2 }],
  });

  // Base de comportamento no WhatsApp: formatação, tamanho e quebra.
  assert.match(prompt, /Negrito com \*um asterisco\*/);
  assert.match(prompt, /No máximo 60 palavras/);
  assert.match(prompt, /O normal é UMA mensagem só/);

  // Regras de loja.
  assert.match(prompt, /Nunca invente preço, prazo, horário ou política/);
  assert.match(prompt, /ofereça chamar alguém da equipe/);

  // Dados exatos e trechos do RAG, cada um no seu bloco.
  assert.match(prompt, /Dados da loja \(use estes valores, são os oficiais\)/);
  assert.match(prompt, /- Nome: Empório da Serra/);
  assert.match(prompt, /\[1\] \(loja\.md, parte 1\) Whey/);

  // O perfil está no catálogo exposto pelo /health.
  assert.ok(perfisDisponiveis.includes("loja"));
});


// --- Várias lojas ----------------------------------------------------------

test("gerarSlug tira acento, espaço e pontuação", () => {
  assert.equal(gerarSlug("Sara Modas"), "sara-modas");
  assert.equal(gerarSlug("Empório da Serra"), "emporio-da-serra");
  assert.equal(gerarSlug("  Açaí & Cia!  "), "acai-cia");
  assert.equal(gerarSlug(""), "");
  assert.equal(nomeDoDocumento("sara-modas"), "loja-sara-modas.md");
});

test("separarPerfil identifica a loja do perfil", () => {
  assert.deepEqual(separarPerfil("loja_sara-modas"), { perfil: "loja", slug: "sara-modas" });
  assert.deepEqual(separarPerfil("loja:emporio"), { perfil: "loja", slug: "emporio" });
  // Perfis comuns passam intactos.
  assert.deepEqual(separarPerfil("whatsapp"), { perfil: "whatsapp", slug: null });
  assert.deepEqual(separarPerfil("loja"), { perfil: "loja", slug: null });
});

const lojasDeTeste = () => {
  const base = baseDeTeste();
  const pasta = `${tmpdir()}/lojas-teste-${Date.now()}-${Math.random()}`;
  return { base, lojas: new Lojas({ pasta, base, logger: { log() {}, error() {} } }) };
};

test("cada cadastro cria uma loja, um perfil e um documento próprio", async () => {
  const { base, lojas } = lojasDeTeste();

  const sara = await lojas.salvar({
    respostas: { nome: "Sara Modas", ramo: "Roupas femininas", horarioSemana: "9h às 17h" },
  });
  const serra = await lojas.salvar({
    respostas: { nome: "Empório da Serra", ramo: "Produtos naturais", horarioSemana: "9h às 18h30" },
  });

  // O slug (e o perfil) sai do nome.
  assert.equal(sara.slug, "sara-modas");
  assert.equal(sara.perfil, "loja_sara-modas");
  assert.equal(serra.perfil, "loja_emporio-da-serra");

  // Um documento por loja, nenhum sobrescrevendo o outro.
  const documentos = (await base.documentos()).map((d) => d.nome).sort();
  assert.deepEqual(documentos, ["loja-emporio-da-serra.md", "loja-sara-modas.md"]);

  const listadas = await lojas.listar();
  assert.deepEqual(listadas.map((l) => l.perfil), ["loja_emporio-da-serra", "loja_sara-modas"]);
  assert.equal(listadas[1].progresso.respondidos, 3);

  const obtida = await lojas.obter("sara-modas");
  assert.match(obtida.resumo, /- Nome: Sara Modas/);
  assert.equal(obtida.documento, "loja-sara-modas.md");
  assert.equal(await lojas.obter("nao-existe"), null);

  await rm(lojas.pasta, { recursive: true, force: true });
  await rm(base.arquivo, { force: true });
});

test("salvar de novo atualiza a loja em vez de duplicar", async () => {
  const { base, lojas } = lojasDeTeste();

  await lojas.salvar({ respostas: { nome: "Sara Modas", horarioSemana: "9h às 17h" } });
  await lojas.salvar({ slug: "sara-modas", respostas: { nome: "Sara Modas", horarioSemana: "10h às 19h" } });

  assert.equal((await lojas.listar()).length, 1);
  assert.match((await lojas.obter("sara-modas")).resumo, /10h às 19h/);
  assert.equal((await base.documentos()).length, 1);

  await rm(lojas.pasta, { recursive: true, force: true });
  await rm(base.arquivo, { force: true });
});

test("remover apaga as respostas e o documento da base", async () => {
  const { base, lojas } = lojasDeTeste();
  await lojas.salvar({ respostas: { nome: "Sara Modas", ramo: "Roupas" } });

  const resultado = await lojas.remover("sara-modas");
  assert.equal(resultado.removida, true);
  assert.ok(resultado.pedacos > 0);

  // Documento fora da base: senão o bot responderia por uma loja que não existe.
  assert.deepEqual(await base.documentos(), []);
  assert.deepEqual(await lojas.listar(), []);
  assert.deepEqual(await lojas.remover("sara-modas"), { removida: false });

  await rm(lojas.pasta, { recursive: true, force: true });
  await rm(base.arquivo, { force: true });
});

test("a busca fica restrita ao documento da loja", async () => {
  const { base, lojas } = lojasDeTeste();
  await lojas.salvar({ respostas: { nome: "Uma", condicoesTroca: "creatina creatina creatina" } });
  await lojas.salvar({ respostas: { nome: "Outra", condicoesTroca: "creatina creatina creatina" } });

  // Sem filtro, a busca vê as duas lojas — é justamente o vazamento a evitar.
  const semFiltro = await base.buscar("creatina", 10);
  assert.ok(new Set(semFiltro.map((t) => t.documento)).size > 1);

  const soDeUma = await base.buscar("creatina", 10, { documentos: ["loja-uma.md"] });
  assert.ok(soDeUma.length > 0);
  assert.ok(soDeUma.every((t) => t.documento === "loja-uma.md"));

  // Documento inexistente não vaza resultado de outro.
  assert.deepEqual(await base.buscar("creatina", 5, { documentos: ["loja-fantasma.md"] }), []);

  await rm(lojas.pasta, { recursive: true, force: true });
  await rm(base.arquivo, { force: true });
});

test("o BotService resolve a loja do perfil ativo", async () => {
  const { base, lojas } = lojasDeTeste();
  await lojas.salvar({ respostas: { nome: "Sara Modas", horarioSemana: "9h às 17h" } });

  const erros = [];
  const montar = (perfil) =>
    new BotService({
      whatsapp: { nome: "falso", enviarTexto: async () => {} },
      ia: { nome: "falsa", responder: async () => "ok" },
      conversas: new MemoriaRepo({ maxHistorico: 4 }),
      base,
      lojas,
      prompt: { perfil },
      dormir: async () => {},
      logger: { log() {}, error: (m) => erros.push(m) },
    });

  const daSara = await montar("loja_sara-modas").lojaAtiva();
  assert.match(daSara.resumo, /- Nome: Sara Modas/);
  assert.deepEqual(daSara.documentos, ["loja-sara-modas.md"]);

  // Perfil sem loja: nada de dados de loja, e busca na base inteira.
  const semLoja = await montar("whatsapp").lojaAtiva();
  assert.equal(semLoja.resumo, null);
  assert.equal(semLoja.documentos, undefined);

  // Perfil apontando para loja que não existe: avisa no log e não vaza outra
  // loja no escopo da busca.
  const fantasma = await montar("loja_nao-cadastrada").lojaAtiva();
  assert.equal(fantasma.resumo, null);
  assert.deepEqual(fantasma.documentos, ["loja-nao-cadastrada.md"]);
  assert.match(erros.join(" "), /não cadastrada/);

  await rm(lojas.pasta, { recursive: true, force: true });
  await rm(base.arquivo, { force: true });
});

// --- Apresentação na primeira mensagem -------------------------------------

test("apresentacaoDaLoja junta nome, atendente e saudação", () => {
  assert.deepEqual(
    apresentacaoDaLoja({ nome: "Sara Modas", nomeAtendente: "Sarinha", saudacao: "Oi! Sou a Sarinha 💜" }),
    { loja: "Sara Modas", atendente: "Sarinha", saudacao: "Oi! Sou a Sarinha 💜" },
  );

  // Só o nome da loja já basta para se apresentar.
  assert.deepEqual(apresentacaoDaLoja({ nome: "Sara Modas" }), {
    loja: "Sara Modas",
    atendente: null,
    saudacao: null,
  });

  assert.equal(apresentacaoDaLoja({}), null);
});

test("o bloco de apresentação só entra quando pedido", () => {
  const comum = { nome: "Kelwin", perfil: "loja", limitePalavras: 60 };

  const primeira = montarPromptDeSistema({
    ...comum,
    apresentar: { loja: "Sara Modas", atendente: "Sarinha", saudacao: "Oi! Sou a Sarinha 💜" },
  });
  assert.match(primeira, /PRIMEIRA mensagem desta conversa/);
  assert.match(primeira, /como Sarinha da Sara Modas/);
  assert.match(primeira, /Oi! Sou a Sarinha 💜/);
  assert.match(primeira, /Não se apresente de novo/);

  // Mensagem seguinte: nada de apresentação.
  assert.doesNotMatch(montarPromptDeSistema(comum), /PRIMEIRA mensagem/);
});

test("o bot se apresenta uma vez por conversa, e por contato", async () => {
  const { base, lojas } = lojasDeTeste();
  await lojas.salvar({
    respostas: { nome: "Sara Modas", nomeAtendente: "Sarinha", saudacao: "Oi! Sou a Sarinha 💜" },
  });

  const prompts = [];
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async () => {},
    },
    ia: { nome: "falsa", responder: async (p) => { prompts.push(p.sistema); return "ok"; } },
    conversas: new MemoriaRepo({ maxHistorico: 6 }),
    base,
    lojas,
    prompt: { perfil: "loja_sara-modas", limitePalavras: 60 },
    dormir: async () => {},
    logger: { log() {}, error() {} },
  });

  await bot.processarWebhook(webhook("oi"));
  await bot.processarWebhook(webhook("vocês entregam?"));

  assert.match(prompts[0], /PRIMEIRA mensagem desta conversa/);
  assert.doesNotMatch(prompts[1], /PRIMEIRA mensagem/);

  // Outro contato começa a própria conversa, então se apresenta de novo.
  await bot.processarWebhook({ ...webhook("bom dia"), phone: "5511988887777" });
  assert.match(prompts[2], /PRIMEIRA mensagem desta conversa/);

  await rm(lojas.pasta, { recursive: true, force: true });
  await rm(base.arquivo, { force: true });
});

// --- Atendimento humano (handoff) ------------------------------------------

test("ControleDeAtendimento pausa, expira e retoma", async () => {
  let agora = 0;
  const controle = new ControleDeAtendimento({ minutosPadrao: 30, agora: () => agora });

  assert.equal(await controle.estaPausado("551"), false);

  await controle.pausar("551");
  assert.equal(await controle.estaPausado("551"), true);
  assert.equal((await controle.listar())[0].minutosRestantes, 30);

  // 29 minutos depois ainda está pausado; 31, não.
  agora = 29 * 60_000;
  assert.equal(await controle.estaPausado("551"), true);
  agora = 31 * 60_000;
  assert.equal(await controle.estaPausado("551"), false);
  // A pausa expirada sai do mapa na leitura, sem rotina de varredura.
  assert.deepEqual(await controle.listar(), []);

  // Sem prazo: fica até alguém retomar.
  await controle.pausar("552", null);
  agora = 999 * 60_000;
  assert.equal(await controle.estaPausado("552"), true);
  assert.equal((await controle.listar())[0].minutosRestantes, null);
  assert.equal(await controle.retomar("552"), true);
  assert.equal(await controle.estaPausado("552"), false);
});

test("IdsEnviados reconhece o que o bot mandou, e esquece o antigo", () => {
  let agora = 0;
  const ids = new IdsEnviados({ validadeMs: 60_000, agora: () => agora });

  ids.registrar("ABC");
  assert.equal(ids.contem("ABC"), true);
  assert.equal(ids.contem("XYZ"), false);
  assert.equal(ids.contem(null), false);

  agora = 61_000;
  assert.equal(ids.contem("ABC"), false);
});

function montarBotComHandoff() {
  const enviadas = [];
  let proximoId = 1;
  const metricas = new Metricas();
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      // Devolve id como os adaptadores de verdade fazem.
      enviarTexto: async (p) => {
        const id = `BOT${proximoId++}`;
        enviadas.push({ ...p, id });
        return { id };
      },
    },
    ia: { nome: "falsa", responder: async () => "resposta do bot" },
    conversas: new MemoriaRepo({ maxHistorico: 6 }),
    metricas,
    dormir: async () => {},
    logger: { log() {}, error() {} },
  });
  return { bot, enviadas, metricas };
}

test("resposta humana pelo celular pausa o bot naquela conversa", async () => {
  const { bot, enviadas, metricas } = montarBotComHandoff();

  await bot.processarWebhook(webhook("oi"));
  assert.equal(enviadas.length, 1);

  // O eco da própria mensagem do bot não pode pausá-lo.
  const eco = { ...webhook("resposta do bot", { fromMe: true }), messageId: enviadas[0].id };
  const r1 = await bot.processarWebhook(eco);
  assert.match(r1.motivo, /próprio bot/);
  assert.equal(await bot.atendimento.estaPausado("5519999999999"), false);

  // Agora uma mensagem fromMe com id desconhecido: foi digitada no celular.
  const r2 = await bot.processarWebhook({
    ...webhook("oi, aqui é a Sara, vou te ajudar", { fromMe: true }),
    messageId: "DIGITADA_NO_CELULAR",
  });
  assert.match(r2.motivo, /humano assumiu/);
  assert.equal(await bot.atendimento.estaPausado("5519999999999"), true);
  assert.equal(metricas.eventos[0].tipo, "pausada");

  // Cliente escreve de novo: o bot não responde.
  const r3 = await bot.processarWebhook(webhook("e tem no tamanho M?"));
  assert.equal(r3.tratada, false);
  assert.match(r3.motivo, /atendimento humano/);
  assert.equal(enviadas.length, 1); // nada novo foi enviado

  // Outra conversa segue normal: a pausa é por contato.
  await bot.processarWebhook({ ...webhook("oi"), phone: "5511988887777" });
  assert.equal(enviadas.length, 2);

  // Depois de retomar, volta a responder.
  await bot.atendimento.retomar("5519999999999");
  await bot.processarWebhook(webhook("ainda está aí?"));
  assert.equal(enviadas.length, 3);
});

test("comandoDoDono reconhece só os comandos", () => {
  assert.equal(comandoDoDono("#pausar"), "pausar");
  assert.equal(comandoDoDono("#PAUSA"), "pausar");
  assert.equal(comandoDoDono("#assumir"), "pausar");
  assert.equal(comandoDoDono("#voltar"), "retomar");
  assert.equal(comandoDoDono("#bot"), "retomar");
  // Conversa normal não vira comando.
  assert.equal(comandoDoDono("vou pausar o pedido"), null);
  assert.equal(comandoDoDono("#pausar por favor"), null);
  assert.equal(comandoDoDono(""), null);
});

test("#pausar e #voltar controlam a conversa pelo próprio chat", async () => {
  const { bot, enviadas, metricas } = montarBotComHandoff();

  await bot.processarWebhook({ ...webhook("#pausar", { fromMe: true }), messageId: "CMD1" });
  assert.equal(await bot.atendimento.estaPausado("5519999999999"), true);
  // Sem prazo: não expira sozinho.
  assert.equal((await bot.atendimento.listar())[0].minutosRestantes, null);

  await bot.processarWebhook(webhook("tem no tamanho M?"));
  assert.equal(enviadas.length, 0);

  await bot.processarWebhook({ ...webhook("#voltar", { fromMe: true }), messageId: "CMD2" });
  assert.equal(await bot.atendimento.estaPausado("5519999999999"), false);

  await bot.processarWebhook(webhook("tem no tamanho M?"));
  assert.equal(enviadas.length, 1);

  // Mais recente primeiro: a mensagem que chegou durante a pausa entra como
  // ignorada.
  assert.deepEqual(metricas.eventos.map((e) => e.tipo), [
    "respondida",
    "retomada",
    "ignorada",
    "pausada",
  ]);
});

test("o marcador [HUMANO] pausa, avisa a equipe e não vaza para o cliente", async () => {
  const enviadas = [];
  const metricas = new Metricas();
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async (p) => { enviadas.push(p); return { id: `ID${enviadas.length}` }; },
    },
    ia: {
      nome: "falsa",
      responder: async () => "Vou chamar alguém da equipe pra te ajudar com isso. [HUMANO]",
    },
    conversas: new MemoriaRepo({ maxHistorico: 6 }),
    metricas,
    avisarEm: "5511977776666",
    dormir: async () => {},
    logger: { log() {}, error() {} },
  });

  await bot.processarWebhook(webhook("o pedido chegou errado, quero reclamar"));

  // Cliente recebe a mensagem sem o marcador.
  const paraCliente = enviadas.find((e) => e.telefone === "5519999999999");
  assert.equal(paraCliente.texto, "Vou chamar alguém da equipe pra te ajudar com isso.");
  assert.doesNotMatch(paraCliente.texto, /HUMANO/);

  // Equipe recebe o aviso com o contexto.
  const paraEquipe = enviadas.find((e) => e.telefone === "5511977776666");
  assert.match(paraEquipe.texto, /Atendimento pedido por Kelwin \(5519999999999\)/);
  assert.match(paraEquipe.texto, /o pedido chegou errado/);

  // E a conversa fica pausada até alguém retomar.
  assert.equal(await bot.atendimento.estaPausado("5519999999999"), true);
  const pausa = metricas.eventos.find((e) => e.tipo === "pausada");
  assert.equal(pausa.motivo, "bot encaminhou para uma pessoa (equipe avisada)");

  await bot.processarWebhook(webhook("alô?"));
  assert.equal(enviadas.filter((e) => e.telefone === "5519999999999").length, 1);
});

test("normalizarTelefone acrescenta o DDI quando falta", () => {
  // Celular e fixo sem DDI ganham o 55 — é o que faz a conversa casar.
  assert.equal(normalizarTelefone("(19) 99372-3677"), "5519993723677");
  assert.equal(normalizarTelefone("1938661234"), "551938661234");

  // Já com DDI, passa intacto.
  assert.equal(normalizarTelefone("5519993723677"), "5519993723677");
  assert.equal(normalizarTelefone("+55 (19) 99372-3677"), "5519993723677");

  // Número de outro país não é adulterado.
  assert.equal(normalizarTelefone("14155552671"), "5514155552671"); // 11 dígitos: vira BR
  assert.equal(normalizarTelefone("442071234567"), "442071234567"); // 12: intacto

  assert.equal(normalizarTelefone(""), "");
  assert.equal(normalizarTelefone(undefined), "");
});

test("a agenda também normaliza o DDI dos destinos", () => {
  assert.deepEqual(normalizarTelefones({ telefones: ["(19) 99372-3677", "5511988887777"] }), [
    "5519993723677",
    "5511988887777",
  ]);
  assert.deepEqual(normalizarTelefones({ telefone: "19 99372-3677" }), ["5519993723677"]);
});

// --- Troca de perfil em execução -------------------------------------------

test("trocar o perfil muda a resposta seguinte, sem recriar o bot", async () => {
  const { base, lojas } = lojasDeTeste();
  await lojas.salvar({ respostas: { nome: "Sara Modas", horarioSemana: "9h às 17h" } });

  const prompts = [];
  const prompt = { perfil: "loja_sara-modas", limitePalavras: 60 };
  const bot = new BotService({
    whatsapp: {
      nome: "falso",
      interpretarWebhook: (c) => zapi.interpretarWebhook(c),
      enviarTexto: async () => ({ id: "X" }),
    },
    ia: { nome: "falsa", responder: async (p) => { prompts.push(p.sistema); return "ok"; } },
    conversas: new MemoriaRepo({ maxHistorico: 6 }),
    base,
    lojas,
    prompt,
    dormir: async () => {},
    logger: { log() {}, error() {} },
  });

  await bot.processarWebhook(webhook("qual o horário?"));
  assert.match(prompts[0], /Dados da loja/);
  assert.match(prompts[0], /Sara Modas/);

  // É o mesmo objeto de prompt que a rota do painel altera.
  prompt.perfil = "puro";
  await bot.processarWebhook({ ...webhook("qual o horário?"), phone: "5511911112222" });
  // Perfil puro não manda instrução nenhuma.
  assert.equal(prompts[1], null);

  prompt.perfil = "whatsapp";
  await bot.processarWebhook({ ...webhook("oi"), phone: "5511933334444" });
  assert.match(prompts[2], /português do Brasil/);
  assert.doesNotMatch(prompts[2], /Dados da loja/);

  await rm(lojas.pasta, { recursive: true, force: true });
  await rm(base.arquivo, { force: true });
});

test("preferências sobrevivem ao restart", async () => {
  const arquivo = `${tmpdir()}/pref-teste-${Date.now()}.json`;

  // Arquivo inexistente não é erro: o .env continua valendo.
  assert.deepEqual(carregarPreferencias(arquivo), {});

  await salvarPreferencias(arquivo, { perfil: "loja_sara-modas" });
  assert.deepEqual(carregarPreferencias(arquivo), { perfil: "loja_sara-modas" });

  await rm(arquivo, { force: true });
});

// --- Histórico em Postgres -------------------------------------------------

// Pool falso: registra as consultas e devolve o que o teste mandar. Permite
// verificar a forma do SQL sem subir banco.
function poolFalso(resultados = []) {
  const consultas = [];
  return {
    consultas,
    query: async (texto, valores) => {
      consultas.push({ texto: texto.replace(/\s+/g, " ").trim(), valores });
      return resultados.shift() ?? { rows: [] };
    },
    end: async () => {},
  };
}

test("PostgresRepo lê as últimas mensagens em ordem cronológica", async () => {
  const pool = poolFalso([
    { rows: [{ papel: "user", conteudo: "oi" }, { papel: "assistant", conteudo: "olá!" }] },
  ]);
  const repo = new PostgresRepo({ pool, maxHistorico: 10 });

  const historico = await repo.historico("5519993723677");

  assert.deepEqual(historico, [
    { role: "user", content: "oi" },
    { role: "assistant", content: "olá!" },
  ]);

  // Busca as N mais recentes, mas devolve da mais antiga para a mais nova.
  const { texto, valores } = pool.consultas[0];
  assert.match(texto, /ORDER BY id DESC LIMIT \$2/);
  assert.match(texto, /ORDER BY id ASC/);
  assert.deepEqual(valores, ["5519993723677", 10]);
});

test("PostgresRepo grava e apaga por telefone", async () => {
  const pool = poolFalso();
  const repo = new PostgresRepo({ pool, maxHistorico: 10 });

  await repo.acrescentar("551", { role: "user", content: "oi" });
  assert.match(pool.consultas[0].texto, /INSERT INTO conversas/);
  assert.deepEqual(pool.consultas[0].valores, ["551", "user", "oi"]);

  await repo.limpar("551");
  assert.match(pool.consultas[1].texto, /DELETE FROM conversas WHERE telefone = \$1/);

  // Sem url e sem pool não sobe: erro de configuração aparece na subida.
  assert.throws(() => new PostgresRepo({}), /DATABASE_URL/);
});

test("o bot lembra da conversa entre reinícios quando o histórico é persistido", async () => {
  // Simula dois processos diferentes compartilhando o mesmo armazenamento.
  const guardado = [];
  const repoPersistente = () => ({
    nome: "falso-persistente",
    historico: async () => [...guardado],
    acrescentar: async (_t, m) => guardado.push(m),
    limpar: async () => {},
  });

  const prompts = [];
  const criarBot = () =>
    new BotService({
      whatsapp: {
        nome: "falso",
        interpretarWebhook: (c) => zapi.interpretarWebhook(c),
        enviarTexto: async () => ({ id: "X" }),
      },
      ia: { nome: "falsa", responder: async (p) => { prompts.push(p.sistema); return "ok"; } },
      conversas: repoPersistente(),
      prompt: { perfil: "whatsapp", limitePalavras: 60 },
      dormir: async () => {},
      logger: { log() {}, error() {} },
    });

  await criarBot().processarWebhook(webhook("oi"));
  // "Reinicia": bot novo, mesmo armazenamento.
  await criarBot().processarWebhook(webhook("e o horário?"));

  assert.equal(guardado.length, 4); // 2 perguntas + 2 respostas
  // Com o histórico preservado, a segunda mensagem não é tratada como a
  // primeira da conversa — que é o que fazia o bot se apresentar de novo.
  assert.equal(prompts.length, 2);
});

test("PostgresAtendimento calcula o prazo no banco", async () => {
  const pool = poolFalso([
    { rows: [{ expira_em: new Date("2026-01-01T10:30:00Z") }] },
    { rows: [{ expira_em: null }] },
  ]);
  const controle = new PostgresAtendimento({ pool });

  const comPrazo = await controle.pausar("551", 30);
  assert.deepEqual(comPrazo, { telefone: "551", expiraEm: new Date("2026-01-01T10:30:00Z") });
  // O prazo sai de now() do banco, não do relógio do processo.
  assert.match(pool.consultas[0].texto, /now\(\) \+ \(\$2 \* INTERVAL '1 minute'\)/);
  assert.match(pool.consultas[0].texto, /ON CONFLICT \(telefone\) DO UPDATE/);

  // Pausa sem prazo guarda NULL.
  const semPrazo = await controle.pausar("551", null);
  assert.equal(semPrazo.expiraEm, null);
  assert.deepEqual(pool.consultas[1].valores, ["551", null]);
});

test("PostgresAtendimento considera expirada a pausa vencida", async () => {
  const pool = poolFalso([{ rows: [] }, { rows: [{ expira_em: null }] }]);
  const controle = new PostgresAtendimento({ pool });

  assert.equal(await controle.estaPausado("551"), false);
  // O filtro de validade está na consulta, não no código.
  assert.match(pool.consultas[0].texto, /expira_em IS NULL OR expira_em > now\(\)/);

  assert.equal(await controle.estaPausado("551"), true);
  assert.throws(() => new PostgresAtendimento({}), /DATABASE_URL/);
});
