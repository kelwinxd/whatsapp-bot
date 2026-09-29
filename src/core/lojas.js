import { montarDocumento, resumoParaPrompt, contarRespostas } from "./formularioLoja.js";
import { ArquivoLojas } from "../adapters/lojas/ArquivoLojas.js";

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
  /**
   * @param {object} params
   * @param {object} [params.repo] Onde guardar (arquivo ou Postgres). O
   *   documento e a indexação continuam sendo responsabilidade daqui.
   */
  constructor({ repo = null, pasta = "dados/lojas", base = null, logger = console }) {
    this.repo = repo ?? new ArquivoLojas({ pasta });
    this.base = base;
    this.logger = logger;
  }

  get nome() {
    return this.repo.nome;
  }

  async listar() {
    const registros = await this.repo.listar();
    return registros
      .map((registro) => ({
        slug: registro.slug,
        nome: registro.respostas.nome ?? registro.slug,
        perfil: `loja_${registro.slug}`,
        indexadoEm: registro.indexadoEm ?? null,
        progresso: contarRespostas(registro.respostas),
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }

  async obter(slug) {
    const registro = await this.repo.obter(slug);
    if (!registro) return null;

    return {
      slug,
      respostas: registro.respostas,
      indexadoEm: registro.indexadoEm,
      // O resumo é derivado, não guardado: mudar o formulário não deixa
      // resumo velho preso no armazenamento.
      resumo: resumoParaPrompt(registro.respostas),
      documento: nomeDoDocumento(slug),
    };
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
    await this.repo.salvar({ slug: identificador, respostas, indexadoEm });

    this.logger.log(
      `🏪 Loja "${respostas.nome ?? identificador}" salva${pedacos ? ` e indexada em ${pedacos} pedaço(s)` : " (RAG desligado)"}`,
    );

    return { slug: identificador, perfil: `loja_${identificador}`, documento, pedacos };
  }

  // Apaga as respostas e o documento da base: deixar o documento indexado
  // faria o bot responder por uma loja que não existe mais.
  async remover(slug) {
    const removida = await this.repo.remover(slug);
    if (!removida) return { removida: false };

    let pedacos = 0;
    if (this.base && this.base.nome !== "nenhum") {
      pedacos = await this.base.remover(nomeDoDocumento(slug));
    }
    return { removida: true, pedacos };
  }
}
