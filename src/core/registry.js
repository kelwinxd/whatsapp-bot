import { ZapiAdapter } from "../adapters/whatsapp/ZapiAdapter.js";
import { EvolutionAdapter } from "../adapters/whatsapp/EvolutionAdapter.js";
import { OpenAIAdapter } from "../adapters/ia/OpenAIAdapter.js";
import { MemoriaRepo } from "../adapters/conversas/MemoriaRepo.js";
import { PostgresRepo } from "../adapters/conversas/PostgresRepo.js";
import { MemoriaBase, BaseNula } from "../adapters/base/MemoriaBase.js";
import { ControleDeAtendimento } from "./atendimento.js";
import { PostgresAtendimento } from "../adapters/atendimento/PostgresAtendimento.js";
import { ArquivoLojas } from "../adapters/lojas/ArquivoLojas.js";
import { PostgresLojas } from "../adapters/lojas/PostgresLojas.js";
import { ArquivoAgenda } from "../adapters/agenda/ArquivoAgenda.js";
import { PostgresAgenda } from "../adapters/agenda/PostgresAgenda.js";
import { ArquivoPreferencias } from "../adapters/preferencias/ArquivoPreferencias.js";
import { PostgresPreferencias } from "../adapters/preferencias/PostgresPreferencias.js";

// Strategy: cada porta tem um catálogo de implementações, e a escolha vem da
// configuração. Adicionar um provedor novo (Baileys direto, Twilio, Anthropic,
// Redis...) é escrever o adaptador e acrescentar uma linha no catálogo — o
// resto do projeto continua igual.

const whatsapp = {
  zapi: (config) => new ZapiAdapter(config.zapi),
  evolution: (config) => new EvolutionAdapter(config.evolution),
};

const ia = {
  openai: (config) => new OpenAIAdapter(config.openai),
};

const conversas = {
  memoria: (config) => new MemoriaRepo(config.conversa),
  postgres: (config) =>
    new PostgresRepo({ url: config.banco.url, maxHistorico: config.conversa.maxHistorico }),
};

// A base recebe o vetorizador do adaptador de IA já escolhido: ela não sabe
// (nem precisa saber) quem gera embedding.
const base = {
  nenhum: () => new BaseNula(),
  memoria: (config, { ia }) =>
    new MemoriaBase({
      vetorizar: (textos) => ia.vetorizar(textos),
      arquivo: config.rag.arquivo,
      limiar: config.rag.limiar,
      k: config.rag.trechos,
      pedaco: config.rag.pedaco,
    }),
};

const atendimento = {
  memoria: () => new ControleDeAtendimento(),
  postgres: (config) => new PostgresAtendimento({ url: config.banco.url }),
};

// Lojas, agenda e preferências andam juntas: são a configuração de operação.
const lojas = {
  arquivo: (config) => new ArquivoLojas({ pasta: config.lojas.pasta }),
  postgres: (config) => new PostgresLojas({ url: config.banco.url }),
};

const agenda = {
  arquivo: (config) =>
    new ArquivoAgenda({ arquivo: config.agenda.arquivo, fusoHorario: config.agenda.fusoHorario }),
  postgres: (config) => new PostgresAgenda({ url: config.banco.url }),
};

const preferencias = {
  arquivo: (config) => new ArquivoPreferencias({ arquivo: config.preferenciasArquivo }),
  postgres: (config) => new PostgresPreferencias({ url: config.banco.url }),
};

function escolher(catalogo, chave, rotulo, config, extras) {
  const criar = catalogo[chave];
  if (!criar) {
    const opcoes = Object.keys(catalogo).join(", ");
    throw new Error(`Provedor de ${rotulo} desconhecido: "${chave}". Opções: ${opcoes}`);
  }
  return criar(config, extras);
}

// Monta todas as dependências de uma vez, na subida do servidor. Quem recebe
// esse objeto (o serviço do bot) não sabe qual implementação chegou.
export function montarDependencias(config) {
  const provedorIA = escolher(ia, config.provedores.ia, "IA", config);

  return {
    whatsapp: escolher(whatsapp, config.provedores.whatsapp, "WhatsApp", config),
    ia: provedorIA,
    conversas: escolher(conversas, config.provedores.historico, "histórico", config),
    base: escolher(base, config.rag.provedor, "RAG", config, { ia: provedorIA }),
    atendimento: escolher(atendimento, config.provedores.pausas, "pausas", config),
    lojas: escolher(lojas, config.provedores.estado, "lojas", config),
    agenda: escolher(agenda, config.provedores.estado, "agenda", config),
    preferencias: escolher(preferencias, config.provedores.estado, "preferências", config),
  };
}
