# Persistência: o que sai do JSON quando isso for para produção

Hoje o estado do bot está em três lugares: memória, arquivos JSON e o `.env`.
Funciona no seu computador e não funciona em produção. Este documento registra
o porquê, o destino de cada coisa e a ordem de migração.

## Onde está cada coisa hoje

| Estado | Onde | Problema em produção |
| --- | --- | --- |
| Histórico das conversas | memória | some a cada restart — o bot trata toda mensagem como a primeira e se apresenta de novo |
| Pausas do atendimento humano | memória | um deploy devolve ao bot conversas que uma pessoa estava conduzindo |
| Métricas e eventos | memória | zeram; não dá para saber o que aconteceu ontem |
| Lojas cadastradas | `dados/lojas/*.json` | duas instâncias sobrescrevem uma à outra; sem histórico de alteração |
| Preferências (perfil ativo) | `dados/preferencias.json` | idem |
| Agenda | `agenda.json` | idem |
| Base do RAG | `dados/base.json` | o arquivo inteiro é lido e reescrito a cada mudança; acima de ~2.000 pedaços fica inviável |
| Segredos | `.env` | correto — é o único que fica |

## Por que JSON não sobe

**Escrita concorrente.** Dois pedidos salvando ao mesmo tempo fazem ler,
alterar e regravar o arquivo inteiro: a última escrita apaga a primeira, sem
erro nenhum aparecendo.

**Mais de uma instância.** Assim que houver dois processos (escala horizontal,
deploy sem downtime, um worker separado para a agenda), cada um tem a sua cópia
em disco. Não existe "o" estado.

**Consulta.** "Quantas conversas tivemos esta semana?" ou "quais perguntas
ficaram sem resposta?" viram varredura de arquivo.

**Backup e auditoria.** Sem transação, sem ponto de restauração, sem histórico
de quem mudou o quê e quando.

**Deploy.** Container é efêmero: subiu de novo, o disco vem vazio. Guardar em
arquivo exige volume, e volume não resolve concorrência nem múltiplas
instâncias.

## Para onde vai

**Postgres para tudo que precisa durar** — histórico, pausas, lojas,
preferências, agenda, métricas — e **pgvector** para a base do RAG, que é o
mesmo banco com uma extensão. Um banco só, e não um serviço por tipo de dado.

**Redis é opcional**, e só para o que é quente e descartável: cache, contadores
de limite por cliente, fila. Histórico de conversa cabe nos dois; começar pelo
Postgres evita manter dois bancos antes da hora.

**O `.env` continua** com o que é segredo: chaves de API, URL do banco.

A arquitetura de portas já prepara isso: `MemoriaRepo` e `PostgresRepo` são
adaptadores da mesma porta, e o `BotService` não muda.

## Ordem de migração

| Etapa | O quê | Por que nessa ordem |
| --- | --- | --- |
| 1 ✅ | Histórico em Postgres (`HISTORY_STORE=postgres`) | é o que já causa bug visível: o bot se apresentando toda mensagem |
| 2 ✅ | Pausas do atendimento humano | segundo bug de verdade: deploy no meio de um atendimento |
| 3 ✅ | Lojas, preferências e agenda | o passo que permite duas instâncias |
| 4 | Base do RAG em pgvector | quando a base passar de alguns milhares de pedaços |
| 5 | Métricas e eventos | último: hoje servem para olhar o agora, não o histórico |

Cada etapa é um adaptador novo e uma linha no `registry.js`. Nada de "parar
tudo e migrar".

## Etapas 1, 2 e 3, já feitas

```bash
# o Postgres da Evolution já roda; basta um database separado
docker exec evolution_postgres psql -U evolution -d postgres -c "CREATE DATABASE wpbot"
npm run migrar
```

E no `.env`:

```
DATABASE_URL=postgresql://evolution:<senha>@localhost:5434/wpbot
HISTORY_STORE=postgres
# PAUSAS_STORE segue o HISTORY_STORE quando não é declarado
```

Cinco tabelas: `conversas`, `pausas`, `lojas`, `tarefas` e `preferencias`. O
`npm run migrar` cria todas e **importa o que já existe em arquivo** quando a
tabela está vazia — migrar não significa recadastrar na mão. Rodar de novo não
duplica, porque a importação só acontece em tabela vazia.

Para ligar a etapa 3: `ESTADO_STORE=postgres` (lojas, agenda e preferências
migram juntas, porque são a mesma coisa: configuração de operação).

As respostas do formulário ficam em JSONB: o formulário ganha campo com
frequência, e uma coluna por pergunta viraria migração a cada pergunta nova.
O que se consulta (o slug) é coluna de verdade.

A agenda é salva substituindo a lista inteira, dentro de uma transação — o
painel manda o que está na tela, e tarefa removida tem que sumir do banco sem
existir um instante com a agenda vazia.

Verificado contra o banco de verdade: três processos distintos continuaram a
mesma conversa (a apresentação veio só no primeiro), uma pausa criada num
processo apareceu no outro com o prazo certo, e salvar loja, agenda e perfil
pelo painel gravou nas tabelas.

A tabela guarda a conversa inteira e a leitura traz só as últimas
`MAX_HISTORICO` mensagens: o corte é de quanto vai para o modelo, não de quanto
fica registrado. Conversa antiga serve para auditoria e relatório; apagar vira
política de retenção, não limite de prompt.

Em produção o banco não seria o mesmo da Evolution — seria um serviço próprio,
com backup. Aqui reaproveitar o container que já existe evita subir mais um
para provar a ideia.

## Trocar de banco depois (MySQL, SQLite, o que for)

O desenho já permite: **só os adaptadores conhecem banco**. Nada em `src/core`
importa `pg` nem escreve SQL, e o `npm run migrar` pede os adaptadores ao
registry e chama `migrar()` em quem tiver — ele não sabe qual banco está
atrás.

Trocar significa: escrever `MySqlRepo`, `MySqlLojas` e companhia, acrescentar
uma linha em cada catálogo do `registry.js` e mudar o `.env`. Nenhum arquivo do
núcleo muda.

O que cada adaptador novo vai ter de reescrever, porque é dialeto e não
conceito:

| No Postgres | No MySQL |
| --- | --- |
| `$1`, `$2` | `?` |
| `ON CONFLICT (x) DO UPDATE` | `ON DUPLICATE KEY UPDATE` |
| `RETURNING *` | não existe: `INSERT` e depois `SELECT` |
| `JSONB` com `->>'campo'` | `JSON` com `->>'$.campo'` |
| `TEXT[]` (telefones) | sem array: JSON ou tabela filha |
| `TIMESTAMPTZ` | `DATETIME`/`TIMESTAMP`, sem fuso |
| `now() + INTERVAL '1 minute'` | `DATE_ADD(now(), INTERVAL ? MINUTE)` |
| `BIGSERIAL` | `BIGINT AUTO_INCREMENT` |

O caso mais chato é o `TEXT[]` dos telefones da agenda, que não tem equivalente
direto. Num adaptador MySQL viraria coluna JSON.

### E um ORM não resolveria isso?

Prisma, Drizzle ou Knex geram SQL para vários dialetos e evitariam reescrever
as consultas. Em troca: mais uma dependência, um jeito próprio de fazer
migração e, mesmo assim, as diferenças de verdade continuam aparecendo (array,
operador de JSON, `RETURNING`).

Vale quando existirem vários bancos de fato, ou um time grande escrevendo
consulta. Para dois adaptadores escritos uma vez, SQL direto é menos peça
móvel — e cada adaptador fica idiomático no seu banco, em vez de todos ficarem
no menor denominador comum.

A recomendação, então: manter portas e escrever o segundo adaptador **quando a
necessidade for real**, não antes.
