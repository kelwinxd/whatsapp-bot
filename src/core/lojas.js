import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { montarDocumento, resumoParaPrompt, contarRespostas } from "./formularioLoja.js";

// Várias lojas no mesmo bot. Cada cadastro do formulário vira:
//
//   dados/lojas/<slug>.json   as respostas
//   loja-<slug>.md            o documento na base vetorial
//   PROMPT_PERFIL=loja_<slug> o perfil que atende por ela
//
// A busca é escopada ao documento da loja escolhida: sem isso, o bot da Sara
// Modas responderia com a política de troca de outra loja — foi exatamente o
// que aconteceu quando as duas conviveram na base.

export const nomeDoDocumento = (slug) => `loja-${slug}.md`;

export function gerarSlug(nome) {
  return String(nome ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export class Lojas {
  constructor({ pasta = "dados/lojas", base = null, logger = console }) {
    this.pasta = pasta;
    this.base = base;
    this.logger = logger;
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

    const lojas = [];
    for (const arquivo of arquivos) {
      const slug = arquivo.replace(/\.json$/, "");
      const loja = await this.obter(slug);
      if (loja) {
        lojas.push({
          slug,
          nome: loja.respostas.nome ?? slug,
          perfil: `loja_${slug}`,
          indexadoEm: loja.indexadoEm ?? null,
          progresso: contarRespostas(loja.respostas),
        });
      }
    }
    return lojas.sort((a, b) => a.nome.localeCompare(b.nome));
  }

  async obter(slug) {
    try {
      const dados = JSON.parse(await readFile(this.caminho(slug), "utf8"));
      return {
        slug,
        respostas: dados.respostas ?? {},
        indexadoEm: dados.indexadoEm ?? null,
        // O resumo é derivado, não salvo: mudar o formulário não deixa
        // resumo velho preso no arquivo.
        resumo: resumoParaPrompt(dados.respostas ?? {}),
        documento: nomeDoDocumento(slug),
      };
    } catch (erro) {
      if (erro.code === "ENOENT") return null;
      throw erro;
    }
  }

  /**
   * Salva e indexa. O slug vem do nome quando não informado, então cadastrar
   * "Sara Modas" cria loja_sara-modas.
   */
  async salvar({ slug, respostas }) {
    const identificador = slug || gerarSlug(respostas?.nome);
    if (!identificador) throw new Error("informe o nome da loja");

    const documento = montarDocumento(respostas);
    let pedacos = null;

    // Sem RAG ligado, as respostas são salvas e o resumo estruturado já vale;
    // só o texto corrido não vai para a busca.
    if (this.base && this.base.nome !== "nenhum") {
      ({ pedacos } = await this.base.indexar({
        nome: nomeDoDocumento(identificador),
        texto: documento,
      }));
    }

    const indexadoEm = new Date().toISOString();
    await mkdir(this.pasta, { recursive: true });
    await writeFile(
      this.caminho(identificador),
      `${JSON.stringify({ respostas, indexadoEm }, null, 2)}\n`,
      "utf8",
    );

    this.logger.log(
      `🏪 Loja "${respostas.nome ?? identificador}" salva${pedacos ? ` e indexada em ${pedacos} pedaço(s)` : " (RAG desligado)"}`,
    );

    return { slug: identificador, perfil: `loja_${identificador}`, documento, pedacos };
  }

  // Apaga as respostas e o documento da base: deixar o documento indexado
  // faria o bot responder por uma loja que não existe mais.
  async remover(slug) {
    const existia = (await this.obter(slug)) !== null;
    if (!existia) return { removida: false };

    await rm(this.caminho(slug), { force: true });
    let pedacos = 0;
    if (this.base && this.base.nome !== "nenhum") {
      pedacos = await this.base.remover(nomeDoDocumento(slug));
    }
    return { removida: true, pedacos };
  }
}
