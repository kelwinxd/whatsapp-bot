import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// Preferências do painel (hoje, o perfil ativo) em arquivo JSON.

export class ArquivoPreferencias {
  constructor({ arquivo = "dados/preferencias.json" } = {}) {
    this.arquivo = arquivo;
  }

  get nome() {
    return "arquivo";
  }

  async ler() {
    try {
      return JSON.parse(await readFile(this.arquivo, "utf8"));
    } catch (erro) {
      if (erro.code === "ENOENT") return {};
      throw erro;
    }
  }

  async gravar(preferencias) {
    await mkdir(dirname(this.arquivo), { recursive: true });
    await writeFile(this.arquivo, `${JSON.stringify(preferencias, null, 2)}\n`, "utf8");
    return preferencias;
  }
}
