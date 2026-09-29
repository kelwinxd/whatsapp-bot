import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Armazenamento das lojas em arquivo: um JSON por loja, como era antes de
// existir banco. Continua sendo o padrão para rodar sem infra nenhuma.
//
// A classe Lojas cuida do documento e da indexação; isto aqui só guarda e lê.

export class ArquivoLojas {
  constructor({ pasta = "dados/lojas" } = {}) {
    this.pasta = pasta;
  }

  get nome() {
    return "arquivo";
  }

  caminho(slug) {
    return join(this.pasta, `${slug}.json`);
  }

  async listar() {
    let arquivos = [];
    try {
      arquivos = (await readdir(this.pasta)).filter((a) => a.endsWith(".json"));
    } catch (erro) {
      if (erro.code !== "ENOENT") throw erro;
      return [];
    }

    const registros = [];
    for (const arquivo of arquivos) {
      const registro = await this.obter(arquivo.replace(/\.json$/, ""));
      if (registro) registros.push(registro);
    }
    return registros;
  }

  async obter(slug) {
    try {
      const dados = JSON.parse(await readFile(this.caminho(slug), "utf8"));
      return { slug, respostas: dados.respostas ?? {}, indexadoEm: dados.indexadoEm ?? null };
    } catch (erro) {
      if (erro.code === "ENOENT") return null;
      throw erro;
    }
  }

  async salvar({ slug, respostas, indexadoEm }) {
    await mkdir(this.pasta, { recursive: true });
    await writeFile(
      this.caminho(slug),
      `${JSON.stringify({ respostas, indexadoEm }, null, 2)}\n`,
      "utf8",
    );
    return { slug, respostas, indexadoEm };
  }

  async remover(slug) {
    if (!(await this.obter(slug))) return false;
    await rm(this.caminho(slug), { force: true });
    return true;
  }
}
