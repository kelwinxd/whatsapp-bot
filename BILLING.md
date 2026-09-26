# Custos

Preços das operações pagas e o custo médio de cada uma neste bot.

Conferido em **26/09/2026**. Os valores vivem em [`src/core/billing.js`](src/core/billing.js),
que é o único lugar do projeto que conhece dinheiro — as métricas usam ele para
calcular o gasto real de cada resposta, com os tokens que a própria OpenAI
reporta.

Tudo em dólar; a OpenAI cobra em USD no cartão internacional, com IOF e spread
por cima (uns 10% acima da conversão simples).

## Preço de tabela

| Operação | Modelo | Preço |
| --- | --- | --- |
| Conversa (entrada) | gpt-4o-mini | US$ 0,15 / 1M tokens |
| Conversa (saída) | gpt-4o-mini | US$ 0,60 / 1M tokens |
| Conversa (entrada) | gpt-4o | US$ 2,50 / 1M tokens |
| Conversa (saída) | gpt-4o | US$ 10,00 / 1M tokens |
| Transcrição | whisper-1 | US$ 0,006 / minuto |
| Transcrição | gpt-4o-mini-transcribe | US$ 0,003 / minuto |
| Fala (TTS) | gpt-4o-mini-tts | US$ 0,015 / minuto |
| Busca na web | qualquer | US$ 10 / 1.000 chamadas + 8.000 tokens de entrada por chamada |
| Imagem gerada 1024×1024 | gpt-image-1.5 | US$ 0,009 (low) · 0,034 (medium) · 0,133 (high) |
| Imagem gerada 1024×1024 | gpt-image-1-mini | US$ 0,005 (low) · 0,011 (medium) · 0,036 (high) |
| Imagem gerada 1024×1024 | gpt-image-1 *(sai em 23/10/2026)* | US$ 0,011 (low) · 0,042 (medium) · 0,167 (high) |

## Custo médio por operação neste bot

| Operação | Custo médio | Como chega nesse número |
| --- | --- | --- |
| **Resposta de texto** | **US$ 0,00007** | ~190 tokens de entrada (prompt + histórico) e ~60 de saída, medidos |
| Resposta de texto sem instrução (perfil `puro`) | US$ 0,0003 | 20 de entrada e 500 de saída — o modelo escreve até o teto |
| **Áudio recebido (30s)** | **US$ 0,00310** | US$ 0,003 de transcrição + a resposta de texto |
| **Imagem recebida** | **US$ 0,003 a 0,01** | a imagem entra como tokens de entrada, com multiplicador de 33x no mini |
| Imagem recebida com `detail: low` | ~US$ 0,001 | um bloco de 512×512, custo fixo |
| **Tarefa da agenda** | **US$ 0,00007** | é uma resposta de texto; a fonte externa é de graça |
| Tarefa para N números | igual | o texto é gerado uma vez e enviado a todos |
| **Resposta com busca na web** | **US$ 0,01120** | US$ 0,01 por chamada + 8.000 tokens de entrada + a resposta |
| **Imagem gerada** | **US$ 0,009 a 0,133** | conforme modelo e qualidade |
| Enviar/receber no WhatsApp | US$ 0 | Evolution é open source e roda na sua máquina |
| Transcrever e responder por voz (30s + 20s) | US$ 0,00810 | transcrição + texto + TTS |

Para comparar: 45 respostas de texto custam o mesmo que **uma** resposta com
busca na web, e 1.900 respostas de texto custam o mesmo que **uma** imagem
gerada em alta qualidade.

## Por mês, por volume

Assumindo respostas de texto, que é o uso normal do bot:

| Mensagens/dia | Por mês | OpenAI |
| --- | --- | --- |
| 50 | 1.500 | US$ 0,11 |
| 200 | 6.000 | US$ 0,42 |
| 500 | 15.000 | US$ 1,05 |
| 2.000 | 60.000 | US$ 4,20 |

Somando infraestrutura, com 200 mensagens por dia:

| Cenário | Por mês |
| --- | --- |
| Tudo na sua máquina (hoje) | ~R$ 2 |
| Tudo numa VPS (Hostinger KVM 1) | ~R$ 30 |
| VPS + bot no Railway | ~R$ 57 |

O custo fixo domina: a OpenAI só passa a pesar acima de mil mensagens por dia.

## O que mais encarece, em ordem

1. **Busca na web** — 45x uma resposta de texto. Alternativas mais baratas:
   Brave Search API ou Tavily, com camada gratuita, ou SearxNG na própria VPS.
2. **Imagem gerada** — de 130x a 1.900x uma resposta de texto.
3. **Imagem recebida** — no `gpt-4o-mini` a imagem custa 33x em tokens, o que
   torna o preço em dólar igual ao do `gpt-4o`. Ou seja: o mini é barato para
   texto e não tem desconto para imagem. `OPENAI_IMAGE_DETAIL=low` corta isso.
4. **Resposta longa** — saída custa 4x a entrada. Foi o que a instrução de
   brevidade resolveu: de 500 tokens de saída para 60, ou 4,6x mais barato.
5. **Histórico grande** — `MAX_HISTORICO` multiplica a entrada de toda resposta
   seguinte. É também por isso que a imagem não fica no histórico: só a marca
   `[imagem enviada]`.

## Onde ver o gasto

O painel mostra o custo acumulado da sessão e o custo médio por resposta,
calculados com os tokens reais de cada chamada. Os números zeram quando o
servidor reinicia, junto com as métricas.

Fontes: [preços da OpenAI](https://developers.openai.com/api/docs/pricing) ·
[preço por imagem](https://pricepertoken.com/gpt-image-pricing) ·
[whisper](https://diyai.io/ai-tools/speech-to-text/openai-whisper-api-pricing-2026/)
