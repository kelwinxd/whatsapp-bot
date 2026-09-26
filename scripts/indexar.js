import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { config } from "../src/config.js";
import { montarDependencias } from "../src/core/registry.js";
import { custoDeEmbedding, emUSD } from "../src/core/billing.js";

// Indexa documentos na base de conhecimento:
//
//   npm run indexar manual.txt
//   npm run indexar docs/*.md
//
// Formatos: .txt e .md. PDF entra na fase 2 (precisa de biblioteca de
// extração); PDF escaneado precisaria de OCR.

const EXTENSOES = [".txt", ".md", ".markdown"];

const caminhos = process.argv.slice(2);

if (caminhos.length === 0) {
  console.error("Uso: npm run indexar <arquivo.txt|arquivo.md> [...]");
  process.exit(1);
}

if (config.rag.provedor === "nenhum") {
  console.error('❌ RAG está desligado. Ponha RAG_PROVIDER=memoria no .env e rode de novo.');
  process.exit(1);
}

const { base } = montarDependencias(config);
console.log(`📚 Base: ${base.nome} (${config.rag.arquivo})\n`);

let tokensTotais = 0;

for (const caminho of caminhos) {
  const nome = basename(caminho);

  if (!EXTENSOES.includes(extname(caminho).toLowerCase())) {
    console.error(`⏭️  ${nome}: formato não suportado ainda (use ${EXTENSOES.join(", ")})`);
    continue;
  }

  try {
    const texto = await readFile(caminho, "utf8");
    const { pedacos, uso } = await base.indexar({ nome, texto });
    tokensTotais += uso?.tokens ?? 0;
    console.log(`✅ ${nome}: ${pedacos} pedaço(s), ${uso?.tokens ?? "?"} tokens`);
  } catch (erro) {
    console.error(`❌ ${nome}: ${erro.message}`);
  }
}

const custo = custoDeEmbedding({ modelo: config.openai.modeloEmbedding, tokens: tokensTotais });
console.log(`\n💰 Custo da indexação: ${emUSD(custo)} (${tokensTotais} tokens)`);

const documentos = await base.documentos();
console.log(`📄 Na base agora: ${documentos.map((d) => `${d.nome} (${d.pedacos})`).join(", ") || "nada"}`);
