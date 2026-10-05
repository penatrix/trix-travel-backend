// Os caminhos do handler, com a rede trocada por respostas prontas.
//
// O que se trava aqui é a ordem das coisas e o que acontece em cada
// falha: quem não tem token não chama a Apple, a revogação recusada não
// apaga a linha, e o código de outra conta Apple não é gravado.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const SEGREDO_JWT = 'segredo-de-teste';
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const USUARIO = '11111111-2222-3333-4444-555555555555';
const SUB_APPLE = '001234.abc';

const ambiente = {
  SUPABASE_JWT_SECRET: SEGREDO_JWT,
  SUPABASE_URL: 'https://projeto.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  APPLE_TEAM_ID: '9YDU67FKQM',
  APPLE_KEY_ID: 'ABC123DEFG',
  APPLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};

const { tokenDaApple } = require('./index');

let chamadas;
let respostas;
const fetchOriginal = global.fetch;

beforeEach(() => {
  Object.assign(process.env, ambiente);
  chamadas = [];
  respostas = [];
  global.fetch = async (url, opcoes = {}) => {
    chamadas.push({ url: String(url), metodo: opcoes.method ?? 'GET', corpo: opcoes.body });
    const [status, corpo] = respostas.shift() ?? [500, { error: 'sem resposta preparada' }];
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => corpo,
    };
  };
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

function pedido(corpo, { anonimo = false } = {}) {
  const token = jwt.sign(
    { sub: USUARIO, role: 'authenticated', is_anonymous: anonimo },
    SEGREDO_JWT,
    { algorithm: 'HS256' },
  );
  return { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: corpo };
}

function resposta() {
  const r = { codigo: null, corpo: null };
  return {
    r,
    set() {},
    status(codigo) { r.codigo = codigo; return this; },
    json(corpo) { r.corpo = corpo; return this; },
    send(corpo) { r.corpo = corpo; return this; },
  };
}

const idToken = (sub) =>
  `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.a`;

const contaComApple = { identities: [{ provider: 'apple', id: SUB_APPLE }] };

// =====================================================================

test('sem token de sessão: 401, e ninguém é chamado', async () => {
  const res = resposta();
  await tokenDaApple({ method: 'POST', headers: {}, body: { acao: 'revogar' } }, res);
  assert.strictEqual(res.r.codigo, 401);
  assert.strictEqual(chamadas.length, 0);
});

test('ação desconhecida: 400', async () => {
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'apagar' }), res);
  assert.strictEqual(res.r.codigo, 400);
});

test('variável faltando: 500, antes de qualquer chamada', async () => {
  delete process.env.APPLE_KEY_ID;
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'revogar' }), res);
  assert.strictEqual(res.r.codigo, 500);
  assert.strictEqual(chamadas.length, 0);
});

// ---------------------------------------------------------------------
// guardar
// ---------------------------------------------------------------------

test('guardar: troca, confere a conta e grava', async () => {
  respostas = [
    [200, { refresh_token: 'r.1', id_token: idToken(SUB_APPLE) }],
    [200, contaComApple],
    [201, null],
  ];
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'guardar', authorization_code: 'c.1' }), res);
  assert.strictEqual(res.r.codigo, 204);
  assert.deepStrictEqual(chamadas.map((c) => c.url), [
    'https://appleid.apple.com/auth/token',
    `https://projeto.supabase.co/auth/v1/admin/users/${USUARIO}`,
    'https://projeto.supabase.co/rest/v1/tokens_da_apple?on_conflict=user_id',
  ]);
  const gravado = JSON.parse(chamadas[2].corpo);
  assert.strictEqual(gravado.user_id, USUARIO);
  assert.strictEqual(gravado.refresh_token, 'r.1');
});

test('guardar: código de outra conta Apple não é gravado', async () => {
  respostas = [
    [200, { refresh_token: 'r.1', id_token: idToken('999999.outra') }],
    [200, contaComApple],
  ];
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'guardar', authorization_code: 'c.1' }), res);
  assert.strictEqual(res.r.codigo, 403);
  assert.strictEqual(chamadas.length, 2, 'nada de gravação');
});

test('guardar: a Apple recusa o código, e nada é gravado', async () => {
  respostas = [[400, { error: 'invalid_grant' }]];
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'guardar', authorization_code: 'c.1' }), res);
  assert.strictEqual(res.r.codigo, 502);
  assert.strictEqual(chamadas.length, 1);
});

test('guardar: sessão anônima e código vazio são recusados sem chamar a Apple', async () => {
  const anonima = resposta();
  await tokenDaApple(pedido({ acao: 'guardar', authorization_code: 'c.1' }, { anonimo: true }), anonima);
  assert.strictEqual(anonima.r.codigo, 403);
  const vazio = resposta();
  await tokenDaApple(pedido({ acao: 'guardar', authorization_code: '  ' }), vazio);
  assert.strictEqual(vazio.r.codigo, 400);
  assert.strictEqual(chamadas.length, 0);
});

// ---------------------------------------------------------------------
// revogar
// ---------------------------------------------------------------------

test('revogar sem token guardado: 204, e a Apple não é chamada', async () => {
  respostas = [[200, []]];
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'revogar' }), res);
  assert.strictEqual(res.r.codigo, 204);
  assert.strictEqual(chamadas.length, 1);
  assert.match(chamadas[0].url, /tokens_da_apple\?user_id=eq\./);
});

test('revogar: revoga na Apple e só depois apaga a linha', async () => {
  respostas = [[200, [{ refresh_token: 'r.1' }]], [200, null], [204, null]];
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'revogar' }), res);
  assert.strictEqual(res.r.codigo, 204);
  assert.strictEqual(chamadas[1].url, 'https://appleid.apple.com/auth/revoke');
  assert.strictEqual(new URLSearchParams(chamadas[1].corpo).get('token'), 'r.1');
  assert.strictEqual(chamadas[2].metodo, 'DELETE');
});

test('revogar: token que já não vale (invalid_grant) também sai', async () => {
  respostas = [[200, [{ refresh_token: 'r.1' }]], [400, { error: 'invalid_grant' }], [204, null]];
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'revogar' }), res);
  assert.strictEqual(res.r.codigo, 204);
  assert.strictEqual(chamadas[2].metodo, 'DELETE');
});

test('revogar: a Apple recusa por outro motivo, e a linha fica', async () => {
  respostas = [[200, [{ refresh_token: 'r.1' }]], [400, { error: 'invalid_client' }]];
  const res = resposta();
  await tokenDaApple(pedido({ acao: 'revogar' }), res);
  assert.strictEqual(res.r.codigo, 502);
  assert.strictEqual(chamadas.length, 2, 'sem DELETE');
});
