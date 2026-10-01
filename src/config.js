import "dotenv/config";
import { readFileSync } from "node:fs";
import { carregarPreferencias } from "./core/preferencias.js";

// Ponto único de leitura de variáveis de ambiente. Nenhum outro arquivo lê
// process.env: assim dá para ver de relance tudo que o projeto precisa, e
// trocar a origem da configuração (arquivo, cofre de segredos) num lugar só.

// Tarefas agendadas ficam num JSON à parte, para mudar horário ou texto sem
// tocar no código. O arquivo é opcional: sem ele, o bot só reage a webhook.
function carregarAgenda(caminho = process.env.AGENDA_ARQUIVO ?? "agenda.json") {
  try {
    return JSON.parse(readFileSync(caminho, "utf8"));
  } catch (erro) {
    if (erro.code !== "ENOENT") {
      console.error(`⚠️  Não foi possível ler ${caminho}: ${erro.message}`);
    }
    return { tarefas: [] };
  }
}

const DETALHES_DE_IMAGEM = ["auto", "low", "high"];

// Valor errado aqui faria a OpenAI recusar a mensagem só quando alguém
// mandasse uma foto — melhor parar na subida.
function validarDetalhe(valor) {
  const limpo = String(valor).trim().toLowerCase();
  if (!DETALHES_DE_IMAGEM.includes(limpo)) {
    throw new Error(
      `OPENAI_IMAGE_DETAIL inválido: "${valor}". Opções: ${DETALHES_DE_IMAGEM.join(", ")}`,
    );
  }
  return limpo;
}

// Exemplo: CONTATOS="Kelwin=5519993723677;Mãe=5511988887777"
function lerContatos(bruto, numeroTeste) {
  const contatos = String(bruto ?? "")
    .split(/[;,]/)
    .map((par) => par.split("="))
    .filter(([nome, numero]) => nome?.trim() && numero?.trim())
    .map(([nome, numero]) => ({ nome: nome.trim(), numero: numero.replace(/\D/g, "") }));

  // Sem CONTATOS configurado, o número de teste já serve de atalho.
  if (contatos.length === 0 && numeroTeste) {
    return [{ nome: "Teste", numero: String(numeroTeste).replace(/\D/g, "") }];
  }
  return contatos;
}

const ARQUIVO_DE_PREFERENCIAS = process.env.PREFERENCIAS_ARQUIVO ?? "dados/preferencias.json";
// O que foi escolhido no painel vence o .env: é a ação mais recente e
// explícita de quem está operando.
const preferencias = carregarPreferencias(ARQUIVO_DE_PREFERENCIAS);

export const config = {
  preferenciasArquivo: ARQUIVO_DE_PREFERENCIAS,
  porta: Number(process.env.PORT ?? 3000),

  // Qual implementação de cada porta usar. É aqui que se troca de tecnologia.
  provedores: {
    whatsapp: process.env.WHATSAPP_PROVIDER ?? "zapi", // zapi | evolution
    ia: process.env.AI_PROVIDER ?? "openai",
    historico: process.env.HISTORY_STORE ?? "memoria", // memoria | postgres
    // As pausas seguem o histórico por padrão: quem quer uma coisa durável
    // normalmente quer a outra.
    pausas: process.env.PAUSAS_STORE ?? process.env.HISTORY_STORE ?? "memoria",
    // Lojas, agenda e preferências: arquivo | postgres. São a configuração de
    // operação, e migram juntas.
    estado: process.env.ESTADO_STORE ?? "arquivo",
    limites: process.env.LIMITES_STORE ?? process.env.HISTORY_STORE ?? "memoria",
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
    // Usado pelo RAG. text-embedding-3-small custa US$ 0,02 por 1M de tokens.
    modeloEmbedding: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
  },

  imagem: {
    // Quanto do detalhe da imagem o modelo processa:
    //   low  -> um bloco de 512x512, custo fixo e baixo; bom para "que comida
    //           é essa?", ruim para ler letra miúda
    //   high -> fatia a imagem em vários blocos e lê detalhe fino (rótulo,
    //           tabela nutricional), custando bem mais
    //   auto -> a OpenAI decide pelo tamanho da imagem
    detalhe: validarDetalhe(process.env.OPENAI_IMAGE_DETAIL ?? "auto"),
  },

  // Número usado nos testes manuais de envio (npm run enviar). Fica no .env
  // para não versionar telefone de ninguém.
  numeroTeste: process.env.NUMBER_TEST,

  // Atalhos de telefone para o painel, no formato "Nome=numero", separados por
  // ; ou vírgula. Ficam no .env pelo mesmo motivo do numeroTeste.
  contatos: lerContatos(process.env.CONTATOS, process.env.NUMBER_TEST),

  // Tetos diários de mensagens respondidas. 0 desliga o teto.
  tetos: {
    porContato: Number(process.env.LIMITE_POR_CONTATO_DIA ?? 50),
    global: Number(process.env.LIMITE_GLOBAL_DIA ?? 500),
  },

  painel: {
    // Sem senha, o painel fica aberto — aceitável só em rede local.
    senha: process.env.PAINEL_SENHA || null,
    // Segredo de assinatura do cookie. Sem um próprio, é derivado da senha.
    segredo: process.env.PAINEL_SEGREDO || null,
    horasDeSessao: Number(process.env.PAINEL_HORAS_SESSAO ?? 12),
  },

  webhook: {
    // Segredo que o provedor precisa mandar (no caminho ou no cabeçalho).
    // Vazio deixa o webhook aberto — só aceitável em rede local.
    token: process.env.WEBHOOK_TOKEN || null,
  },

  banco: {
    // Um Postgres para o que precisa durar. O container da Evolution já roda
    // um; basta um database separado (porta 5434 no host).
    url: process.env.DATABASE_URL,
  },

  conversa: {
    // Mensagens guardadas por contato (usuário + bot somados).
    maxHistorico: Number(process.env.MAX_HISTORICO ?? 10),
  },

  // Ritmo do "digitando...". Padrões em src/core/BotService.js.
  ritmo: {
    msPorCaractere: Number(process.env.DIGITANDO_MS_POR_CARACTERE ?? 45),
    minimoMs: Number(process.env.DIGITANDO_MIN_MS ?? 1000),
    maximoMs: Number(process.env.DIGITANDO_MAX_MS ?? 5000),
    pausaMs: Number(process.env.PAUSA_ENTRE_MENSAGENS_MS ?? 800),
  },

  agenda: {
    arquivo: process.env.AGENDA_ARQUIVO ?? "agenda.json",
    fusoHorario: carregarAgenda().fusoHorario ?? "America/Sao_Paulo",
  },

  // Uma pasta, um arquivo por loja. O perfil loja_<slug> escolhe qual atende.
  lojas: {
    pasta: process.env.LOJAS_PASTA ?? "dados/lojas",
  },

  // RAG: responder com base em documentos indexados. "nenhum" desliga.
  rag: {
    provedor: process.env.RAG_PROVIDER ?? "nenhum", // nenhum | memoria
    arquivo: process.env.RAG_ARQUIVO ?? "dados/base.json",
    // Distância máxima para o trecho contar como relevante. Medido com o
    // text-embedding-3-small e pedaços de ~900 caracteres: pergunta dentro do
    // assunto fica em 0,45–0,55 e fora em 0,74–0,92, então 0,65 separa os dois
    // casos com folga. O painel tem um campo para conferir isso na sua base.
    limiar: Number(process.env.RAG_LIMIAR ?? 0.65),
    trechos: Number(process.env.RAG_TRECHOS ?? 5),
    // ~4 caracteres por token: 900 ≈ 225 tokens por pedaço. Pedaço menor
    // separa melhor o relevante do irrelevante — medido: com 3.200 a distância
    // de uma pergunta do assunto subia para 0,64, quase encostando no 0,74 de
    // uma pergunta fora dele.
    pedaco: {
      tamanho: Number(process.env.RAG_TAMANHO_PEDACO ?? 900),
      sobreposicao: Number(process.env.RAG_SOBREPOSICAO ?? 150),
    },
  },

  prompt: {
    // loja_<slug> | loja | suplementos | whatsapp | puro (ver src/core/prompt.js)
    perfil: preferencias.perfil ?? process.env.PROMPT_PERFIL ?? "suplementos",
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
