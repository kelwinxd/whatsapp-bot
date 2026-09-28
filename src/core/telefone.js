// Normalização de telefone, num lugar só.
//
// O WhatsApp identifica a conversa pelo número com DDI ("5519993723677"). Quem
// digita no painel escreve "(19) 99372-3677" e esquece o 55 — e aí a pausa (ou
// o disparo) aponta para um número que não existe, sem erro nenhum aparecendo.
// Aconteceu em teste: pausei "19993723677" e a conversa real seguiu solta.

const DDI_BRASIL = "55";

/**
 * Deixa só dígitos e acrescenta o DDI do Brasil quando o número tem cara de
 * nacional sem ele (10 dígitos = fixo com DDD, 11 = celular com nono dígito).
 * Número que já vem com DDI, ou de outro país, passa intacto.
 */
export function normalizarTelefone(valor) {
  const digitos = String(valor ?? "").replace(/\D/g, "");
  if (digitos.length === 10 || digitos.length === 11) return `${DDI_BRASIL}${digitos}`;
  return digitos;
}

export const normalizarTelefones = (valores) =>
  (Array.isArray(valores) ? valores : String(valores ?? "").split(/[,;]/))
    .map(normalizarTelefone)
    .filter(Boolean);
