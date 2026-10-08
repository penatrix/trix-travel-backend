// A leitura do aviso, sem rede.
//
// O que se trava aqui é o que decide dinheiro: qual produto vira qual
// direito, qual cancelamento é reembolso, e de quem é a compra.

const { test } = require('node:test');
const assert = require('node:assert');
const {
  lerConfig,
  autorizado,
  tipoDoProduto,
  lojaDoEvento,
  contaDoEvento,
  lerEvento,
  eventoParaGuardar,
} = require('./revenuecat');

const CONTA = '11111111-2222-3333-4444-555555555555';

const aviso = (campos) => ({
  api_version: '1.0',
  event: {
    type: 'INITIAL_PURCHASE',
    app_user_id: CONTA,
    original_app_user_id: CONTA,
    aliases: [CONTA],
    product_id: 'premium_anual:anual',
    store: 'PLAY_STORE',
    environment: 'PRODUCTION',
    transaction_id: 'GPA.1',
    original_transaction_id: 'GPA.1',
    purchased_at_ms: Date.UTC(2026, 9, 8),
    expiration_at_ms: Date.UTC(2027, 9, 8),
    ...campos,
  },
});

test('config: diz o que falta', () => {
  assert.deepStrictEqual(lerConfig({}).faltam,
    ['REVENUECAT_WEBHOOK_AUTH', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const { config, faltam } = lerConfig({
    REVENUECAT_WEBHOOK_AUTH: ' Bearer x ',
    SUPABASE_URL: 'https://p.supabase.co/',
    SUPABASE_SERVICE_ROLE_KEY: 'k',
  });
  assert.deepStrictEqual(faltam, []);
  assert.strictEqual(config.supabaseUrl, 'https://p.supabase.co');
  assert.strictEqual(config.autorizacao, 'Bearer x');
});

test('autorização: só o valor exato', () => {
  assert.strictEqual(autorizado('Bearer segredo', 'Bearer segredo'), true);
  assert.strictEqual(autorizado('Bearer segred', 'Bearer segredo'), false);
  assert.strictEqual(autorizado(undefined, 'Bearer segredo'), false);
  assert.strictEqual(autorizado('', ''), false, 'sem segredo configurado, ninguém entra');
});

test('produto: os quatro identificadores das duas lojas', () => {
  assert.strictEqual(tipoDoProduto('premium_anual'), 'annual');
  assert.strictEqual(tipoDoProduto('premium_anual:anual'), 'annual');
  assert.strictEqual(tipoDoProduto('travel.trix.app.premium.anual'), 'annual');
  assert.strictEqual(tipoDoProduto('roteiro_premium'), 'trip_credit');
  assert.strictEqual(tipoDoProduto('travel.trix.app.premium.roteiro'), 'trip_credit');
  assert.strictEqual(tipoDoProduto('premium_anualx'), null);
  assert.strictEqual(tipoDoProduto(undefined), null);
});

test('loja: só Play e App Store', () => {
  assert.strictEqual(lojaDoEvento('PLAY_STORE'), 'google');
  assert.strictEqual(lojaDoEvento('APP_STORE'), 'apple');
  assert.strictEqual(lojaDoEvento('STRIPE'), null);
  assert.strictEqual(lojaDoEvento('PROMOTIONAL'), null);
});

test('conta: o primeiro uuid, inclusive nos aliases', () => {
  assert.strictEqual(contaDoEvento({ app_user_id: CONTA }), CONTA);
  assert.strictEqual(contaDoEvento({
    app_user_id: '$RCAnonymousID:abc',
    original_app_user_id: '$RCAnonymousID:abc',
    aliases: ['$RCAnonymousID:abc', CONTA],
  }), CONTA);
  assert.strictEqual(contaDoEvento({ app_user_id: '$RCAnonymousID:abc' }), null);
});

test('compra do anual: registra, com a data de fim', () => {
  const lido = lerEvento(aviso({}));
  assert.strictEqual(lido.acao, 'registrar');
  assert.strictEqual(lido.tipo, 'annual');
  assert.strictEqual(lido.loja, 'google');
  assert.strictEqual(lido.conta, CONTA);
  assert.strictEqual(lido.validoAte, '2027-10-08T00:00:00.000Z');
  assert.strictEqual(lido.compradoEm, '2026-10-08T00:00:00.000Z');
});

test('renovação registra; avulso registra sem data de fim', () => {
  assert.strictEqual(lerEvento(aviso({ type: 'RENEWAL', transaction_id: 'GPA.2' })).acao, 'registrar');
  const avulso = lerEvento(aviso({
    type: 'NON_RENEWING_PURCHASE',
    product_id: 'roteiro_premium',
    expiration_at_ms: null,
  }));
  assert.strictEqual(avulso.acao, 'registrar');
  assert.strictEqual(avulso.tipo, 'trip_credit');
  assert.strictEqual(avulso.validoAte, null);
});

test('cancelar a renovação não tira nada; só o suporte da loja reembolsa', () => {
  for (const motivo of ['UNSUBSCRIBE', 'BILLING_ERROR', 'DEVELOPER_INITIATED', 'PRICE_INCREASE', 'UNKNOWN']) {
    assert.strictEqual(lerEvento(aviso({ type: 'CANCELLATION', cancel_reason: motivo })).acao,
      'ignorar', motivo);
  }
  assert.strictEqual(lerEvento(aviso({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' })).acao,
    'reembolsar');
  assert.strictEqual(lerEvento(aviso({
    type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', product_id: 'roteiro_premium',
  })).acao, 'reembolsar', 'o avulso também se reembolsa');
});

test('expiração: só do anual, e só com conta', () => {
  const lido = lerEvento(aviso({ type: 'EXPIRATION' }));
  assert.strictEqual(lido.acao, 'expirar');
  assert.strictEqual(lido.expirouEm, '2027-10-08T00:00:00.000Z');
  assert.strictEqual(lerEvento(aviso({ type: 'EXPIRATION', product_id: 'roteiro_premium' })).acao, 'ignorar');
  assert.strictEqual(lerEvento(aviso({
    type: 'EXPIRATION', app_user_id: 'x', original_app_user_id: 'x', aliases: [],
  })).acao, 'ignorar');
});

test('o resto é ignorado ou recusado', () => {
  assert.strictEqual(lerEvento({ event: { type: 'TEST' } }).acao, 'ignorar');
  for (const tipo of ['TRANSFER', 'BILLING_ISSUE', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'SUBSCRIPTION_PAUSED']) {
    assert.strictEqual(lerEvento(aviso({ type: tipo })).acao, 'ignorar', tipo);
  }
  assert.strictEqual(lerEvento(aviso({ store: 'STRIPE' })).acao, 'ignorar');
  assert.strictEqual(lerEvento(aviso({ product_id: 'outra_coisa' })).acao, 'desconhecido');
  assert.strictEqual(lerEvento(aviso({ transaction_id: undefined })).acao, 'invalido');
  assert.strictEqual(lerEvento({}).acao, 'invalido');
  assert.strictEqual(lerEvento(null).acao, 'invalido');
});

test('o que se guarda não leva atributos de assinante', () => {
  const guardado = eventoParaGuardar({
    type: 'INITIAL_PURCHASE',
    subscriber_attributes: { $email: { value: 'a@b.c' } },
  });
  assert.deepStrictEqual(guardado, { type: 'INITIAL_PURCHASE' });
});
