import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BaseDeConhecimento } from "../../core/ports.js";
import { quebrarEmPedacos } from "../../core/chunker.js";

// Base de conhecimento em arquivo JSON, com a busca por cosseno feita em
// memória. Some a necessidade de banco: alguns milhares de vetores carregados
// na RAM comparam em milissegundos.
//
// O limite prático é o arquivo: cada pedaço guarda 1.536 números, uns 20 KB em
// JSON. Perto de 2.000 pedaços (~40 MB) é hora do pgvector — a porta é a
// mesma, então trocar não mexe no resto.

const LIMIAR_PADRAO = 0.6;

// Vetores da OpenAI já vêm normalizados, mas dividir pelas normas custa pouco
// e evita resultado errado se um dia vier de outro provedor.
function similaridade(a, b) {
  let produto = 0;
  let normaA = 0;
  let normaB = 0;
  for (let i = 0; i < a.length; i++) {
    produto += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }
  const divisor = Math.sqrt(normaA) * Math.sqrt(normaB);
  return divisor === 0 ? 0 : produto / divisor;
}

export class MemoriaBase extends BaseDeConhecimento {
  /**
   * @param {object} params
   * @param {(textos: string[]) => Promise<{vetores: number[][], uso?: object}>} params.vetorizar
   *   Vem do adaptador de IA: a base não sabe quem gera embedding.
   */
  constructor({
    vetorizar,
    arquivo = "dados/base.json",
    limiar = LIMIAR_PADRAO,
    k = 5,
    pedaco = {},
  }) {
    super();
    this.vetorizar = vetorizar;
    this.arquivo = arquivo;
    this.limiar = limiar;
    this.k = k;
    // { tamanho, sobreposicao } — ver src/core/chunker.js
    this.pedaco = pedaco;
    /** @type {Array<{documento: string, posicao: number, conteudo: string, vetor: number[]}>} */
    this.pedacos = [];
    this.carregado = false;
  }

  get nome() {
    return "memoria";
  }

  // Carrega na primeira operação, não no construtor: montar as dependências
  // não deve depender de disco, e assim o teste injeta o que quiser.
  async carregar() {
    if (this.carregado) return;
    try {
      const conteudo = JSON.parse(await readFile(this.arquivo, "utf8"));
      this.pedacos = conteudo.pedacos ?? [];
    } catch (erro) {
      if (erro.code !== "ENOENT") throw erro;
      this.pedacos = [];
    }
    this.carregado = true;
  }

  async salvar() {
    await mkdir(dirname(this.arquivo), { recursive: true });
    await writeFile(
      this.arquivo,
      `${JSON.stringify({ atualizadoEm: new Date().toISOString(), pedacos: this.pedacos }, null, 1)}\n`,
      "utf8",
    );
  }

  async indexar({ nome, texto }) {
    await this.carregar();

    const conteudos = quebrarEmPedacos(texto, this.pedaco);
    if (conteudos.length === 0) {
      throw new Error(`"${nome}" não tem texto aproveitável (PDF escaneado?)`);
    }

    const { vetores, uso } = await this.vetorizar(conteudos);

    // Reindexar substitui o documento pelo nome, em vez de duplicar.
    this.pedacos = this.pedacos.filter((p) => p.documento !== nome);
    const indexadoEm = new Date().toISOString();
    conteudos.forEach((conteudo, posicao) => {
      this.pedacos.push({ documento: nome, posicao, conteudo, vetor: vetores[posicao], indexadoEm });
    });

    await this.salvar();
    return { documento: nome, pedacos: conteudos.length, uso };
  }

  /**
   * @param {string} pergunta
   * @param {number} k
   * @param {{ documentos?: string[] }} opcoes  Restringe a busca a esses
   *   documentos — é assim que o bot de uma loja não vê o material de outra.
   */
  async buscar(pergunta, k = this.k, { documentos } = {}) {
    await this.carregar();

    const candidatos = documentos
      ? this.pedacos.filter((p) => documentos.includes(p.documento))
      : this.pedacos;
    if (candidatos.length === 0) return [];

    const { vetores } = await this.vetorizar([pergunta]);
    const vetorDaPergunta = vetores[0];

    return candidatos
      .map((p) => ({
        conteudo: p.conteudo,
        documento: p.documento,
        posicao: p.posicao,
        distancia: 1 - similaridade(vetorDaPergunta, p.vetor),
      }))
      .sort((a, b) => a.distancia - b.distancia)
      .slice(0, k)
      // O corte é o que separa "não sei" de resposta inventada: a busca sempre
      // devolve os k mais próximos, mesmo quando nada tem a ver com a pergunta.
      .filter((p) => p.distancia < this.limiar);
  }

  async documentos() {
    await this.carregar();
    const porNome = new Map();
    for (const p of this.pedacos) {
      const atual = porNome.get(p.documento) ?? { nome: p.documento, pedacos: 0, indexadoEm: p.indexadoEm };
      atual.pedacos += 1;
      porNome.set(p.documento, atual);
    }
    return [...porNome.values()];
  }

  async remover(nome) {
    await this.carregar();
    const antes = this.pedacos.length;
    this.pedacos = this.pedacos.filter((p) => p.documento !== nome);
    const removidos = antes - this.pedacos.length;
    if (removidos > 0) await this.salvar();
    return removidos;
  }
}

// Usado quando RAG_PROVIDER=nenhum: responde ao contrato sem fazer nada, para
// o BotService não precisar de if em volta de cada chamada.
export class BaseNula extends BaseDeConhecimento {
  get nome() {
    return "nenhum";
  }
  async indexar() {
    throw new Error("RAG desligado: configure RAG_PROVIDER=memoria");
  }
  async buscar() {
    return [];
  }
  async documentos() {
    return [];
  }
  async remover() {
    return 0;
  }
}
