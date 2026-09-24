import { config, exigirVariaveis } from "../src/config.js";
import { montarDependencias } from "../src/core/registry.js";

// Envio manual, para treinar e conferir o provedor ativo sem depender de
// alguém mandar mensagem primeiro:
//
//   npm run enviar                          -> texto padrão para NUMBER_TEST
//   npm run enviar -- "oi, teste"           -> texto próprio para NUMBER_TEST
//   npm run enviar -- "oi" 5519999999999    -> texto e destino próprios
//
// Usa o mesmo adaptador do bot: trocando WHATSAPP_PROVIDER, este script passa
// a enviar pelo outro provedor sem mudar uma linha.

const [texto = "Teste do bot 🤖", numero = config.numeroTeste] = process.argv.slice(2);

exigirVariaveis(["NUMBER_TEST"], { NUMBER_TEST: numero });

const { whatsapp } = montarDependencias(config);

console.log(`📤 Enviando por ${whatsapp.nome} para ${numero}...`);

const resposta = await whatsapp.enviarTexto({
  telefone: numero,
  texto,
  digitandoMs: 2000,
});

console.log("✅ Enviado:", JSON.stringify(resposta).slice(0, 200));
