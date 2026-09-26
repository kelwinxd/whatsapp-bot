// Horário por composição: HORA + DIAS, no estilo das constantes de cron do
// Nest. No agenda.json o campo "cron" recebe a combinação como texto:
//
//   "9_AM+EVERY_DAY"          -> 0 9 * * *
//   "10_PM+MONDAY_TO_FRIDAY"  -> 0 22 * * 1-5
//   "00_AM+WEEKEND"           -> 0 0 * * 0,6
//   "9_AM"                    -> 0 9 * * *     (sem dias = todos os dias)
//   "08:30+MONDAY_TO_FRIDAY"  -> 30 8 * * 1-5  (quando precisa de minuto)
//   "0 10,14,17 * * 1-5"      -> cron cru, para o que a composição não cobre
//
// Duas tabelas pequenas em vez de uma lista enorme de nomes prontos: é o
// mesmo conjunto de possibilidades, sem precisar decorar combinação.

export const HORAS = {
  "12_AM": 0,
  "00_AM": 0, // mesmo que 12_AM, para quem pensa em 24h
  "1_AM": 1,
  "2_AM": 2,
  "3_AM": 3,
  "4_AM": 4,
  "5_AM": 5,
  "6_AM": 6,
  "7_AM": 7,
  "8_AM": 8,
  "9_AM": 9,
  "10_AM": 10,
  "11_AM": 11,
  "12_PM": 12,
  "1_PM": 13,
  "2_PM": 14,
  "3_PM": 15,
  "4_PM": 16,
  "5_PM": 17,
  "6_PM": 18,
  "7_PM": 19,
  "8_PM": 20,
  "9_PM": 21,
  "10_PM": 22,
  "11_PM": 23,
};

export const DIAS = {
  EVERY_DAY: "*",
  MONDAY_TO_FRIDAY: "1-5",
  WEEKEND: "0,6",
  SUNDAY: "0",
  MONDAY: "1",
  TUESDAY: "2",
  WEDNESDAY: "3",
  THURSDAY: "4",
  FRIDAY: "5",
  SATURDAY: "6",
};

// Frequências, para testar uma tarefa nova sem esperar o horário.
export const FREQUENCIAS = {
  EVERY_MINUTE: "* * * * *",
  EVERY_5_MINUTES: "*/5 * * * *",
  EVERY_30_MINUTES: "*/30 * * * *",
  EVERY_HOUR: "0 * * * *",
};

const REGEX_HORA_MINUTO = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Monta a expressão cron a partir de hora, minuto e dias. */
export const montarCron = (hora, minuto, dias) => `${minuto} ${hora} * * ${dias}`;

/**
 * Traduz o que veio no agenda.json para uma expressão cron.
 * Devolve null quando não reconhece — chutar aqui viraria mensagem no
 * horário errado, ou mensagem nenhuma.
 */
export function resolverHorario(valor) {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();

  if (FREQUENCIAS[limpo.toUpperCase()]) return FREQUENCIAS[limpo.toUpperCase()];

  // Cinco campos separados por espaço: cron cru, validado depois pelo node-cron.
  if (limpo.split(/\s+/).length === 5) return limpo;

  const [parteHora, parteDias = "EVERY_DAY"] = limpo.split("+").map((p) => p.trim());
  const dias = DIAS[parteDias.toUpperCase()];
  if (!dias) return null;

  const horaNomeada = HORAS[parteHora.toUpperCase()];
  if (horaNomeada !== undefined) return montarCron(horaNomeada, 0, dias);

  const horaMinuto = REGEX_HORA_MINUTO.exec(parteHora);
  if (horaMinuto) return montarCron(Number(horaMinuto[1]), Number(horaMinuto[2]), dias);

  return null;
}

// Em português, para o log e o painel: "0 9 * * 1-5" não diz nada a quem não
// conhece a sintaxe.
export function descreverHorario(cronExpressao) {
  const partes = String(cronExpressao).split(/\s+/);
  if (partes.length !== 5) return cronExpressao;

  const [minuto, hora, , , diaSemana] = partes;
  if (hora === "*" || minuto.includes("*")) return cronExpressao;

  const nomesDeDias = {
    "*": "todos os dias",
    "1-5": "de segunda a sexta",
    "0,6": "sábado e domingo",
    0: "domingo",
    1: "segunda",
    2: "terça",
    3: "quarta",
    4: "quinta",
    5: "sexta",
    6: "sábado",
  };
  const quando = nomesDeDias[diaSemana] ?? `nos dias ${diaSemana} da semana`;

  const horas = hora
    .split(",")
    .map((h) => `${String(h).padStart(2, "0")}:${String(minuto).padStart(2, "0")}`)
    .join(", ");

  return `${horas}, ${quando}`;
}
