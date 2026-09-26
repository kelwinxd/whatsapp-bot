// Preços das operações pagas e o cálculo de custo de cada uma.
//
// Único lugar do projeto que conhece valores em dólar: as métricas usam isto
// para estimar gasto, e o BILLING.md documenta as contas com as fontes.
// Conferido em 2026-09-26 — a OpenAI muda preço e aposenta modelo com alguma
// frequência, então vale reconferir antes de decidir algo com base nisto.
//
// Custo desconhecido devolve null em vez de 0: zero seria mentira e apareceria
// como "de graça" no painel.

export const PRECOS_USD = {
  // Por 1 milhão de tokens.
  texto: {
    "gpt-4o-mini": { entrada: 0.15, saida: 0.6 },
    "gpt-4o-mini-search-preview": { entrada: 0.15, saida: 0.6 },
    "gpt-4o": { entrada: 2.5, saida: 10.0 },
  },

  // Por 1 milhão de tokens vetorizados (RAG).
  embedding: {
    "text-embedding-3-small": 0.02,
    "text-embedding-3-large": 0.13,
  },

  // Por minuto de áudio.
  transcricao: {
    "whisper-1": 0.006,
    "gpt-4o-transcribe": 0.006,
    "gpt-4o-mini-transcribe": 0.003,
  },

  // Por minuto de áudio gerado.
  fala: {
    "gpt-4o-mini-tts": 0.015,
  },

  // Por 1.000 chamadas da ferramenta de busca, fora os tokens: cada chamada
  // ainda cobra um bloco fixo de 8.000 tokens de entrada.
  buscaWeb: {
    porMilChamadas: 10,
    tokensPorChamada: 8_000,
  },

  // Por imagem gerada, em 1024x1024.
  imagemGerada: {
    "gpt-image-1.5": { low: 0.009, medium: 0.034, high: 0.133 },
    "gpt-image-1-mini": { low: 0.005, medium: 0.011, high: 0.036 },
    // Aposentado em 23/10/2026.
    "gpt-image-1": { low: 0.011, medium: 0.042, high: 0.167 },
  },
};

const porMilhao = (tokens, precoPorMilhao) => (tokens / 1_000_000) * precoPorMilhao;

/**
 * Custo de uma resposta de conversa. Imagem enviada pela pessoa já vem contada
 * nos tokens de entrada que a OpenAI reporta — no gpt-4o-mini ela custa 33x,
 * e é por isso que uma resposta com foto sai muito mais caro que uma de texto.
 */
export function custoDeTexto({ modelo, tokensEntrada = 0, tokensSaida = 0 }) {
  const preco = PRECOS_USD.texto[modelo];
  if (!preco) return null;
  return porMilhao(tokensEntrada, preco.entrada) + porMilhao(tokensSaida, preco.saida);
}

export function custoDeEmbedding({ modelo, tokens = 0 }) {
  const preco = PRECOS_USD.embedding[modelo];
  if (preco === undefined) return null;
  return porMilhao(tokens, preco);
}

export function custoDeTranscricao({ modelo, segundos = 0 }) {
  const porMinuto = PRECOS_USD.transcricao[modelo];
  if (porMinuto === undefined) return null;
  return (segundos / 60) * porMinuto;
}

export function custoDeFala({ modelo, segundos = 0 }) {
  const porMinuto = PRECOS_USD.fala[modelo];
  if (porMinuto === undefined) return null;
  return (segundos / 60) * porMinuto;
}

export function custoDeImagemGerada({ modelo, qualidade = "medium", quantidade = 1 }) {
  const preco = PRECOS_USD.imagemGerada[modelo]?.[qualidade];
  if (preco === undefined) return null;
  return preco * quantidade;
}

/** Busca na web: a taxa por chamada mais o bloco fixo de tokens de entrada. */
export function custoDeBusca({ modelo, chamadas = 1 }) {
  const preco = PRECOS_USD.texto[modelo];
  if (!preco) return null;
  const taxa = (chamadas * PRECOS_USD.buscaWeb.porMilChamadas) / 1_000;
  const tokens = porMilhao(chamadas * PRECOS_USD.buscaWeb.tokensPorChamada, preco.entrada);
  return taxa + tokens;
}

/** Soma ignorando o que não soubemos calcular. */
export const somar = (...custos) =>
  custos.filter((c) => typeof c === "number").reduce((a, b) => a + b, 0);

// 4 casas: uma resposta de texto custa US$ 0,0002, e menos casas viraria zero.
export const emUSD = (valor) =>
  typeof valor === "number" ? `US$ ${valor.toFixed(4)}` : "—";
