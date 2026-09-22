import { ZapiAdapter } from "../adapters/whatsapp/ZapiAdapter.js";
import { EvolutionAdapter } from "../adapters/whatsapp/EvolutionAdapter.js";
import { OpenAIAdapter } from "../adapters/ia/OpenAIAdapter.js";
import { MemoriaRepo } from "../adapters/conversas/MemoriaRepo.js";

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
};

function escolher(catalogo, chave, rotulo, config) {
  const criar = catalogo[chave];
  if (!criar) {
    const opcoes = Object.keys(catalogo).join(", ");
    throw new Error(`Provedor de ${rotulo} desconhecido: "${chave}". Opções: ${opcoes}`);
  }
  return criar(config);
}

// Monta todas as dependências de uma vez, na subida do servidor. Quem recebe
// esse objeto (o serviço do bot) não sabe qual implementação chegou.
export function montarDependencias(config) {
  return {
    whatsapp: escolher(whatsapp, config.provedores.whatsapp, "WhatsApp", config),
    ia: escolher(ia, config.provedores.ia, "IA", config),
    conversas: escolher(conversas, config.provedores.historico, "histórico", config),
  };
}
