// O aviso push do roteiro (14/10): o texto de cada caso, a mensagem que
// vai ao FCM e o que conta como token morto.

const test = require('node:test');
const assert = require('node:assert/strict');
const { textoDoAviso, mensagemParaOAparelho, tokenMorreu, avisarDono } = require('./aviso-push');

const PROIBIDAS = ['!', 'mágic', 'inesquec', 'imperd'];

test('cada aviso tem título e corpo, em pt e en, sem exclamação', () => {
  for (const tipo of ['pronto', 'refeito', 'falhou', 'refazer_falhou']) {
    for (const idioma of ['pt', 'en']) {
      const t = textoDoAviso(tipo, { titulo: 'Lisboa e Porto', idioma });
      assert.ok(t.titulo && t.corpo, `${tipo}/${idioma}`);
      for (const p of PROIBIDAS) {
        assert.ok(!`${t.titulo} ${t.corpo}`.toLowerCase().includes(p), `${tipo}/${idioma}: ${p}`);
      }
    }
  }
  assert.equal(textoDoAviso('outro'), null);
});

test('o nome do roteiro vai no corpo do pronto, e some sem nome', () => {
  assert.equal(textoDoAviso('pronto', { titulo: 'Lisboa e Porto' }).corpo, 'Lisboa e Porto. Toque para abrir.');
  assert.equal(textoDoAviso('pronto', { titulo: '  ' }).corpo, 'Toque para abrir.');
  assert.equal(textoDoAviso('falhou').corpo, 'Nada foi descontado. Crie de novo quando quiser.');
});

test('a mensagem leva o roteiro no data, em texto, e o link só na web', () => {
  const texto = textoDoAviso('pronto', { titulo: 'X' });
  const m = mensagemParaOAparelho('tok', 'ios', 'pronto', 406, texto).message;
  assert.deepEqual(m.data, { tipo: 'pronto', trip_id: '406' });
  assert.equal(m.android.notification.tag, 'roteiro-406');
  assert.equal(m.webpush, undefined);
  const w = mensagemParaOAparelho('tok', 'web', 'pronto', 406, texto).message;
  assert.equal(w.webpush.fcm_options.link, 'https://app.trix.travel/');
});

test('só 404 e UNREGISTERED apagam o token', () => {
  assert.equal(tokenMorreu(404, null), true);
  assert.equal(tokenMorreu(400, { error: { details: [{ errorCode: 'UNREGISTERED' }] } }), true);
  assert.equal(tokenMorreu(400, { error: { details: [{ errorCode: 'INVALID_ARGUMENT' }] } }), false);
  assert.equal(tokenMorreu(500, null), false);
});

test('sem aparelho não chama o Google, e erro do banco não lança', async () => {
  const consulta = (resultado) => ({
    from: () => ({ select: () => ({ eq: async () => resultado }) }),
  });
  const fetchOriginal = global.fetch;
  let chamou = false;
  global.fetch = async () => { chamou = true; throw new Error('não devia'); };
  try {
    await avisarDono(consulta({ data: [], error: null }), { userId: 'u', tripId: 1, tipo: 'pronto' });
    assert.equal(chamou, false);
    await avisarDono(consulta({ data: null, error: new Error('fora') }), { userId: 'u', tripId: 1, tipo: 'pronto' });
    await avisarDono(consulta({ data: [{ token: 't', plataforma: 'ios' }], error: null }), { userId: 'u', tripId: 1, tipo: 'pronto' });
  } finally {
    global.fetch = fetchOriginal;
  }
});
