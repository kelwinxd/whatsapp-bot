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

// Rótulos em português. Ficam aqui, junto das tabelas, para não haver duas
// fontes de verdade: o painel só exibe o que vem daqui.
export const ROTULOS_DIAS = {
  EVERY_DAY: "Todos os dias",
  MONDAY_TO_FRIDAY: "De segunda a sexta",
  WEEKEND: "Fim de semana",
  MONDAY: "Segunda-feira",
  TUESDAY: "Terça-feira",
  WEDNESDAY: "Quarta-feira",
  THURSDAY: "Quinta-feira",
  FRIDAY: "Sexta-feira",
  SATURDAY: "Sábado",
  SUNDAY: "Domingo",
};

export const ROTULOS_FREQUENCIAS = {
  EVERY_MINUTE: "A cada minuto (teste)",
  EVERY_5_MINUTES: "A cada 5 minutos (teste)",
  EVERY_30_MINUTES: "A cada 30 minutos",
  EVERY_HOUR: "A cada hora",
};

// "8_AM" -> "08:00 (8 AM)": mostra as duas leituras, porque quem pensa em 24h
// se perde no AM/PM e vice-versa.
export const rotuloDaHora = (nome) => {
  const hora = HORAS[nome];
  if (hora === undefined) return nome;
  const [numero, periodo] = nome.split("_");
  return `${String(hora).padStart(2, "0")}:00 (${numero} ${periodo})`;
};

// Lista para o painel montar os selects, sem duplicar as tabelas no navegador.
export const vocabulario = () => ({
  horas: Object.keys(HORAS)
    // 00_AM é apelido de 12_AM: no select ele viraria opção repetida.
    .filter((nome) => nome !== "00_AM")
    .map((nome) => ({ valor: nome, rotulo: rotuloDaHora(nome) })),
  dias: Object.keys(DIAS).map((valor) => ({ valor, rotulo: ROTULOS_DIAS[valor] ?? valor })),
  frequencias: Object.keys(FREQUENCIAS).map((valor) => ({
    valor,
    rotulo: ROTULOS_FREQUENCIAS[valor] ?? valor,
  })),
});

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

/**
 * Caminho inverso do resolverHorario: separa o que está salvo em hora, dias e
 * frequência, para o painel já abrir com os selects na posição certa. Quando o
 * valor é cron cru, devolve avancado — aí o painel mostra o campo de texto e
 * a expressão não se perde.
 */
export function decomporHorario(valor) {
  const texto = String(valor ?? "").trim();
  const emMaiuscula = texto.toUpperCase();

  if (FREQUENCIAS[emMaiuscula]) return { frequencia: emMaiuscula };

  const [parteHora, parteDias = "EVERY_DAY"] = texto.split("+").map((p) => p.trim().toUpperCase());

  if (HORAS[parteHora] !== undefined && DIAS[parteDias]) {
    // 00_AM e 12_AM são a mesma hora; o select só tem 12_AM.
    return { hora: parteHora === "00_AM" ? "12_AM" : parteHora, dias: parteDias };
  }

  return { avancado: texto };
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
