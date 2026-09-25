// Testes da parte pura da sugestão de cidades.
//
// Nenhum toca a rede. O que fica travado é a CONFERÊNCIA: o app lê esta
// resposta e monta os cartões do passo 3 com ela, então cidade repetida,
// sem motivo ou além do teto viraria cartão errado na tela. O prompt é
// testado de forma frouxa, como no classify-conflicts: só o que não pode
// sair dele.

const { test } = require('node:test');
const assert = require('node:assert');

const { montarPrompt, conferirResposta, MAX_EXTRAS } = require('./sugerir');

const c = (name, extra = {}) => ({
  name,
  search: `${name}, Itália`,
  reason: 'a 1h de trem, arte',
  ...extra,
});

// =====================================================================
// CONFERÊNCIA
// =====================================================================

test('região: roteiro e extras passam limpos', () => {
  const { resposta, descartados } = conferirResposta(
    {
      kind: 'region',
      itinerary: [c('Roma', { days: 3 }), c('Florença', { days: 2 })],
      extras: [c('Siena'), c('Pisa')],
    },
    { maxCities: 3 },
  );
  assert.equal(resposta.kind, 'region');
  assert.deepEqual(resposta.itinerary.map((x) => x.name), ['Roma', 'Florença']);
  assert.deepEqual(resposta.itinerary.map((x) => x.days), [3, 2]);
  assert.deepEqual(resposta.extras.map((x) => x.name), ['Siena', 'Pisa']);
  assert.deepEqual(descartados, []);
});

test('cidade fica sozinha, diga o modelo o que disser', () => {
  const { resposta } = conferirResposta(
    { kind: 'city', itinerary: [c('Lisboa'), c('Sintra')], extras: [] },
    { maxCities: 5 },
  );
  assert.equal(resposta.kind, 'city');
  assert.deepEqual(resposta.itinerary.map((x) => x.name), ['Lisboa']);
});

test('o roteiro respeita o teto, e o que sobrou pode virar extra', () => {
  const { resposta } = conferirResposta(
    {
      kind: 'region',
      itinerary: [c('A'), c('B'), c('C'), c('D')],
      extras: [c('D'), c('E')],
    },
    { maxCities: 2 },
  );
  assert.deepEqual(resposta.itinerary.map((x) => x.name), ['A', 'B']);
  assert.deepEqual(resposta.extras.map((x) => x.name), ['D', 'E']);
});

test('extra que já está no roteiro sai, e repetida sai', () => {
  const { resposta, descartados } = conferirResposta(
    {
      kind: 'region',
      itinerary: [c('Roma'), c('roma')],
      extras: [c('Roma'), c('Veneza'), c('Veneza')],
    },
    { maxCities: 3 },
  );
  assert.deepEqual(resposta.itinerary.map((x) => x.name), ['Roma']);
  assert.deepEqual(resposta.extras.map((x) => x.name), ['Veneza']);
  assert.equal(descartados.length, 3);
});

test('sem nome ou sem motivo não entra', () => {
  const { resposta } = conferirResposta(
    {
      kind: 'region',
      itinerary: [c('Roma'), { name: 'Nápoles', reason: '' }, { reason: 'x' }],
    },
    { maxCities: 3 },
  );
  assert.deepEqual(resposta.itinerary.map((x) => x.name), ['Roma']);
  assert.deepEqual(resposta.extras, []);
});

test('dias ilegíveis somem em vez de virar zero', () => {
  const { resposta } = conferirResposta(
    {
      kind: 'region',
      itinerary: [c('A', { days: '3' }), c('B', { days: 'três' }), c('C', { days: 0 })],
    },
    { maxCities: 3 },
  );
  assert.deepEqual(resposta.itinerary.map((x) => x.days), [3, undefined, undefined]);
});

test('sem search, a busca é o nome', () => {
  const { resposta } = conferirResposta(
    { kind: 'region', itinerary: [{ name: 'Roma', reason: 'capital' }] },
    { maxCities: 1 },
  );
  assert.equal(resposta.itinerary[0].search, 'Roma');
});

test('extras param no teto', () => {
  const { resposta } = conferirResposta(
    {
      kind: 'region',
      itinerary: [c('Roma')],
      extras: ['A', 'B', 'C', 'D', 'E', 'F'].map((n) => c(n)),
    },
    { maxCities: 1 },
  );
  assert.equal(resposta.extras.length, MAX_EXTRAS);
});

test('nada aproveitável devolve null, e o app segue como antes', () => {
  assert.equal(conferirResposta(null, { maxCities: 3 }), null);
  assert.equal(conferirResposta('texto', { maxCities: 3 }), null);
  assert.equal(conferirResposta({ kind: 'region', itinerary: [] }, { maxCities: 3 }), null);
});

// =====================================================================
// PROMPT
// =====================================================================

test('o prompt leva destino, dias, teto e a regra da cidade sozinha', () => {
  const p = montarPrompt({
    destination: 'Itália',
    days: 10,
    maxCities: 5,
    vibes: ['Gastronomy', 'Wine'],
    cities: ['Itália'],
    lang: 'pt',
  });
  assert.ok(p.includes('Itália'));
  assert.ok(p.includes('10-day'));
  assert.ok(p.includes('between 1 and 5 cities'));
  assert.ok(p.includes('return exactly that one city'));
  assert.ok(p.includes('Gastronomy, Wine'));
  assert.ok(p.includes('Brazilian Portuguese'));
  // O país do `search` é comparado com o do Google, que vem em pt.
  assert.ok(p.includes('Florença, Itália'));
});

test('o prompt proíbe coordenada e lugar inventado', () => {
  // Arquitetural (CLAUDE.md do app): geolocalização é do Google, não do
  // modelo. O `search` é o que o Maps procura.
  const p = montarPrompt({ destination: 'Chile', days: 6, maxCities: 3 });
  assert.ok(p.includes('Never return coordinates'));
  assert.ok(p.includes('Never invent a place'));
  assert.ok(p.includes('"City, Country"'));
});

test('em inglês, a resposta vem em inglês', () => {
  const p = montarPrompt({ destination: 'Italy', days: 6, maxCities: 3, lang: 'en' });
  assert.ok(p.includes('are in English'));
  assert.ok(p.includes('Florence, Italy'));
});
