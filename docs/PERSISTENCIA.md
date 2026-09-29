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
| 2 | Pausas do atendimento humano | segundo bug de verdade: deploy no meio de um atendimento |
| 3 | Lojas, preferências e agenda | o passo que permite duas instâncias |
| 4 | Base do RAG em pgvector | quando a base passar de alguns milhares de pedaços |
| 5 | Métricas e eventos | último: hoje servem para olhar o agora, não o histórico |

Cada etapa é um adaptador novo e uma linha no `registry.js`. Nada de "parar
tudo e migrar".

## Etapa 1, já feita

```bash
# o Postgres da Evolution já roda; basta um database separado
docker exec evolution_postgres psql -U evolution -d postgres -c "CREATE DATABASE wpbot"
npm run migrar
```

E no `.env`:

```
DATABASE_URL=postgresql://evolution:<senha>@localhost:5434/wpbot
HISTORY_STORE=postgres
```

A tabela guarda a conversa inteira e a leitura traz só as últimas
`MAX_HISTORICO` mensagens: o corte é de quanto vai para o modelo, não de quanto
fica registrado. Conversa antiga serve para auditoria e relatório; apagar vira
política de retenção, não limite de prompt.

Em produção o banco não seria o mesmo da Evolution — seria um serviço próprio,
com backup. Aqui reaproveitar o container que já existe evita subir mais um
para provar a ideia.
