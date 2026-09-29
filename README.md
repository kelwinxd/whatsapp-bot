# wp-bot

Bot de WhatsApp que responde com um modelo de linguagem. O provedor de
WhatsApp, o de IA e o repositório de conversas são trocáveis por configuração.

## Arquitetura

```
index.js                          bootstrap: monta as peças e sobe o HTTP
src/
  config.js                       único lugar que lê process.env
  server.js                       Express: traduz HTTP em chamada de serviço
  core/
    ports.js                      contratos (WhatsApp, IA, conversas)
    registry.js                   escolhe a implementação de cada porta
    BotService.js                 a regra do bot
    prompt.js                     prompt de sistema
  adapters/
    whatsapp/ZapiAdapter.js
    whatsapp/EvolutionAdapter.js
    ia/OpenAIAdapter.js
    conversas/MemoriaRepo.js
```

O núcleo depende só das portas de `core/ports.js`. Cada adaptador traduz a API
de um provedor para esses contratos, e o `registry.js` escolhe qual usar a
partir do `.env`. Trocar de tecnologia é mudar uma variável; acrescentar uma é
escrever o adaptador e somar uma linha no catálogo.

Todo webhook vira a mesma `MensagemRecebida`:

```js
{ telefone, nome, texto, minha, grupo, midia, bruto }
```

## Imagem recebida

Mandando uma foto para o bot, ele responde sobre ela: visão é nativa do
modelo, não é ferramenta. O `midia` do webhook é só um descritor; o conteúdo é
baixado sob demanda por `obterMidiaBase64()` — na Evolution via
`/chat/getBase64FromMediaMessage`, na Z-API baixando a URL que ela manda.

No histórico fica apenas `[imagem enviada] <pergunta>`, nunca a imagem. Imagem
no `gpt-4o-mini` custa 33x em tokens, e guardá-la faria o modelo ser cobrado
por ela de novo em toda resposta seguinte da conversa.

Quanto detalhe o modelo processa vai em `OPENAI_IMAGE_DETAIL`:

| Valor | Efeito |
| --- | --- |
| `low` | um bloco de 512x512, custo fixo e baixo; bom para "que comida é essa?" |
| `high` | fatia a imagem e lê letra miúda (rótulo, tabela nutricional), custando mais |
| `auto` | padrão; a OpenAI decide pelo tamanho da imagem |

Valor inválido para o servidor na subida, em vez de falhar só quando alguém
manda uma foto.

## Áudio recebido

Áudio vira texto antes de chegar ao modelo de conversa: o adaptador baixa o
arquivo, manda para `/v1/audio/transcriptions` e a transcrição segue o fluxo
normal — o modelo recebe algo indistinguível de uma frase digitada. No
histórico fica `[áudio] <transcrição>`.

Se não houver fala reconhecível, o bot avisa em vez de mandar vazio para a IA.
O modelo de transcrição é configurável em `OPENAI_TRANSCRIBE_MODEL`.

Vídeo e documento continuam de fora: são reconhecidos, mas o bot responde
dizendo que ainda não os trata — em vez de ficar calado.

## Rodando

```bash
npm install
cp .env.example .env   # preencha as chaves
npm run dev
npm test
```

`GET /health` mostra quais provedores estão ativos.

## Planos

- [docs/RAG.md](docs/RAG.md) — plano para o bot responder com base em documentos
  seus (PDF, txt), com porta, adaptadores, ingestão, custos e fases.
- [docs/PERSISTENCIA.md](docs/PERSISTENCIA.md) — o que sai do JSON quando isso
  for para produção, e em que ordem.
- [docs/PRODUTO_SUPORTE.md](docs/PRODUTO_SUPORTE.md) — notas de desenho para
  virar produto de suporte para lojas: como alimentar a base com gente leiga,
  conta da OpenAI, multi-tenant, margem e risco.

## Cadastro da loja

<http://localhost:3000/painel/loja.html> — formulário guiado com 25 perguntas
(horário, pagamento, entrega, trocas, produtos, o que a loja *não* faz,
perguntas frequentes). Ao salvar, as respostas viram duas coisas:

- um **resumo estruturado** que vai direto no prompt, com os valores que
  precisam sair exatos (horário, taxa, prazo) — RAG erraria um dígito;
- um **documento em markdown** indexado na base, para o texto corrido
  (política de troca, descrição de produto, FAQ).

**Cada cadastro é uma loja.** O nome gera o slug, e o slug gera o perfil:
"Sara Modas" vira `loja_sara-modas`. Para escolher qual loja o bot atende:

```
PROMPT_PERFIL=loja_sara-modas
```

O perfil mantém a base de comportamento no WhatsApp (formatação, brevidade,
resposta picada) e acrescenta as regras de atendimento — não inventar preço
nem prazo, não prometer desconto fora da tabela, e encaminhar para uma pessoa
em reclamação, problema de pedido ou dúvida de saúde.

**Na primeira mensagem de cada conversa o bot se apresenta.** Os campos "Como
o bot deve se chamar?" e "Como ele se apresenta na primeira mensagem?" viram
uma instrução que entra só quando o histórico daquele contato está vazio — a
apresentação acontece uma vez por conversa, e de novo para cada contato novo.
Sem saudação escrita, ele se apresenta com o nome da loja.

**A busca fica restrita ao documento daquela loja.** Sem isso, o bot de uma
responderia com a política de troca de outra — o que aconteceu de verdade
quando duas conviveram na base.

Rotas: `GET /api/loja/formulario` (esquema das perguntas), `GET /api/lojas`,
`GET /api/lojas/:slug`, `POST /api/lojas/previa`, `PUT /api/lojas[/:slug]` e
`DELETE /api/lojas/:slug`. As respostas ficam em `dados/lojas/<slug>.json`,
fora do versionamento.

## Base de conhecimento (RAG)

Com `RAG_PROVIDER=memoria`, o bot responde com base em documentos seus. Indexe
`.txt` ou `.md` (PDF fica para a fase 2):

```bash
npm run indexar exemplos/regras-da-casa.txt
```

A cada pergunta, o texto é vetorizado, os trechos mais próximos são buscados e
vão no prompt com regra de citar a origem (`[1]`) e de dizer quando a resposta
não está no material. Trecho acima do limiar de distância é descartado — é o
que separa "não encontrei no material" de resposta inventada.

A base fica em `dados/base.json` (fora do versionamento) e a alimentação é só
local, pelo script ou pelo painel: documento chegando por WhatsApp deixaria
qualquer pessoa envenenar a base. A base é única, compartilhada por todos os
contatos.

Ajustes: `RAG_LIMIAR` (0,65), `RAG_TRECHOS` (5), `RAG_TAMANHO_PEDACO` (900
caracteres) e `RAG_SOBREPOSICAO` (150). O plano completo e as próximas fases
estão em [docs/RAG.md](docs/RAG.md).

## Custos

Preço de cada operação e o custo médio por resposta estão em
[BILLING.md](BILLING.md); os valores vivem em `src/core/billing.js`. O painel
mostra o gasto acumulado da sessão, calculado com os tokens reais que a OpenAI
reporta em cada chamada.

## Painel

<http://localhost:3000/painel> — página em HTML puro, servida pelo próprio
bot, que mostra o estado, as métricas da sessão (respondidas, erros, tempo
médio e p95 da IA), o feed de mensagens e eventos, e um formulário para
disparar mensagem com atalhos de texto pronto.

Rotas que ela consome: `GET /api/estado` e `POST /api/enviar`.

As métricas ficam em memória e zeram no restart. **Não tem autenticação** — é
para uso local, e `/api/enviar` manda mensagem de verdade. Numa VPS, isso fica
atrás do firewall ou de um túnel SSH (`ssh -L 3000:localhost:3000`), nunca
aberto na internet.

Para testar o envio sem esperar alguém mandar mensagem, preencha `NUMBER_TEST`
no `.env` e use:

```bash
npm run enviar                          # texto padrão para NUMBER_TEST
npm run enviar -- "oi, teste"           # texto próprio
npm run enviar -- "oi" 5519999999999    # texto e destino próprios
```

O script usa o mesmo adaptador do bot, então ele envia pelo provedor que
estiver em `WHATSAPP_PROVIDER`.

O provedor precisa alcançar `POST /webhook` pela internet. Em
desenvolvimento, um túnel resolve:

```bash
cloudflared tunnel --url http://localhost:3000
```

A URL do túnel muda a cada execução — atualize o webhook no provedor.

## Trocando o comportamento da IA

`PROMPT_PERFIL` no `.env` escolhe o que vai antes da conversa:

| Perfil | O que o modelo recebe |
| --- | --- |
| `suplementos` | assistente de suplementos e alimentação, com regras de tema de saúde |
| `whatsapp` | só as regras de formatação e o português; responde sobre qualquer assunto |
| `puro` | nada — nenhuma instrução nossa, só o histórico da conversa |

Para um texto próprio sem mexer no código, preencha `SYSTEM_PROMPT`, que tem
prioridade sobre o perfil. Os perfis ficam em `src/core/prompt.js`.

## Resposta picada

Conversa de WhatsApp é dinâmica, então o bot responde em várias mensagens
curtas em sequência, com "digitando..." entre elas. Quem decide onde quebrar é
o modelo — o prompt pede uma linha com `---` entre as partes, e o código
divide ali. Como na prática ele às vezes separa por linha em branco em vez do
marcador, os dois formatos são aceitos.

Controle em `RESPOSTA_MAX_MENSAGENS` (1 volta ao comportamento de mensagem
única). O excedente é juntado na última mensagem, nunca descartado.

## Histórico que sobrevive a restart

Por padrão o histórico fica em memória e some quando o bot reinicia — e aí ele
trata toda mensagem como a primeira da conversa, se apresentando de novo. Para
persistir:

```bash
docker exec evolution_postgres psql -U evolution -d postgres -c "CREATE DATABASE wpbot"
npm run migrar
```

E no `.env`: `HISTORY_STORE=postgres` com `DATABASE_URL` apontando para esse
database. Detalhes e as próximas etapas em [docs/PERSISTENCIA.md](docs/PERSISTENCIA.md).

## Trocando o perfil pelo painel

O select no topo do painel troca o perfil em uso **sem reiniciar**: os fixos
(`suplementos`, `whatsapp`, `loja`, `puro`) e um por loja cadastrada. A
próxima mensagem já usa o novo.

A escolha é gravada em `dados/preferencias.json` e **vence o `PROMPT_PERFIL`
do `.env`** — sem isso, trocar no painel e reiniciar voltaria calado ao valor
antigo. Para voltar a mandar pelo `.env`, apague o arquivo.

Perfil de loja inexistente é recusado (`loja "x" não cadastrada`), em vez de
atender sem dado nenhum.

Rotas: `GET /api/perfis` e `PUT /api/perfil`.

## Atendimento humano (handoff)

O bot sai da frente quando uma pessoa assume a conversa. Três gatilhos:

| Gatilho | Efeito |
| --- | --- |
| Alguém responde pelo celular | pausa 30 min naquela conversa, e volta sozinho |
| `#pausar` no chat do cliente | pausa sem prazo, até `#voltar` |
| O bot encaminha (marcador `[HUMANO]`) | pausa sem prazo e avisa a equipe |

A detecção usa o id da mensagem: o evento `fromMe` cujo id não saiu do bot foi
digitado no celular. Sem essa distinção o bot se pausaria a cada resposta que
dá, porque a mensagem dele também volta como `fromMe`.

No encaminhamento, o modelo escreve `[HUMANO]` no fim; o bot remove o marcador
antes de enviar, pausa a conversa e manda para o telefone do responsável
(campo no cadastro da loja) o número do cliente e a última mensagem dele.

O painel lista as conversas pausadas com o prazo restante, tem "Devolver ao
bot" em cada uma e um "Assumir conversa" a partir do campo de telefone. Rotas:
`POST /api/atendimento/:telefone/pausar` e `.../retomar`.

A pausa fica em memória: reiniciar o bot devolve todas as conversas a ele.

## Agenda (mensagens na hora marcada)

O bot também pode iniciar conversa: `agenda.json` (copie de
`agenda.example.json`) lista tarefas com expressão cron, telefone e a
instrução que vai ao modelo. Ele roda no mesmo processo do servidor, então o
bot precisa estar no ar na hora marcada.

```json
{
  "nome": "cotacao-do-dolar",
  "cron": "9_AM+MONDAY_TO_FRIDAY",
  "ativa": true,
  "telefones": ["5519999999999", "5511888888888"],
  "instrucao": "Diga a cotação atual do dólar em uma frase, com o valor de compra.",
  "fonte": "https://economia.awesomeapi.com.br/last/USD-BRL"
}
```

### Horários

O campo `cron` é uma composição de **hora + dias**, no estilo das constantes de
cron do Nest:

```
"9_AM+EVERY_DAY"          ->  0 9 * * *       09:00, todos os dias
"10_PM+MONDAY_TO_FRIDAY"  ->  0 22 * * 1-5    22:00, de segunda a sexta
"00_AM+WEEKEND"           ->  0 0 * * 0,6     00:00, sábado e domingo
"7_AM"                    ->  0 7 * * *       sem dias = todos os dias
"08:30+MONDAY_TO_FRIDAY"  ->  30 8 * * 1-5    quando precisa de minuto
"0 10,14,17 * * 1-5"      ->  cron cru, para o que a composição não cobre
```

**Horas:** `12_AM` (ou `00_AM`) a `11_PM`.
**Dias:** `EVERY_DAY`, `MONDAY_TO_FRIDAY`, `WEEKEND` e cada dia
(`MONDAY`… `SUNDAY`).
**Frequências:** `EVERY_MINUTE`, `EVERY_5_MINUTES`, `EVERY_30_MINUTES`,
`EVERY_HOUR` — úteis para testar.

```bash
npm run horarios                  # lista tudo
npm run horarios 9_AM+WEEKEND     # confere uma combinação
```

Combinação inválida é recusada na subida, com erro no log. O log e o painel
mostram o horário em português ("09:00, de segunda a sexta").

Sobre a sintaxe cron, para quando a composição não bastar: são cinco campos —
minuto, hora, dia do mês, mês e dia da semana (0=domingo). `*` é "todos",
vírgula lista valores e hífen faz intervalo.

`telefones` aceita quantos números você quiser: o texto é gerado **uma vez**
na OpenAI e enviado a todos, então mandar para mais de um número não multiplica
o custo do modelo. Cada destino tem seu próprio histórico de conversa. O campo
antigo `telefone`, no singular, continua sendo aceito.

O campo `fonte` é opcional: a URL é buscada na hora e o conteúdo vai como
contexto para o modelo — é o que permite trazer informação de fora em vez de
só gerar texto. Falha na fonte não cancela a tarefa; o modelo é avisado de que
o dado não veio.

Cron inválido ou tarefa sem telefone são recusados na subida, com erro no log.
O `agenda.json` fica fora do versionamento porque tem telefone.

### Editar pelo painel

A seção Agenda do painel edita as tarefas. O horário são dois selects — um
com os dias ("Todos os dias", "De segunda a sexta", "Fim de semana", cada dia
da semana) e outro com a hora ("08:00 (8 AM)") —, então as chaves internas
(`8_AM+EVERY_DAY`) não aparecem na tela. O select de dias também traz as
frequências de teste e a opção "Personalizado (cron)", que revela um campo de
texto para expressão crua; nesses dois casos o select de hora é desligado.
Há botões para criar, remover, salvar e disparar na hora. Salvar grava no `agenda.json` e reagenda no mesmo
instante, sem reiniciar o servidor.

A validação roda antes de gravar e devolve o problema por tarefa (`"x":
horário inválido (10 da noite)`); quando falha, nada é escrito. O refresh
automático não redesenha a seção enquanto houver alteração não salva, para
não apagar o que está sendo digitado.

Rotas: `GET /api/horarios` (vocabulário de horários), `PUT /api/tarefas`
(salva a agenda inteira) e `POST /api/tarefas/:nome/executar`.

## Ritmo de digitação

O "digitando..." dura conforme o tamanho da mensagem: 45ms por caractere, com
piso de 1s, teto de 5s e variação de ±15% para o tempo não repetir. Entre uma
mensagem e a próxima há uma pausa de 800ms — o tempo em que a pessoa pensaria
na frase seguinte.

Digitação humana real fica entre 150 e 300ms por caractere, mas nesse ritmo uma
frase de 130 caracteres daria 20s de espera, somando por mensagem. 45ms é o
meio termo: varia com o tamanho, sem virar espera chata.

Ajuste em `DIGITANDO_MS_POR_CARACTERE`, `DIGITANDO_MIN_MS`,
`DIGITANDO_MAX_MS` e `PAUSA_ENTRE_MENSAGENS_MS`.

## Trocando de provedor de WhatsApp

No `.env`: `WHATSAPP_PROVIDER=zapi` ou `WHATSAPP_PROVIDER=evolution`.

### Evolution API (self-hosted)

Sobe a API, o Postgres e o Redis:

```bash
cd evolution
cp .env.example .env   # troque a chave e a senha
docker compose up -d
```

O painel fica em <http://localhost:8080/manager> e pede a
`AUTHENTICATION_API_KEY`. As portas 8080 (API) e 5434 (Postgres) são do
compose; o bot continua na 3000.

Criar a instância e ler o QR code:

```bash
curl -X POST http://localhost:8080/instance/create \
  -H "apikey: $AUTHENTICATION_API_KEY" -H 'Content-Type: application/json' \
  -d '{"instanceName":"bot","integration":"WHATSAPP-BAILEYS","qrcode":true}'
```

Apontar o webhook para o bot (de dentro do container, a máquina host é
`host.docker.internal`):

```bash
curl -X POST http://localhost:8080/webhook/set/bot \
  -H "apikey: $AUTHENTICATION_API_KEY" -H 'Content-Type: application/json' \
  -d '{"webhook":{"enabled":true,"url":"http://host.docker.internal:3000/webhook","events":["MESSAGES_UPSERT"]}}'
```

Depois, no `.env` do bot:

```
WHATSAPP_PROVIDER=evolution
EVOLUTION_BASE_URL=http://localhost:8080
EVOLUTION_INSTANCE=bot
EVOLUTION_API_KEY=<a mesma chave global>
```

A Z-API continua configurada e volta a valer trocando `WHATSAPP_PROVIDER`.
