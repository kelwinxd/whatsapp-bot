import test from "node:test";
import assert from "node:assert/strict";
import { ZapiAdapter } from "./src/adapters/whatsapp/ZapiAdapter.js";
import { EvolutionAdapter } from "./src/adapters/whatsapp/EvolutionAdapter.js";
import { MemoriaRepo } from "./src/adapters/conversas/MemoriaRepo.js";
import { BotService } from "./src/core/BotService.js";
import { montarPromptDeSistema } from "./src/core/prompt.js";
import { Metricas } from "./src/core/Metricas.js";

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

  const semBruto = ({ bruto, ...resto }) => resto;
  assert.deepEqual(semBruto(daZapi), semBruto(daEvolution));
  assert.equal(daZapi.telefone, "5519999999999");
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
  assert.ok(enviadas[0].digitandoMs >= 1000);

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

test("áudio recebe aviso e não gasta chamada de IA", async () => {
  const { bot, enviadas, recebidosPelaIA } = montarBotComMidia();

  const r = await bot.processarWebhook({
    event: "messages.upsert",
    data: {
      key: { remoteJid: "5519999999999@s.whatsapp.net", fromMe: false },
      pushName: "Kelwin",
      message: { audioMessage: { mimetype: "audio/ogg" } },
    },
  });

  assert.equal(r.tratada, false);
  assert.match(r.motivo, /áudio|audio/);
  assert.equal(recebidosPelaIA.length, 0);
  assert.match(enviadas[0].texto, /ouvir áudio/);
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
