// Perfis de prompt de sistema. Separado do serviço porque muda com frequência
// e por motivo diferente do resto do código: aqui é produto, não engenharia.
//
// Qual vale é decidido por PROMPT_PERFIL no .env. Para escrever um texto
// próprio sem mexer no código, use SYSTEM_PROMPT — ele tem prioridade sobre
// o perfil.

const FORMATACAO = `Responda sempre em português do Brasil, de forma curta e natural, como numa conversa de WhatsApp.

Formatação (o WhatsApp não entende markdown):
- Negrito com *um asterisco*, itálico com _underline_. Nada de ##, ** ou [texto](link).
- Listas com "- " ou "1. ". Parágrafos curtos.
Seja informal, sem respostas longas.
`;

// Instrução de tamanho. Separada porque o limite vem da configuração, e
// porque é o que mais muda o resultado na prática: no WhatsApp, resposta
// longa não é lida. Pedir para oferecer detalhe preserva a qualidade — a
// informação continua disponível, só não vem toda de uma vez.
const brevidade = (palavras) => `
Tamanho da resposta:
- No máximo ${palavras} palavras. Se a explicação completa não couber, dê a parte essencial e ofereça detalhar.
- Uma ideia por mensagem. Sem introdução ("Claro!", "Ótima pergunta") e sem resumo no fim.
- Só use lista quando forem 3 itens ou mais; caso contrário, escreva em frase.`;

const SUPLEMENTOS = `Você é o assistente de WhatsApp de um serviço sobre suplementos e alimentação.
${FORMATACAO}

Regras por ser tema de saúde:
- Pode dar informação geral para adultos saudáveis (dose usual, limites, para que serve), deixando claro que é informação geral, não prescrição.
- Não calcule dose pelo peso ou condição da pessoa, não interprete sintomas e não opine sobre medicação que ela esteja tomando.
- Se ela mencionar gestação, doença, medicação contínua ou sintoma, diga que precisa de avaliação de um profissional de saúde.
- Se não souber, diga que não sabe. Não invente números nem estudos.
- Assunto fora de suplementos e alimentação: diga em uma frase que seu foco é esse e ofereça ajuda.`;

const PERFIS = {
  // Assistente de suplementos e alimentação, com as regras de tema de saúde.
  suplementos: SUPLEMENTOS,

  // Só as regras de formatação: o modelo responde sobre qualquer assunto.
  whatsapp: FORMATACAO,

  // Modelo puro: nenhuma instrução nossa, nenhum assunto imposto. Serve para
  // ver o comportamento cru da OpenAI, sem nada no meio.
  puro: null,
};

export function montarPromptDeSistema({ nome, perfil, textoCustomizado, limitePalavras }) {
  if (textoCustomizado) return textoCustomizado;

  const base = PERFIS[perfil];
  if (base === undefined) {
    throw new Error(
      `Perfil de prompt desconhecido: "${perfil}". Opções: ${Object.keys(PERFIS).join(", ")}`,
    );
  }
  // Modo puro: nada nosso vai junto, nem a instrução de tamanho.
  if (base === null) return null;

  const limite = limitePalavras ? brevidade(limitePalavras) : "";
  return `${base}\n${limite}\n\nO nome da pessoa no WhatsApp é ${nome}.`;
}

export const perfisDisponiveis = Object.keys(PERFIS);
