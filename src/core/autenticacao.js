import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

// Autenticação do painel: uma senha no .env e um cookie assinado.
//
// Sessão sem estado: o cookie carrega a validade e uma assinatura HMAC. O
// servidor não guarda sessão nenhuma, então reiniciar não desloga ninguém e
// duas instâncias aceitam o mesmo cookie — desde que compartilhem o segredo.
//
// Não é login de múltiplos usuários: é uma porta com cadeado para um painel de
// operação. Quando houver mais de uma pessoa (e o produto multi-loja vai
// exigir), isto vira usuário, papel e sessão em banco.

const HORAS_PADRAO = 12;

const base64url = (buffer) =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const assinar = (texto, segredo) =>
  base64url(createHmac("sha256", segredo).update(texto).digest());

// Comparação em tempo constante: com === o tempo de resposta entregaria
// quantos caracteres da assinatura estavam certos.
function iguais(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function criarToken({ segredo, horas = HORAS_PADRAO, agora = Date.now() }) {
  const expiraEm = agora + horas * 60 * 60 * 1000;
  return `${expiraEm}.${assinar(String(expiraEm), segredo)}`;
}

export function tokenValido({ token, segredo, agora = Date.now() }) {
  const [expiraEm, assinatura] = String(token ?? "").split(".");
  if (!expiraEm || !assinatura) return false;
  if (!iguais(assinatura, assinar(expiraEm, segredo))) return false;
  return Number(expiraEm) > agora;
}

export const senhaConfere = (recebida, esperada) => iguais(recebida ?? "", esperada);

/** Lê um cookie do cabeçalho, sem depender de biblioteca. */
export function lerCookie(cabecalho, nome) {
  return (
    String(cabecalho ?? "")
      .split(";")
      .map((parte) => parte.trim().split("="))
      .find(([chave]) => chave === nome)?.[1] ?? null
  );
}

// Segredo derivado da senha quando não há um próprio: o cookie continua
// assinado, e trocar a senha invalida as sessões — que é o comportamento
// esperado de quem troca a senha.
export const segredoPadrao = (senha) => createHmac("sha256", "wp-bot").update(senha).digest("hex");

/**
 * Freio de força bruta: conta erros por origem e bloqueia por um tempo. Em
 * memória de propósito — é proteção contra tentativa automatizada, e um
 * restart custar o bloqueio é aceitável.
 */
export class FreioDeTentativas {
  constructor({ maximo = 5, minutosBloqueado = 15, agora = () => Date.now() } = {}) {
    this.maximo = maximo;
    this.bloqueioMs = minutosBloqueado * 60_000;
    this.agora = agora;
    this.tentativas = new Map();
  }

  bloqueado(origem) {
    const registro = this.tentativas.get(origem);
    if (!registro) return false;
    if (this.agora() - registro.ultima > this.bloqueioMs) {
      this.tentativas.delete(origem);
      return false;
    }
    return registro.erros >= this.maximo;
  }

  errou(origem) {
    const registro = this.tentativas.get(origem) ?? { erros: 0, ultima: 0 };
    registro.erros += 1;
    registro.ultima = this.agora();
    this.tentativas.set(origem, registro);
    return this.maximo - registro.erros;
  }

  acertou(origem) {
    this.tentativas.delete(origem);
  }
}

export const gerarSegredo = () => randomBytes(32).toString("hex");
