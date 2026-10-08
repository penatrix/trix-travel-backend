// Os caminhos do handler, com a rede trocada por respostas prontas.
//
// O que se trava aqui é o contrato com o RevenueCat: autorização errada
// não toca o banco, aviso ignorado responde 200 sem chamar ninguém, e
// banco que falha responde 500 -- que é o que faz o RevenueCat reenviar.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const AUTORIZACAO = 'Bearer segredo-do-painel';
const CONTA = '11111111-2222-3333-4444-555555555555';

const ambiente = {
  REVENUECAT_WEBHOOK_AUTH: AUTORIZACAO,
  SUPABASE_URL: 'https://projeto.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
};

const { avisoDoRevenuecat } = require('./index');

let chamadas;
let respostas;
const fetchOriginal = global.fetch;

beforeEach(() => {
  Object.assign(process.env, ambiente);
  chamadas = [];
  respostas = [];
  global.fetch = async (url, opcoes = {}) => {
    chamadas.push({ url: String(url), corpo: opcoes.body ? JSON.parse(opcoes.body) : null });
    const [status, corpo] = respostas.shift() ?? [500, { error: 'sem resposta preparada' }];
    return { ok: status >= 200 && status < 300, status, json: async () => corpo };
  };
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

const evento = (campos = {}) => ({
  api_version: '1.0',
  event: {
    id: 'ev-1',
    type: 'NON_RENEWING_PURCHASE',
    app_user_id: CONTA,
    product_id: 'roteiro_premium',
    store: 'PLAY_STORE',
    environment: 'SANDBOX',
    transaction_id: 'GPA.1',
    original_transaction_id: 'GPA.1',
    purchased_at_ms: Date.UTC(2026, 9, 8),
    expiration_at_ms: null,
    subscriber_attributes: { $email: { value: 'a@b.c' } },
    ...campos,
  },
});

const pedido = (corpo, autorizacao = AUTORIZACAO) =>
  ({ method: 'POST', headers: { authorization: autorizacao }, body: corpo });

function resposta() {
  const r = { codigo: null, corpo: null };
  return {
    r,
    status(codigo) { r.codigo = codigo; return this; },
    json(corpo) { r.corpo = corpo; return this; },
  };
}

test('autorização errada: 401, e o banco não é chamado', async () => {
  const res = resposta();
  await avisoDoRevenuecat(pedido(evento(), 'Bearer outro'), res);
  assert.strictEqual(res.r.codigo, 401);
  assert.strictEqual(chamadas.length, 0);
});

test('sem configuração: 500, e o banco não é chamado', async () => {
  delete process.env.REVENUECAT_WEBHOOK_AUTH;
  const res = resposta();
  await avisoDoRevenuecat(pedido(evento()), res);
  assert.strictEqual(res.r.codigo, 500);
  assert.strictEqual(chamadas.length, 0);
});

test('compra do avulso: registrar_compra com os parâmetros do aviso', async () => {
  respostas.push([200, { nova: true, entitlement_id: 9 }]);
  const res = resposta();
  await avisoDoRevenuecat(pedido(evento()), res);
  assert.strictEqual(res.r.codigo, 200);
  assert.strictEqual(chamadas.length, 1);
  assert.strictEqual(chamadas[0].url, 'https://projeto.supabase.co/rest/v1/rpc/registrar_compra');
  const p = chamadas[0].corpo;
  assert.strictEqual(p.p_user_id, CONTA);
  assert.strictEqual(p.p_loja, 'google');
  assert.strictEqual(p.p_tipo, 'trip_credit');
  assert.strictEqual(p.p_transacao, 'GPA.1');
  assert.strictEqual(p.p_valido_ate, null);
  assert.strictEqual(p.p_evento.environment, 'SANDBOX');
  assert.strictEqual(p.p_evento.subscriber_attributes, undefined);
});

test('reembolso: reembolsar_compra pela loja e transação', async () => {
  respostas.push([200, { achou: true, revogou: 1 }]);
  const res = resposta();
  await avisoDoRevenuecat(pedido(evento({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' })), res);
  assert.strictEqual(res.r.codigo, 200);
  assert.match(chamadas[0].url, /rpc\/reembolsar_compra$/);
  assert.deepStrictEqual(chamadas[0].corpo, { p_loja: 'google', p_transacao: 'GPA.1' });
});

test('expiração do anual: expirar_assinatura com a data', async () => {
  respostas.push([200, 1]);
  const res = resposta();
  await avisoDoRevenuecat(pedido(evento({
    type: 'EXPIRATION',
    product_id: 'premium_anual:anual',
    expiration_at_ms: Date.UTC(2027, 9, 8),
  })), res);
  assert.strictEqual(res.r.codigo, 200);
  assert.match(chamadas[0].url, /rpc\/expirar_assinatura$/);
  assert.deepStrictEqual(chamadas[0].corpo,
    { p_user_id: CONTA, p_expirou_em: '2027-10-08T00:00:00.000Z' });
});

test('aviso ignorado ou de produto desconhecido: 200, sem banco', async () => {
  for (const campos of [
    { type: 'TEST' },
    { type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' },
    { type: 'TRANSFER' },
    { product_id: 'outra_coisa' },
  ]) {
    const res = resposta();
    await avisoDoRevenuecat(pedido(evento(campos)), res);
    assert.strictEqual(res.r.codigo, 200, JSON.stringify(campos));
  }
  assert.strictEqual(chamadas.length, 0);
});

test('aviso sem transação: 400', async () => {
  const res = resposta();
  await avisoDoRevenuecat(pedido(evento({ transaction_id: null })), res);
  assert.strictEqual(res.r.codigo, 400);
  assert.strictEqual(chamadas.length, 0);
});

test('banco falhou: 500, para o RevenueCat reenviar', async () => {
  respostas.push([503, { message: 'fora' }]);
  const res = resposta();
  await avisoDoRevenuecat(pedido(evento()), res);
  assert.strictEqual(res.r.codigo, 500);
});

test('só POST', async () => {
  const res = resposta();
  await avisoDoRevenuecat({ method: 'GET', headers: {} }, res);
  assert.strictEqual(res.r.codigo, 405);
});
