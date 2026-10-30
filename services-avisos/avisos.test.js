const { test } = require('node:test');
const assert = require('node:assert');
const {
  lerConfig,
  autorizado,
  lerPedido,
  quemAvisarDaEntrada,
  amanhaEmSaoPaulo,
  primeiroNome,
  textoDoAviso,
  mensagemParaOAparelho,
  tokenMorreu,
} = require('./avisos');

test('a configuração diz o que falta', () => {
  assert.deepStrictEqual(lerConfig({}).faltam,
    ['AVISOS_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const { config, faltam } = lerConfig({
    AVISOS_WEBHOOK_SECRET: 's', SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'k',
  });
  assert.deepStrictEqual(faltam, []);
  assert.strictEqual(config.supabaseUrl, 'https://x.supabase.co');
});

test('o segredo confere inteiro', () => {
  assert.ok(autorizado('abc', 'abc'));
  assert.ok(!autorizado('ab', 'abc'));
  assert.ok(!autorizado(undefined, 'abc'));
  assert.ok(!autorizado('abc', ''));
});

test('o pedido: entrada, véspera, dono e lixo', () => {
  const entrada = {
    type: 'INSERT', table: 'trip_members',
    record: { id: 'm1', trip_id: 42, user_id: 'u2', role: 'viewer' },
  };
  assert.deepStrictEqual(lerPedido(entrada),
    { acao: 'entrou', membroId: 'm1', tripId: 42, quemEntrou: 'u2' });
  assert.deepStrictEqual(lerPedido({ ...entrada, record: { ...entrada.record, role: 'owner' } }),
    { acao: 'ignorar', motivo: 'dono' });
  assert.deepStrictEqual(lerPedido({ modo: 'vespera' }), { acao: 'vespera' });
  assert.strictEqual(lerPedido({ type: 'UPDATE', table: 'trip_members', record: {} }).acao, 'invalido');
  assert.strictEqual(lerPedido({ type: 'INSERT', table: 'trips', record: {} }).acao, 'invalido');
  assert.strictEqual(lerPedido(null).acao, 'invalido');
});

test('quem entrou não recebe o próprio aviso; o dono recebe uma vez', () => {
  assert.deepStrictEqual(
    quemAvisarDaEntrada({ dono: 'd', membros: ['d', 'a', 'novo'], quemEntrou: 'novo' }).sort(),
    ['a', 'd'],
  );
  assert.deepStrictEqual(quemAvisarDaEntrada({ dono: 'd', membros: [], quemEntrou: 'd' }), []);
});

test('amanhã é o de São Paulo, não o de UTC', () => {
  // 30/10 às 22h em São Paulo já é 31/10 em UTC.
  assert.strictEqual(amanhaEmSaoPaulo(new Date('2026-10-31T01:00:00Z')), '2026-10-31');
  assert.strictEqual(amanhaEmSaoPaulo(new Date('2026-10-30T21:00:00Z')), '2026-10-31');
  assert.strictEqual(amanhaEmSaoPaulo(new Date('2026-12-31T21:00:00Z')), '2027-01-01');
});

test('o primeiro nome, curto', () => {
  assert.strictEqual(primeiroNome('  Ana Clara Souza '), 'Ana');
  assert.strictEqual(primeiroNome(null), '');
  assert.strictEqual(primeiroNome('x'.repeat(50)).length, 30);
});

test('os textos, nas duas línguas, sem exclamação nem emoji', () => {
  const entrou = textoDoAviso('entrou', { nome: 'Ana Souza', titulo: 'Lisboa e Porto' });
  assert.deepStrictEqual(entrou, {
    titulo: 'Ana entrou no seu roteiro',
    corpo: 'Lisboa e Porto. Toque para ver quem vai.',
  });
  assert.strictEqual(textoDoAviso('entrou', {}).titulo, 'Uma pessoa entrou no seu roteiro');
  assert.strictEqual(textoDoAviso('entrou', { nome: 'Ana', idioma: 'en' }).titulo, 'Ana joined your itinerary');
  assert.deepStrictEqual(textoDoAviso('vespera', { titulo: 'Lisboa e Porto' }), {
    titulo: 'Sua viagem começa amanhã',
    corpo: 'Lisboa e Porto. Toque para ver o dia 1.',
  });
  assert.strictEqual(textoDoAviso('outro'), null);
  for (const tipo of ['entrou', 'vespera']) {
    for (const idioma of ['pt', 'en']) {
      const t = textoDoAviso(tipo, { nome: 'Ana', titulo: 'Roma', idioma });
      const tudo = `${t.titulo} ${t.corpo}`;
      assert.ok(!tudo.includes('!'), tudo);
      assert.ok(!/\p{Extended_Pictographic}/u.test(tudo), tudo);
    }
  }
});

test('a mensagem leva o roteiro em texto e colapsa por tipo e roteiro', () => {
  const m = mensagemParaOAparelho('tok', 'ios', 'vespera', 42, { titulo: 'T', corpo: 'C' }).message;
  assert.deepStrictEqual(m.data, { tipo: 'vespera', trip_id: '42' });
  assert.strictEqual(m.apns.headers['apns-collapse-id'], 'vespera-42');
  assert.strictEqual(m.android.notification.tag, 'vespera-42');
  assert.strictEqual(m.webpush, undefined);
  const web = mensagemParaOAparelho('tok', 'web', 'entrou', 1, { titulo: 'T', corpo: 'C' }).message;
  assert.strictEqual(web.webpush.fcm_options.link, 'https://app.trix.travel/');
});

test('só 404 e UNREGISTERED apagam o token', () => {
  assert.ok(tokenMorreu(404, null));
  assert.ok(tokenMorreu(400, { error: { details: [{ errorCode: 'UNREGISTERED' }] } }));
  assert.ok(!tokenMorreu(400, { error: { details: [{ errorCode: 'INVALID_ARGUMENT' }] } }));
  assert.ok(!tokenMorreu(500, null));
});
