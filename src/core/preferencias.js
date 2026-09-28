import { readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Escolhas feitas pelo painel, que precisam sobreviver ao restart.
//
// O .env continua sendo o padrão; isto é a camada de cima. Sem persistir, você
// trocaria o perfil no painel e o próximo restart voltaria calado para o valor
// do .env — o tipo de surpresa que faz perder tempo procurando bug onde não
// tem.

export function carregarPreferencias(arquivo) {
  try {
    return JSON.parse(readFileSync(arquivo, "utf8"));
  } catch (erro) {
    if (erro.code !== "ENOENT") {
      console.error(`⚠️  Não foi possível ler ${arquivo}: ${erro.message}`);
    }
    return {};
  }
}

export async function salvarPreferencias(arquivo, preferencias) {
  await mkdir(dirname(arquivo), { recursive: true });
  await writeFile(arquivo, `${JSON.stringify(preferencias, null, 2)}\n`, "utf8");
}
