import { HORARIOS, descreverHorario } from "../src/core/horarios.js";

// Lista os horários com nome, para usar no agenda.json:
//   npm run horarios
//   npm run horarios uteis

const filtro = (process.argv[2] ?? "").toUpperCase();
const nomes = Object.keys(HORARIOS).filter((n) => n.includes(filtro));

console.log(`${nomes.length} horário(s)${filtro ? ` com "${filtro}"` : ""}:\n`);
for (const nome of nomes) {
  console.log(`  ${nome.padEnd(26)} ${HORARIOS[nome].padEnd(16)} ${descreverHorario(HORARIOS[nome])}`);
}
console.log(`\nNo agenda.json também valem "08:30" (todos os dias) e cron cru ("0 8 * * 1-5").`);
