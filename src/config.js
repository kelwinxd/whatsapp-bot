import "dotenv/config";

// Ponto único de leitura de variáveis de ambiente. Nenhum outro arquivo lê
// process.env: assim dá para ver de relance tudo que o projeto precisa, e
// trocar a origem da configuração (arquivo, cofre de segredos) num lugar só.

export const config = {
  porta: Number(process.env.PORT ?? 3000),

  // Qual implementação de cada porta usar. É aqui que se troca de tecnologia.
  provedores: {
    whatsapp: process.env.WHATSAPP_PROVIDER ?? "zapi", // zapi | evolution
    ia: process.env.AI_PROVIDER ?? "openai",
    historico: process.env.HISTORY_STORE ?? "memoria",
  },

  zapi: {
    instanceId: process.env.ZAPI_INSTANCE_ID,
    instanceToken: process.env.ZAPI_INSTANCE_TOKEN,
    clientToken: process.env.ZAPI_CLIENT_TOKEN,
  },

  evolution: {
    baseUrl: process.env.EVOLUTION_BASE_URL,
    instancia: process.env.EVOLUTION_INSTANCE,
    apiKey: process.env.EVOLUTION_API_KEY,
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    modelo: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    // Rede de segurança, não controle de tamanho: quem dá forma à resposta é
    // a instrução no prompt. Aqui, folga suficiente para o limite de palavras
    // caber sem a frase ser cortada no meio.
    maxTokens: Number(process.env.OPENAI_MAX_TOKENS ?? 300),
    // whisper-1 custa US$ 0,006/min; gpt-4o-mini-transcribe, metade disso.
    modeloTranscricao: process.env.OPENAI_TRANSCRIBE_MODEL ?? "whisper-1",
  },

  // Número usado nos testes manuais de envio (npm run enviar). Fica no .env
  // para não versionar telefone de ninguém.
  numeroTeste: process.env.NUMBER_TEST,

  conversa: {
    // Mensagens guardadas por contato (usuário + bot somados).
    maxHistorico: Number(process.env.MAX_HISTORICO ?? 10),
  },

  prompt: {
    // suplementos | whatsapp | puro (ver src/core/prompt.js)
    perfil: process.env.PROMPT_PERFIL ?? "suplementos",
    // Tamanho pedido no prompt. 0 desliga a instrução de brevidade.
    limitePalavras: Number(process.env.RESPOSTA_MAX_PALAVRAS ?? 60) || null,
    // Quantas mensagens o bot pode mandar por resposta (1 = mensagem única).
    maxMensagens: Number(process.env.RESPOSTA_MAX_MENSAGENS ?? 3),
    // Texto próprio; quando preenchido, ignora o perfil.
    textoCustomizado: process.env.SYSTEM_PROMPT,
  },
};

// Falha na inicialização, não na primeira mensagem: um erro de configuração
// aparece quando você sobe o servidor, e não no meio de uma conversa real.
export function exigirVariaveis(nomes, valores) {
  const faltando = nomes.filter((n) => !valores[n]);
  if (faltando.length > 0) {
    throw new Error(`Variáveis de ambiente faltando: ${faltando.join(", ")}`);
  }
}
