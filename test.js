import test from "node:test";
import assert from "node:assert/strict";
import { ZapiAdapter } from "./src/adapters/whatsapp/ZapiAdapter.js";
import { EvolutionAdapter } from "./src/adapters/whatsapp/EvolutionAdapter.js";
import { MemoriaRepo } from "./src/adapters/conversas/MemoriaRepo.js";
import { BotService } from "./src/core/BotService.js";
import { montarPromptDeSistema } from "./src/core/prompt.js";

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
