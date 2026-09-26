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
