import { HORAS, DIAS, FREQUENCIAS, resolverHorario, descreverHorario } from "../src/core/horarios.js";

// Mostra o que o campo "cron" do agenda.json aceita:
//   npm run horarios
//   npm run horarios 9_AM+WEEKEND    (testa uma combinação)

const combinacao = process.argv[2];

if (combinacao) {
  const cron = resolverHorario(combinacao);
  console.log(
    cron
      ? `${combinacao} -> ${cron}  (${descreverHorario(cron)})`
      : `${combinacao} -> não reconhecido`,
  );
  process.exit(cron ? 0 : 1);
}

console.log("HORAS:");
console.log("  " + Object.keys(HORAS).join("  "));
console.log("\nDIAS:");
console.log("  " + Object.keys(DIAS).join("  "));
console.log("\nFREQUÊNCIAS:");
for (const [nome, cron] of Object.entries(FREQUENCIAS)) console.log(`  ${nome.padEnd(18)} ${cron}`);

console.log("\nCombine com +, e o dia é opcional:");
for (const exemplo of ["9_AM+EVERY_DAY", "10_PM+MONDAY_TO_FRIDAY", "00_AM+WEEKEND", "7_AM", "08:30+MONDAY_TO_FRIDAY"]) {
  const cron = resolverHorario(exemplo);
  console.log(`  ${exemplo.padEnd(24)} ${cron.padEnd(14)} ${descreverHorario(cron)}`);
}
