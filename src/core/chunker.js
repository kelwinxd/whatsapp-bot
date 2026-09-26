// Quebra o documento em pedaços do tamanho que cabe no prompt.
//
// Corta em parágrafo, não em caractere: pedaço que começa no meio de uma frase
// chega truncado ao modelo e a resposta sai pela metade. A sobreposição existe
// para a informação que fica na fronteira de dois pedaços não se perder — ela
// aparece no fim de um e no começo do outro.
//
// Tamanho em caracteres porque é o que dá para medir sem tokenizar: ~4
// caracteres por token em português, então 3.200 ≈ 800 tokens.

const TAMANHO_PADRAO = 3_200;
const SOBREPOSICAO_PADRAO = 400;

const FIM_DE_PARAGRAFO = /\n\s*\n/;

// Parágrafo maior que o limite (tabela, texto sem quebra) é dividido por frase;
// se ainda não couber, à força — melhor um corte feio que um pedaço gigante.
function dividirParagrafoGrande(paragrafo, tamanho) {
  const frases = paragrafo.match(/[^.!?]+[.!?]+|\S+$/g) ?? [paragrafo];
  const pedacos = [];
  let atual = "";

  for (const frase of frases) {
    if (frase.length > tamanho) {
      if (atual) pedacos.push(atual.trim());
      atual = "";
      for (let i = 0; i < frase.length; i += tamanho) {
        pedacos.push(frase.slice(i, i + tamanho).trim());
      }
      continue;
    }
    if ((atual + frase).length > tamanho) {
      pedacos.push(atual.trim());
      atual = frase;
    } else {
      atual += frase;
    }
  }

  if (atual.trim()) pedacos.push(atual.trim());
  return pedacos.filter(Boolean);
}

export function quebrarEmPedacos(
  texto,
  { tamanho = TAMANHO_PADRAO, sobreposicao = SOBREPOSICAO_PADRAO } = {},
) {
  const limpo = String(texto ?? "").replace(/\r\n/g, "\n").trim();
  if (!limpo) return [];

  const paragrafos = limpo.split(FIM_DE_PARAGRAFO).map((p) => p.trim()).filter(Boolean);
  const pedacos = [];
  let atual = "";

  const fechar = () => {
    if (!atual.trim()) return;
    pedacos.push(atual.trim());
    // O próximo pedaço começa com o fim deste, para não perder o que está na
    // fronteira.
    atual = sobreposicao > 0 ? atual.slice(-sobreposicao) : "";
  };

  for (const paragrafo of paragrafos) {
    if (paragrafo.length > tamanho) {
      fechar();
      atual = "";
      pedacos.push(...dividirParagrafoGrande(paragrafo, tamanho));
      continue;
    }

    if ((atual + "\n\n" + paragrafo).length > tamanho) fechar();
    atual = atual ? `${atual}\n\n${paragrafo}` : paragrafo;
  }

  fechar();

  // A sobreposição pode deixar um último pedaço que é só o rabo do anterior.
  // O corte é só nesse caso: filtrar todo pedaço repetido apagaria conteúdo
  // legítimo de documento repetitivo (tabela, lista de itens parecidos).
  const limpos = pedacos.filter((p) => p.length > 0);
  if (limpos.length > 1 && limpos.at(-2).endsWith(limpos.at(-1))) limpos.pop();
  return limpos;
}
