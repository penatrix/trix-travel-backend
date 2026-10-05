// A conversa com a Apple: o segredo do cliente e os dois pedidos.
//
// Tudo aqui é puro, sem rede, para o `npm test` travar o formato. Quem
// faz o fetch é o `index.js`.
//
// Referência: "Generate and validate tokens" e "Revoke tokens", na
// documentação do Sign in with Apple REST API.

'use strict';

const crypto = require('node:crypto');

const APPLE = 'https://appleid.apple.com';
const URL_DO_TOKEN = `${APPLE}/auth/token`;
const URL_DA_REVOGACAO = `${APPLE}/auth/revoke`;

/// O identificador do app nas duas lojas. É o `client_id` que emite o
/// token no login nativo -- não o Services ID da web
/// (`travel.trix.signin`), que é de outro fluxo, pelo Supabase.
const CLIENT_ID = 'travel.trix.app';

/// Cinco minutos. A Apple aceita até seis meses, mas o segredo é refeito
/// a cada chamada: não há motivo para um segredo vazado valer mais que
/// a chamada que o usou.
const VALIDADE_DO_SEGREDO_S = 300;

const base64url = (b) => Buffer.from(b).toString('base64url');

/// A chave .p8 como vem da variável. O Secret Manager entrega o PEM com
/// quebras de linha de verdade; colado à mão num campo de uma linha, ele
/// chega com `\n` literal, e o `crypto` recusa. Aceita os dois.
function lerChavePrivada(texto) {
  return String(texto ?? '').replace(/\\n/g, '\n').trim();
}

/// O que o serviço precisa do ambiente, ou a lista do que falta. Faltar
/// é erro de implantação, e o handler diz qual no log.
function lerConfig(env) {
  const config = {
    teamId: String(env.APPLE_TEAM_ID ?? '').trim(),
    keyId: String(env.APPLE_KEY_ID ?? '').trim(),
    chave: lerChavePrivada(env.APPLE_PRIVATE_KEY),
    supabaseUrl: String(env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
    serviceRole: String(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  };
  const faltam = [
    ['APPLE_TEAM_ID', config.teamId],
    ['APPLE_KEY_ID', config.keyId],
    ['APPLE_PRIVATE_KEY', config.chave],
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', config.serviceRole],
  ].filter(([, v]) => !v).map(([nome]) => nome);
  return { config, faltam };
}

/// O `client_secret` da Apple: um JWT ES256 assinado com a chave .p8.
///
/// Feito à mão com `crypto` porque o `jsonwebtoken` assina ES256 em DER
/// por baixo e converte; aqui o formato que o JWT exige (r||s, 64 bytes)
/// é pedido direto, com `dsaEncoding: 'ieee-p1363'`.
function montarClientSecret({ teamId, keyId, chave, agora = Date.now() }) {
  const iat = Math.floor(agora / 1000);
  const cabecalho = { alg: 'ES256', kid: keyId };
  const corpo = {
    iss: teamId,
    iat,
    exp: iat + VALIDADE_DO_SEGREDO_S,
    aud: APPLE,
    sub: CLIENT_ID,
  };
  const entrada = `${base64url(JSON.stringify(cabecalho))}.${base64url(JSON.stringify(corpo))}`;
  const assinatura = crypto.sign('sha256', Buffer.from(entrada), {
    key: chave,
    dsaEncoding: 'ieee-p1363',
  });
  return `${entrada}.${base64url(assinatura)}`;
}

/// Troca o `authorization_code` do login pelo `refresh_token`.
function pedidoDeTroca({ codigo, segredo }) {
  return {
    url: URL_DO_TOKEN,
    corpo: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: segredo,
      code: codigo,
      grant_type: 'authorization_code',
    }),
  };
}

/// Revoga o `refresh_token`. É o que tira a Trix da lista de apps da
/// conta Apple da pessoa.
function pedidoDeRevogacao({ token, segredo }) {
  return {
    url: URL_DA_REVOGACAO,
    corpo: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: segredo,
      token,
      token_type_hint: 'refresh_token',
    }),
  };
}

/// O `sub` do `id_token` que a Apple devolve na troca. Sem conferir a
/// assinatura: o token acabou de chegar da própria Apple, por TLS, como
/// resposta a um pedido assinado por nós.
function subDoIdToken(idToken) {
  try {
    const corpo = String(idToken ?? '').split('.')[1];
    return JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')).sub ?? null;
  } catch (_) {
    return null;
  }
}

/// O código trocado é da mesma conta Apple que está ligada a esta conta
/// da Trix?
///
/// Sem isto, qualquer pessoa logada poderia mandar um código de OUTRA
/// conta Apple e gravá-lo como seu. O código é de uso único e difícil de
/// obter, mas a conferência custa uma leitura.
function mesmaContaDaApple(sub, usuario) {
  if (!sub) return false;
  const identidades = Array.isArray(usuario?.identities) ? usuario.identities : [];
  return identidades.some(
    (i) =>
      i?.provider === 'apple' &&
      (i.id === sub || i.identity_data?.sub === sub || i.provider_id === sub),
  );
}

module.exports = {
  CLIENT_ID,
  VALIDADE_DO_SEGREDO_S,
  URL_DO_TOKEN,
  URL_DA_REVOGACAO,
  lerChavePrivada,
  lerConfig,
  montarClientSecret,
  pedidoDeTroca,
  pedidoDeRevogacao,
  subDoIdToken,
  mesmaContaDaApple,
};
