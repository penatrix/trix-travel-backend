// A busca do lugar pela Places API (New), atrás de PLACES_API_NOVA=1.
//
// O que isto trava:
//   * a máscara pede SÓ os três campos que o código usa -- cada campo a
//     mais é cobrado, e foi exatamente o "pede tudo" da legada que fez
//     61% do custo do Places ser dado que ninguém lê (21/09);
//   * a resposta nova vira o MESMO veredito da legada, para o resto da
//     passada de conserto não saber qual API respondeu;
//   * sem a variável, nada muda: a legada continua sendo a padrão.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  consultarLugar,
  lerTextSearchNovo,
} = require('./validar-lugares');

function comFetch(responder) {
  const original = global.fetch;
  const chamadas = [];
  global.fetch = async (url, opcoes = {}) => {
    chamadas.push({ url: String(url), opcoes });
    return responder(String(url), opcoes);
  };
  return { chamadas, desfazer: () => { global.fetch = original; } };
}

const ok = (corpo) => ({ ok: true, status: 200, json: async () => corpo });

test('lerTextSearchNovo: aberto, fechado, sem status e sem resultado', () => {
  assert.deepStrictEqual(
    lerTextSearchNovo({ places: [{ id: 'ChIJ1', displayName: { text: 'Museu' }, businessStatus: 'OPERATIONAL' }] }),
    { veredito: 'aberto', status: 'OPERATIONAL', placeId: 'ChIJ1', nomeGoogle: 'Museu' },
  );
  assert.strictEqual(
    lerTextSearchNovo({ places: [{ id: 'ChIJ2', businessStatus: 'CLOSED_PERMANENTLY' }] }).veredito,
    'fechado',
  );
  assert.strictEqual(
    lerTextSearchNovo({ places: [{ id: 'ChIJ3', businessStatus: 'CLOSED_TEMPORARILY' }] }).veredito,
    'fechado',
  );
  // Praça, mirante, praia: sem status não é fechamento.
  assert.deepStrictEqual(
    lerTextSearchNovo({ places: [{ id: 'ChIJ4' }] }),
    { veredito: 'aberto', placeId: 'ChIJ4', semStatus: true },
  );
  // A API nova devolve {} quando não acha nada.
  assert.deepStrictEqual(lerTextSearchNovo({}), { veredito: 'nao_encontrado' });
});

test('com PLACES_API_NOVA=1: POST na API nova, com a máscara mínima', async () => {
  process.env.PLACES_API_NOVA = '1';
  const f = comFetch(() => ok({ places: [{ id: 'ChIJx', businessStatus: 'OPERATIONAL' }] }));
  try {
    const contador = { chamadas: 0 };
    const v = await consultarLugar('Museu do Amanhã, Rio de Janeiro, Brasil', 'chave', contador);
    assert.strictEqual(v.veredito, 'aberto');
    assert.strictEqual(v.placeId, 'ChIJx');
    assert.strictEqual(contador.chamadas, 1);

    const { url, opcoes } = f.chamadas[0];
    assert.strictEqual(url, 'https://places.googleapis.com/v1/places:searchText');
    assert.strictEqual(opcoes.method, 'POST');
    assert.strictEqual(opcoes.headers['X-Goog-Api-Key'], 'chave');
    assert.strictEqual(
      opcoes.headers['X-Goog-FieldMask'],
      'places.id,places.displayName,places.businessStatus',
      'campo a mais na máscara é campo a mais na conta',
    );
    assert.deepStrictEqual(JSON.parse(opcoes.body), {
      textQuery: 'Museu do Amanhã, Rio de Janeiro, Brasil',
      pageSize: 1,
    });
  } finally {
    f.desfazer();
    delete process.env.PLACES_API_NOVA;
  }
});

test('com PLACES_API_NOVA=1: erro HTTP vira veredito de erro, não exceção', async () => {
  process.env.PLACES_API_NOVA = '1';
  const f = comFetch(() => ({ ok: false, status: 403, json: async () => ({}) }));
  try {
    const v = await consultarLugar('Qualquer lugar', 'chave');
    assert.deepStrictEqual(v, { veredito: 'erro', motivo: 'HTTP 403' });
  } finally {
    f.desfazer();
    delete process.env.PLACES_API_NOVA;
  }
});

test('sem a variável, a busca continua na legada', async () => {
  delete process.env.PLACES_API_NOVA;
  const f = comFetch(() => ok({
    status: 'OK',
    results: [{ place_id: 'ChIJy', name: 'Museu', business_status: 'OPERATIONAL' }],
  }));
  try {
    const v = await consultarLugar('Museu', 'chave');
    assert.strictEqual(v.placeId, 'ChIJy');
    assert.ok(f.chamadas[0].url.startsWith('https://maps.googleapis.com/maps/api/place/textsearch/json'));
  } finally {
    f.desfazer();
  }
});
