// Horários com nome, para não ter que escrever cron na mão.
//
// A sintaxe cron são cinco campos: minuto, hora, dia do mês, mês, dia da
// semana. "0 9 * * 1-5" = 9:00, de segunda a sexta. É compacto, mas fácil de
// errar — e um erro aqui só apareceria na hora em que a mensagem não chegou.
//
// No agenda.json o campo "cron" aceita três formas:
//   "TODO_DIA_8AM"     um nome deste arquivo
//   "08:30"            hora e minuto, todos os dias
//   "0 8 * * 1-5"      cron cru, para casos que os nomes não cobrem

const DIAS = {
  TODO_DIA: "*",
  DIAS_UTEIS: "1-5", // segunda a sexta
  FIM_DE_SEMANA: "0,6", // domingo e sábado
};

// 12AM é meia-noite (hora 0) e 12PM é meio-dia (hora 12) — a convenção que
// confunde todo mundo, resolvida aqui de uma vez.
const hora24 = (hora12, periodo) => {
  const base = hora12 % 12;
  return periodo === "AM" ? base : base + 12;
};

function gerarHorarios() {
  const tabela = {};

  for (const [nomeDias, dias] of Object.entries(DIAS)) {
    for (const periodo of ["AM", "PM"]) {
      for (let hora12 = 1; hora12 <= 12; hora12++) {
        const hora = hora24(hora12, periodo);
        // TODO_DIA_8AM, DIAS_UTEIS_9AM, FIM_DE_SEMANA_10PM...
        tabela[`${nomeDias}_${hora12}${periodo}`] = `0 ${hora} * * ${dias}`;
        // E a variante na meia hora: TODO_DIA_8_30AM
        tabela[`${nomeDias}_${hora12}_30${periodo}`] = `30 ${hora} * * ${dias}`;
      }
    }
  }

  return {
    ...tabela,
    // Atalhos de frequência, úteis para testar uma tarefa nova.
    CADA_MINUTO: "* * * * *",
    CADA_5_MINUTOS: "*/5 * * * *",
    CADA_30_MINUTOS: "*/30 * * * *",
    CADA_HORA: "0 * * * *",
  };
}

export const HORARIOS = gerarHorarios();

const REGEX_HORA = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/**
 * Traduz o que veio no agenda.json para uma expressão cron.
 * Devolve null quando não reconhece — quem chama decide o que fazer.
 */
export function resolverHorario(valor) {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim();

  if (HORARIOS[limpo.toUpperCase()]) return HORARIOS[limpo.toUpperCase()];

  const hora = REGEX_HORA.exec(limpo);
  if (hora) return `${Number(hora[2])} ${Number(hora[1])} * * *`;

  // Cinco campos: assume-se cron cru, e a validação fica com o node-cron.
  if (limpo.split(/\s+/).length === 5) return limpo;

  return null;
}

// Em português, para o log e o painel: "TODO_DIA_8AM" não diz muito a quem
// não abriu este arquivo.
export function descreverHorario(cronExpressao) {
  const partes = String(cronExpressao).split(/\s+/);
  if (partes.length !== 5) return cronExpressao;

  const [minuto, hora, , , diaSemana] = partes;
  if (hora === "*" || minuto.includes("*")) return cronExpressao;

  const quando =
    diaSemana === "1-5"
      ? "de segunda a sexta"
      : diaSemana === "0,6"
        ? "sábado e domingo"
        : diaSemana === "*"
          ? "todos os dias"
          : `nos dias ${diaSemana} da semana`;

  const horas = hora
    .split(",")
    .map((h) => `${String(h).padStart(2, "0")}:${String(minuto).padStart(2, "0")}`)
    .join(", ");

  return `${horas}, ${quando}`;
}
