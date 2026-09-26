// Formulário guiado da loja: perguntas específicas em vez de "escreva um
// documento sobre seu negócio". Dono de loja responde pergunta em dez
// segundos; escrever manual ele não escreve nunca.
//
// O esquema mora aqui e é servido ao painel, que monta a tela a partir dele —
// uma fonte de verdade só. As respostas viram duas coisas:
//
//   1. um resumo estruturado, que vai direto no prompt (horário, taxa, prazo:
//      valores que precisam sair exatos, e RAG erraria um dígito);
//   2. um documento em markdown, indexado na base para o texto corrido
//      (política de troca, descrição de serviço, perguntas frequentes).

export const PERGUNTAS = [
  {
    secao: "A loja",
    campos: [
      { id: "nome", rotulo: "Nome da loja", tipo: "texto", exemplo: "Empório da Serra" },
      { id: "ramo", rotulo: "O que vocês vendem ou fazem?", tipo: "texto", exemplo: "Produtos naturais e suplementos" },
      { id: "endereco", rotulo: "Endereço completo", tipo: "texto", exemplo: "Rua das Flores, 120 — Centro" },
      { id: "referencia", rotulo: "Ponto de referência", tipo: "texto", exemplo: "Em frente à praça, ao lado da farmácia" },
      { id: "estacionamento", rotulo: "Tem estacionamento?", tipo: "texto", exemplo: "Sim, gratuito para clientes" },
    ],
  },
  {
    secao: "Horários",
    campos: [
      { id: "horarioSemana", rotulo: "Segunda a sexta", tipo: "texto", exemplo: "9h às 18h" },
      { id: "horarioSabado", rotulo: "Sábado", tipo: "texto", exemplo: "9h às 13h" },
      { id: "horarioDomingo", rotulo: "Domingo e feriados", tipo: "texto", exemplo: "Fechado" },
      { id: "almoco", rotulo: "Fecha para almoço?", tipo: "texto", exemplo: "Não" },
    ],
  },
  {
    secao: "Pagamento",
    campos: [
      { id: "formasPagamento", rotulo: "Formas de pagamento aceitas", tipo: "texto", exemplo: "Pix, dinheiro, débito e crédito" },
      { id: "parcelamento", rotulo: "Parcela? Em quantas vezes e a partir de quanto?", tipo: "texto", exemplo: "Até 3x sem juros acima de R$ 150" },
      { id: "descontoPix", rotulo: "Tem desconto para alguma forma?", tipo: "texto", exemplo: "5% no Pix ou dinheiro" },
    ],
  },
  {
    secao: "Entrega",
    campos: [
      { id: "fazEntrega", rotulo: "Vocês entregam?", tipo: "texto", exemplo: "Sim, na cidade toda" },
      { id: "taxaEntrega", rotulo: "Qual a taxa?", tipo: "texto", exemplo: "R$ 8 até 5 km; grátis acima de R$ 120" },
      { id: "prazoEntrega", rotulo: "Qual o prazo?", tipo: "texto", exemplo: "No mesmo dia para pedidos até 15h" },
      { id: "retirada", rotulo: "Pode retirar na loja?", tipo: "texto", exemplo: "Sim, pronto em 1 hora" },
    ],
  },
  {
    secao: "Trocas e devoluções",
    campos: [
      { id: "prazoTroca", rotulo: "Qual o prazo para troca?", tipo: "texto", exemplo: "7 dias com a nota fiscal" },
      { id: "condicoesTroca", rotulo: "Em que condições você troca (e em que condições não troca)?", tipo: "longo", exemplo: "Produto lacrado e sem uso. Não trocamos itens de alimentação já abertos." },
    ],
  },
  {
    secao: "Produtos e serviços",
    campos: [
      { id: "principais", rotulo: "Principais produtos ou serviços, e faixa de preço", tipo: "longo", exemplo: "Whey protein a partir de R$ 120; creatina a partir de R$ 90; consultoria nutricional R$ 200" },
      { id: "diferenciais", rotulo: "O que diferencia vocês da concorrência?", tipo: "longo", exemplo: "Só marcas com registro na Anvisa e atendimento de nutricionista na loja" },
      { id: "naoFazemos", rotulo: "O que vocês NÃO fazem? (evita a pergunta frustrada)", tipo: "longo", exemplo: "Não vendemos medicamentos, não fazemos prescrição e não atendemos por vídeo" },
    ],
  },
  {
    secao: "Atendimento",
    campos: [
      { id: "nomeAtendente", rotulo: "Como o bot deve se chamar?", tipo: "texto", exemplo: "Sarinha, atendente virtual da Sara Modas" },
      { id: "saudacao", rotulo: "Como ele se apresenta na primeira mensagem?", tipo: "longo", exemplo: "Oi! Aqui é a Sarinha, da Sara Modas 💜 Como posso te ajudar?" },
      { id: "tomAtendimento", rotulo: "Como o bot deve falar?", tipo: "texto", exemplo: "Informal, tratando por você, com emoji ocasional" },
      { id: "quandoChamarHumano", rotulo: "Quando ele deve chamar uma pessoa?", tipo: "longo", exemplo: "Reclamação, pedido com problema, orçamento acima de R$ 500 ou pedido de desconto" },
      { id: "contatoHumano", rotulo: "Como avisar que uma pessoa vai atender?", tipo: "texto", exemplo: "Vou chamar alguém da equipe, responde aqui em alguns minutos" },
      { id: "perguntasFrequentes", rotulo: "Perguntas frequentes e as respostas (uma por linha, no formato pergunta | resposta)", tipo: "longo", exemplo: "Vocês têm produto sem lactose? | Sim, temos linha sem lactose e sem glúten.\nAceitam encomenda? | Sim, com 50% de entrada." },
    ],
  },
];

// Campos que precisam sair exatos e por isso vão no prompt, não no RAG.
const CAMPOS_ESTRUTURADOS = [
  ["nome", "Nome"],
  ["nomeAtendente", "Quem atende"],
  ["ramo", "Ramo"],
  ["endereco", "Endereço"],
  ["referencia", "Referência"],
  ["horarioSemana", "Horário seg-sex"],
  ["horarioSabado", "Horário sábado"],
  ["horarioDomingo", "Domingo/feriados"],
  ["formasPagamento", "Pagamento"],
  ["parcelamento", "Parcelamento"],
  ["fazEntrega", "Entrega"],
  ["taxaEntrega", "Taxa de entrega"],
  ["prazoEntrega", "Prazo de entrega"],
  ["prazoTroca", "Prazo de troca"],
];

const preenchido = (valor) => String(valor ?? "").trim();

/** Bloco curto que vai no prompt de sistema, com os valores exatos. */
export function resumoParaPrompt(respostas = {}) {
  const linhas = CAMPOS_ESTRUTURADOS.map(([id, rotulo]) => {
    const valor = preenchido(respostas[id]);
    return valor ? `- ${rotulo}: ${valor}` : null;
  }).filter(Boolean);

  return linhas.length > 0 ? linhas.join("\n") : null;
}

// Uma pergunta frequente por linha, no formato "pergunta | resposta".
function perguntasFrequentes(texto) {
  return preenchido(texto)
    .split("\n")
    .map((linha) => linha.split("|").map((p) => p.trim()))
    .filter(([pergunta, resposta]) => pergunta && resposta);
}

/**
 * Monta o documento que vai para a base vetorial. Cada seção fica em parágrafo
 * próprio, separado por linha em branco, porque é assim que o chunker corta —
 * seção inteira num pedaço só mantém o contexto junto.
 */
export function montarDocumento(respostas = {}) {
  const partes = [];
  const nome = preenchido(respostas.nome) || "a loja";

  partes.push(`# ${nome}`);

  for (const { secao, campos } of PERGUNTAS) {
    const respondidos = campos
      .filter(({ id }) => preenchido(respostas[id]) && id !== "perguntasFrequentes")
      .map(({ id, rotulo }) => `${rotulo}: ${preenchido(respostas[id])}`);

    if (respondidos.length > 0) partes.push(`## ${secao}\n${respondidos.join("\n")}`);
  }

  const faq = perguntasFrequentes(respostas.perguntasFrequentes);
  // Cada pergunta frequente vira um parágrafo próprio: é a unidade que a busca
  // precisa encontrar isolada.
  for (const [pergunta, resposta] of faq) {
    partes.push(`## ${pergunta}\n${resposta}`);
  }

  return partes.join("\n\n");
}

/**
 * Como a loja quer ser apresentada na primeira mensagem. Fica fora do resumo
 * porque não é um valor a informar, é instrução de comportamento.
 */
export function apresentacaoDaLoja(respostas = {}) {
  const nome = preenchido(respostas.nome);
  const atendente = preenchido(respostas.nomeAtendente);
  const saudacao = preenchido(respostas.saudacao);
  if (!nome && !atendente && !saudacao) return null;
  return { loja: nome || null, atendente: atendente || null, saudacao: saudacao || null };
}

/** Quantos campos foram respondidos, para o painel mostrar o progresso. */
export function contarRespostas(respostas = {}) {
  const todos = PERGUNTAS.flatMap((s) => s.campos.map((c) => c.id));
  return {
    total: todos.length,
    respondidos: todos.filter((id) => preenchido(respostas[id])).length,
  };
}
