# Plano: RAG (responder com base nos seus documentos)

Hoje o bot responde só com o que o modelo já sabe. RAG é o que permite
entregar um PDF ou um `.txt` e ele passar a responder **com base naquilo**,
citando de onde tirou — e dizendo que não sabe quando o assunto não está lá.

O `suplementos-project` já faz isso (`server/src/rag/`), com Postgres +
pgvector. Este plano reaproveita as decisões que deram certo lá, encaixadas na
arquitetura de portas deste projeto.

## Como o fluxo muda

Hoje:

```
mensagem -> prompt de sistema + histórico -> modelo -> resposta
```

Com RAG:

```
mensagem -> vetoriza a pergunta
         -> busca os trechos mais próximos na base
         -> prompt de sistema + trechos + histórico -> modelo -> resposta
```

O modelo não "aprende" o documento: ele recebe os pedaços relevantes junto da
pergunta, a cada mensagem. Por isso RAG é busca, não treinamento.

## A porta

Uma porta nova em `src/core/ports.js`, no mesmo estilo das outras:

```js
export class BaseDeConhecimento {
  /** Indexa um documento inteiro, em pedaços. */
  async indexar({ nome, texto }) {}

  /** Trechos mais próximos da pergunta, já filtrados por relevância. */
  async buscar(pergunta, k = 5) {} // -> [{ conteudo, documento, posicao, distancia }]

  /** O que está indexado hoje. */
  async documentos() {} // -> [{ nome, pedacos, indexadoEm }]

  async remover(nome) {}
}
```

O `BotService` conhece só isso. Trocar de armazenamento não toca na regra.

## Adaptadores propostos

| Adaptador | Onde guarda | Quando usar |
| --- | --- | --- |
| `memoria` | JSON em `dados/base.json`, busca por cosseno em memória | começo; zero infra; bom até uns poucos milhares de pedaços |
| `pgvector` | Postgres com pgvector (o container já existe no suplementos-project) | quando a base crescer ou virar produção |
| `suplementos` | chama o `/api/chat` do outro projeto | se a ideia for reusar a base de suplementos já ingerida |

O `memoria` não é gambiarra: carregar alguns milhares de vetores na RAM e
calcular cosseno é rápido (milissegundos) e evita subir banco para testar a
ideia. A troca depois é uma linha no `.env`.

## Ingestão

Script novo: `npm run indexar caminho/do/arquivo.pdf`

1. **Extrair texto.** `.txt` e `.md` são leitura direta. PDF precisa de
   dependência — `pdf-parse` (simples) ou `pdfjs-dist` (mais robusto, lida com
   PDF estranho). PDF escaneado é imagem: precisaria de OCR, e aí eu deixaria
   de fora por enquanto, avisando em vez de indexar um arquivo vazio.
2. **Quebrar em pedaços.** ~800 tokens (uns 3.200 caracteres) com 100 de
   sobreposição, cortando em parágrafo quando possível — cortar no meio de uma
   frase estraga a resposta. No `suplementos-project` o chunker segue os
   cabeçalhos do markdown, o que preserva contexto; vale copiar a ideia.
3. **Vetorizar.** `text-embedding-3-small`, US$ 0,02 por 1M de tokens.
4. **Guardar** pedaço + vetor + nome do documento + posição.

## Consulta

- Vetoriza a pergunta e busca os `k = 5` mais próximos.
- **Limiar de distância**: a busca vetorial sempre devolve os k mais próximos,
  mesmo que irrelevantes. Sem o corte, "oi" traz trechos aleatórios e o modelo
  tenta usá-los.

  Calibrado com medição, não com chute. Com `text-embedding-3-small` sobre o
  documento de exemplo:

  | Tamanho do pedaço | Pergunta do assunto | Pergunta fora do assunto |
  | --- | --- | --- |
  | 3.200 caracteres (1 pedaço) | 0,541 – 0,639 | 0,765 – 0,970 |
  | 900 caracteres (2 pedaços) | 0,423 – 0,566 | 0,741 – 0,916 |

  Pedaço menor separa melhor: com 3.200 a margem entre "dentro" e "fora" era de
  0,13; com 900 passa de 0,17. Daí os padrões `RAG_TAMANHO_PEDACO=900` e
  `RAG_LIMIAR=0.65`.

  O efeito colateral aparece em documento curto: um trecho que contém a
  resposta pode ficar acima do limiar e o bot responde "não encontrei no
  material". Aí é subir o limiar ou diminuir o pedaço — e é para isso que o
  painel vai ter o campo de teste de busca.
- Trecho vazio não é erro: pode ser saudação ou assunto fora da base. Quem
  decide o que fazer é o prompt, não o código.

No prompt entra um bloco assim:

```
Trechos da base de conhecimento:
[1] (manual-do-produto.pdf, parte 3) ...texto...
[2] (faq.txt, parte 1) ...texto...

Responda usando só estes trechos quando a pergunta for sobre eles. Cite o
número entre colchetes. Se a resposta não estiver aí, diga que não sabe.
```

## Integração no bot

- `RAG_PROVIDER=nenhum | memoria | pgvector` no `.env`, com `nenhum` por
  padrão: quem não usa RAG não paga nada nem muda comportamento.
- O registry ganha o catálogo novo, igual aos outros.
- O `BotService` pede os trechos antes de chamar a IA e os passa para o
  `montarPromptDeSistema`. Uma linha a mais no fluxo.
- Só para pergunta de texto. Imagem e áudio transcrito também podem usar
  depois, mas começar simples.

## Painel

Seção "Base de conhecimento":

- lista dos documentos indexados (nome, pedaços, data);
- upload de arquivo (`POST /api/base/documentos`, multipart);
- botão de remover e de reindexar;
- campo de teste: digita uma pergunta e vê quais trechos ela traria, com a
  distância — é o que permite calibrar o limiar sem adivinhar.

## Custos

| Operação | Custo |
| --- | --- |
| Indexar um PDF de 50 páginas (~25k tokens) | US$ 0,0005 |
| Vetorizar a pergunta | US$ 0,0000004 |
| Trechos no prompt (+800 tokens de entrada) | US$ 0,00012 |

Ou seja: **cada resposta com RAG custa ~3x uma resposta normal** (US$ 0,0002
contra US$ 0,00007) e continua irrisória. Indexar é praticamente de graça, e
só acontece uma vez por documento.

Todos os preços entram em `src/core/billing.js`, como as outras operações.

## Fases

| Fase | Entrega | Esforço |
| --- | --- | --- |
| 1 ✅ | Porta + adaptador `memoria` + `npm run indexar` para `.txt`/`.md` + integração no prompt | feito |
| 2 | PDF (dependência de extração) e melhor quebra por parágrafo/cabeçalho | ~1h30 |
| 3 | Painel: upload, lista, remoção e o campo de teste de busca | ~2h |
| 4 | Adaptador `pgvector`, reaproveitando o Postgres do suplementos-project | ~2h |

Cada fase é útil sozinha: no fim da 1 já dá para jogar um `.txt` e ver o bot
responder com base nele.

## Decisões que ficam abertas

- **Base única ou por contato?** Uma base compartilhada é o simples. Base por
  pessoa faria sentido se cada um mandar os próprios documentos, mas multiplica
  armazenamento e complica a remoção.
- **Documento apagado.** Reindexar por cima ou versionar? Começar substituindo
  pelo nome do arquivo é suficiente.
- **Quem pode indexar.** Se o upload ficar só no painel local, o risco é baixo.
  Deixar a pessoa mandar PDF pelo WhatsApp e indexar automaticamente é cômodo e
  perigoso: qualquer um envenenaria a base.
- **Tamanho máximo.** Um PDF de 500 páginas são ~250k tokens (US$ 0,005 para
  indexar, tranquilo), mas o JSON do adaptador `memoria` passaria de 50 MB.
  Nesse ponto é hora do `pgvector`.

## Como testar sem rede

Igual ao resto do projeto: o adaptador de embeddings entra por injeção, e nos
testes um dublê determinístico (vetor derivado do hash do texto) permite
verificar a ordenação da busca, o corte pelo limiar e o formato do bloco que
vai ao prompt — sem chamar a OpenAI.
