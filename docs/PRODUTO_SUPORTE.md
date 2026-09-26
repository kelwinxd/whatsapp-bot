# Produto: suporte por WhatsApp para lojas

Notas de desenho para transformar este bot em produto vendido a lojas — como
alimentar a base com gente leiga, como fica a conta da OpenAI, o que precisa
mudar no código e onde está o risco real.

Não é plano de execução: é o mapa das decisões, para consultar quando cada uma
chegar.

## O problema central: quem alimenta a base

O dono da loja não vai escrever um manual. Pedir "me manda um documento com as
regras da loja" é onde a maioria dos onboardings morre — a pessoa promete
mandar, não manda, e o produto nunca entra em uso.

O que funciona, em ordem de eficácia:

### 1. Formulário guiado, não editor de texto

Perguntas específicas em vez de campo livre:

- Qual o horário de funcionamento? (por dia da semana)
- Vocês entregam? Qual a taxa e o prazo?
- Quais formas de pagamento?
- Qual a política de troca e devolução?
- Endereço e ponto de referência.
- O que vocês **não** fazem? (o que mais gera pergunta frustrada)

O sistema monta o documento por trás. A diferença é psicológica: "me conte
sobre sua loja" paralisa; "vocês entregam?" se responde em dez segundos.

### 2. Dado estruturado para o que precisa de precisão

Horário, preço, prazo e taxa **não** deveriam passar por RAG. Viram campos, e
o bot lê o valor exato. RAG é para texto corrido: política de troca, descrição
de serviço, FAQ longo.

Misturar os dois é o erro clássico — o modelo "quase acerta" um preço, e quase
acertar preço é pior que não responder.

Na prática: um `perfilDaLoja` estruturado (JSON/tabela) que entra no prompt
sempre, e a base vetorial só para o resto.

### 3. Importar do que a loja já tem

Ela já tem site, Instagram, catálogo em planilha, PDF de tabela de preços,
ficha no Google Meu Negócio. Puxar dali e pedir revisão converte muito mais que
pedir para produzir algo novo. Ordem de utilidade: site → planilha de
produtos → PDF de preços → redes sociais.

### 4. A base aprendendo com as conversas (o pulo do gato)

Quando o bot não encontra resposta, ele registra a pergunta como **lacuna** e
manda para o dono, no WhatsApp dele:

> Um cliente perguntou: "vocês entregam no Jardim Paulista?"
> Me diz o que responder e eu já guardo.

O dono responde ali mesmo. A resposta entra na base e passa a valer para todo
mundo. O leigo nunca abre painel: ele só responde mensagem, que é o que já faz
o dia inteiro.

Isso resolve três coisas de uma vez: a base melhora com uso real, o dono vê
valor na primeira semana, e as perguntas que ficam sem resposta viram a lista
de prioridades do produto.

### 5. Onboarding assistido nos primeiros clientes

Uma call de 30 minutos em que você pergunta e preenche por ele. Não escala para
mil clientes, mas nos dez primeiros é o que mais ensina o que o produto
precisa. Escalar depois é transformar o roteiro dessa call no formulário
guiado.

### 6. Saída humana sempre

Quando não sabe, transferir para atendente com o histórico — nunca inventar.
Isso pesa mais na percepção de qualidade que o tamanho da base.

**Conclusão:** formulário guiado + importação do site + lacunas pelo WhatsApp.
Upload de arquivo fica como opção para quem já tem manual pronto.

## A conta da OpenAI

**Uma conta só, sua.** O cliente nunca vê chave. É o modelo padrão de SaaS:
você tem a conta, paga a OpenAI e cobra assinatura.

Como organizar:

- **Projects** dentro da sua organização: um por cliente, com chave e limite de
  gasto próprios. Dá rastreamento de custo por cliente sem abrir contas.
- **Rastreamento no código.** O bot já registra os tokens de cada resposta (ver
  `src/core/billing.js` e `src/core/Metricas.js`); falta marcar de qual cliente
  veio. É isso que revela a margem por cliente e o cliente que gasta 50x a
  média.
- **Teto por cliente.** Sem limite, um loop ou um cliente anormal come a
  margem. Limite diário, com aviso antes de cortar.

**A alternativa (BYOK):** o cliente cria a conta e cola a chave. Some o custo
variável do seu lado, mas dono de loja não vai criar conta em plataforma
americana com cartão internacional. Só funciona em produto para desenvolvedor.

## A conta que fecha (ou não)

Uma loja com 500 conversas por mês, respostas de texto:

| Item | Custo mensal |
| --- | --- |
| OpenAI (500 respostas) | US$ 0,04 ≈ R$ 0,20 |
| WhatsApp Cloud API | por conversa iniciada pela loja |
| VPS compartilhada entre clientes | R$ 30 ÷ N clientes |
| **Custo marginal por loja** | **poucos reais** |

Assinatura de R$ 99 a R$ 300 por loja tem margem enorme. O custo real do
negócio é **suporte, onboarding e o WhatsApp** — não o modelo.

Por isso: **cobrar assinatura, não por mensagem.** Cobrança por mensagem faz o
cliente ter medo de usar o produto, e o custo não justifica o atrito.

## O que precisa mudar no código

Hoje é single-tenant: uma instância de Evolution, uma base, um `.env`.

| Hoje | Multi-tenant |
| --- | --- |
| `.env` único | configuração por cliente (banco), `.env` só para segredos globais |
| `agenda.json` | tabela de tarefas com coluna de cliente |
| `dados/base.json` | `PostgresBase` com coluna de cliente (a porta já existe) |
| histórico em memória | Postgres ou Redis, por telefone e cliente |
| uma instância no `.env` | uma instância de WhatsApp por loja, resolvida pelo webhook |
| painel local sem senha | painel com login, escopo por cliente |

A arquitetura de portas ajuda de verdade aqui: trocar `MemoriaBase` por
`PostgresBase` e `MemoriaRepo` por `PostgresRepo` não mexe no `BotService`. Mas
o resto — roteamento por instância, autenticação, provisionamento — é
refatoração de verdade, não ajuste.

**O roteamento é a peça nova mais importante:** o webhook precisa descobrir de
qual loja é a mensagem (pela instância ou pelo número que recebeu) e carregar a
configuração daquela loja antes de responder.

## O risco que muda de natureza

**WhatsApp deixa de ser detalhe técnico e vira risco de negócio.** Vender para
lojas rodando em Evolution/Baileys significa que o número do cliente pode ser
banido — e a culpa será sua, com o cliente perdendo o canal de vendas.

Para produto: **Cloud API oficial**, template aprovado, opt-in. Possivelmente
virando Tech Provider da Meta para provisionar números dos clientes. Custa por
conversa e dá mais trabalho, mas é o que sustenta um contrato.

O `EvolutionAdapter` já serviria: a Evolution fala com a Cloud API também
(`integration: "WHATSAPP-BUSINESS"`).

## LGPD

Conversas dos clientes das lojas passando pela sua infraestrutura te colocam
como operador de dados:

- contrato com a loja definindo papéis (ela é controladora, você operador);
- política de privacidade e aviso no primeiro contato do bot;
- retenção definida: por quanto tempo guarda conversa, e como apaga a pedido;
- a API da OpenAI não treina com os dados enviados por padrão, o que ajuda, mas
  a responsabilidade pelo tratamento continua sua.

Não é opinião jurídica — se virar operação comercial, vale um advogado.

## Ordem sugerida

| Fase | Entrega | Por que nessa ordem |
| --- | --- | --- |
| 1 | Uma loja de verdade, onboarding assistido, ainda single-tenant | descobre o que falta antes de generalizar |
| 2 | Lacunas pelo WhatsApp + perfil estruturado da loja | é o que faz a base ficar boa sem painel |
| 3 | Multi-tenant (banco, roteamento por instância, painel com login) | só depois de saber o que uma loja precisa |
| 4 | Cloud API oficial | quando o contrato justificar o custo por conversa |
| 5 | Formulário guiado e importação do site | escala o onboarding sem você na call |

A tentação é começar pela 3 e pela 5, porque parecem "o produto". Começar pela
1 é o que evita construir painel para um fluxo que ninguém usa.
