import { readFile, writeFile } from "node:fs/promises";

// Tarefas da agenda em arquivo JSON, como no agenda.json de sempre.

export class ArquivoAgenda {
  constructor({ arquivo = "agenda.json", fusoHorario = "America/Sao_Paulo" } = {}) {
    this.arquivo = arquivo;
    this.fusoHorario = fusoHorario;
  }

  get nome() {
    return "arquivo";
  }

  async carregar() {
    try {
      const conteudo = JSON.parse(await readFile(this.arquivo, "utf8"));
      return conteudo.tarefas ?? [];
    } catch (erro) {
      if (erro.code === "ENOENT") return [];
      throw erro;
    }
  }

  async salvar(tarefas) {
    await writeFile(
      this.arquivo,
      `${JSON.stringify({ fusoHorario: this.fusoHorario, tarefas }, null, 2)}\n`,
      "utf8",
    );
    return tarefas;
  }
}
