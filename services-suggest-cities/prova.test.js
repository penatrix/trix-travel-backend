const test = require('node:test');
const assert = require('node:assert');
const { limparDestaques, lugarConfere, conferirDestaques } = require('./prova');

test('só fica a vibe escolhida, uma vez, com nome, busca e linha', () => {
  const vibes = ['Gastronomia', 'Vida noturna'];
  const d = limparDestaques([
    { vibe: 'gastronomia', place: 'Ravintola C', search: 'Ravintola C, Tampere, Finlândia', line: 'cozinha nórdica' },
    { vibe: 'Gastronomia', place: 'Outro', search: 'Outro, Tampere', line: 'repetida' },
    { vibe: 'Praia', place: 'Inventada', search: 'X', line: 'vibe que não foi escolhida' },
    { vibe: 'Vida noturna', place: '', search: 'Y', line: 'sem nome' },
  ], vibes);
  assert.deepStrictEqual(d, [
    { vibe: 'Gastronomia', place: 'Ravintola C', search: 'Ravintola C, Tampere, Finlândia', line: 'cozinha nórdica' },
  ]);
  assert.deepStrictEqual(limparDestaques(undefined, vibes), []);
});

test('fechado ou não encontrado sai; sem status (praça, praia) fica', () => {
  assert.strictEqual(lugarConfere({}), false);
  assert.strictEqual(lugarConfere({ places: [{ businessStatus: 'CLOSED_PERMANENTLY' }] }), false);
  assert.strictEqual(lugarConfere({ places: [{ businessStatus: 'CLOSED_TEMPORARILY' }] }), false);
  assert.strictEqual(lugarConfere({ places: [{ businessStatus: 'OPERATIONAL' }] }), true);
  assert.strictEqual(lugarConfere({ places: [{ id: 'x' }] }), true);
});

const sugestao = () => ({
  itinerary: [{
    name: 'Tampere',
    highlights: [
      { vibe: 'Gastronomia', place: 'Aberto', search: 'aberto', line: 'a' },
      { vibe: 'Vida noturna', place: 'Fechado', search: 'fechado', line: 'b' },
      { vibe: 'Frio', place: 'Lento', search: 'erro', line: 'c' },
    ],
  }],
  extras: [],
});

test('a conferência tira o que o Google não confirma', async () => {
  const fetcher = async (_url, opcoes) => {
    const busca = JSON.parse(opcoes.body).textQuery;
    if (busca === 'erro') throw new Error('rede');
    const status = busca === 'fechado' ? 'CLOSED_PERMANENTLY' : 'OPERATIONAL';
    return { ok: true, json: async () => ({ places: [{ businessStatus: status }] }) };
  };
  const { sugestao: s, consultas, recusados } = await conferirDestaques(sugestao(), 'chave', { fetcher });
  assert.deepStrictEqual(s.itinerary[0].highlights.map((h) => h.place), ['Aberto']);
  assert.strictEqual(consultas, 3);
  assert.strictEqual(recusados, 2);
});

test('sem a chave do Google, nenhum lugar sai sem conferir', async () => {
  const { sugestao: s, consultas } = await conferirDestaques(sugestao(), undefined);
  assert.deepStrictEqual(s.itinerary[0].highlights, []);
  assert.strictEqual(consultas, 0);
});

test('sem tempo de sobra, a sugestão sai sem os lugares, e sem consultar', async () => {
  let chamou = false;
  const fetcher = async () => { chamou = true; return { ok: true, json: async () => ({}) }; };
  const { sugestao: s, consultas } = await conferirDestaques(sugestao(), 'chave', { fetcher, prazoMs: 500 });
  assert.deepStrictEqual(s.itinerary[0].highlights, []);
  assert.strictEqual(consultas, 0);
  assert.strictEqual(chamou, false);
});
