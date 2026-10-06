// Os feriados: o país do destino, o filtro do calendário, a pergunta ao
// Flash e a leitura conferida da resposta. Nenhum teste toca a rede.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  paisDaBusca,
  codigoDoPais,
  feriadosNoPeriodo,
  montarPerguntaDeFeriados,
  lerRespostaDeFeriados,
} = require('./feriados');

const destino = (...buscas) => ({
  city: 'X',
  itinerary: [{ activities: buscas.map((b) => ({ maps_search_query: b })) }],
});

test('o país é o último trecho da busca', () => {
  assert.equal(paisDaBusca('Confeitaria Colombo, Centro, Rio de Janeiro, Brazil'), 'Brazil');
  assert.equal(paisDaBusca('Só um nome'), null);
});

test('o código vem do apelido, em pt ou en, ou da lista da Nager', () => {
  assert.equal(codigoDoPais(destino('A, Lisboa, Portugal')), 'PT');
  assert.equal(codigoDoPais(destino('A, Roma, Itália')), 'IT');
  assert.equal(codigoDoPais(destino('A, Praga, Czech Republic')), 'CZ');
  assert.equal(
    codigoDoPais(destino('A, Tallinn, Estonia'), [{ countryCode: 'EE', name: 'Estonia' }]),
    'EE',
  );
  assert.equal(codigoDoPais(destino('A, Lugar, Atlântida')), null);
});

test('a maioria decide quando as buscas discordam', () => {
  assert.equal(
    codigoDoPais(destino('A, Foz, Brazil', 'B, Foz, Brazil', 'C, Puerto Iguazú, Argentina')),
    'BR',
  );
});

test('do calendário, só o que cai no roteiro e é dia de folga', () => {
  const lista = [
    { date: '2026-12-24', localName: 'Véspera', name: 'Christmas Eve', countryCode: 'PT', types: ['Observance'] },
    { date: '2026-12-25', localName: 'Natal', name: 'Christmas Day', countryCode: 'PT', types: ['Public'], counties: null },
    { date: '2026-06-13', localName: 'Santo António', name: 'St Anthony', countryCode: 'PT', types: ['Public'], counties: ['PT-11'] },
    { date: '2027-01-01', localName: 'Ano Novo', name: "New Year's Day", countryCode: 'PT', types: ['Public'] },
  ];
  const r = feriadosNoPeriodo(lista, '2026-12-20', '2026-12-31');
  assert.deepEqual(r, [{
    data: '2026-12-25', pais: 'PT', nome: 'Natal', nomeEmIngles: 'Christmas Day', regioes: null,
  }]);
});

test('a pergunta leva os ids, as datas com o dia da semana e o alcance do feriado', () => {
  const p = montarPerguntaDeFeriados({
    cidades: [{
      cidade: 'Lisboa',
      pais: null,
      dias: [{ data: '2026-12-25', atividades: [{ id: 'a1', lugar: 'Museu', periodo: 'Manhã' }] }],
      backups: [{ id: 'b1', lugar: 'Mercado' }],
    }],
    feriados: [
      { data: '2026-12-25', pais: 'PT', nome: 'Natal', nomeEmIngles: 'Christmas Day', regioes: null },
      { data: '2026-12-26', pais: 'PT', nome: 'X', nomeEmIngles: 'X', regioes: ['PT-11'] },
    ],
  });
  assert.match(p, /2026-12-25 \(Friday\): a1 Museu \(Manhã\)/);
  assert.match(p, /Backup places: b1 Mercado/);
  assert.match(p, /Christmas Day \(Natal\), nationwide/);
  assert.match(p, /only in PT-11/);
  assert.match(p, /Brazilian Portuguese/);
  assert.match(p, /When unsure, leave it out/);
});

// =====================================================================
// A RESPOSTA, CONFERIDA
// =====================================================================

const perguntado = {
  datasDaCidade: new Map([['Lisboa', new Set(['2026-12-24', '2026-12-25'])]]),
  lugares: new Map([
    ['a1', { cidade: 'Lisboa', data: '2026-12-25' }],
    ['a2', { cidade: 'Lisboa', data: '2026-12-24' }],
    ['b1', { cidade: 'Lisboa', data: null }],
  ]),
};

test('o que foi perguntado passa; o resto é descartado', () => {
  const r = lerRespostaDeFeriados(JSON.stringify({
    holidays: [
      { date: '2026-12-25', city: 'Lisboa', name: 'Natal' },
      { date: '2026-12-26', city: 'Lisboa', name: 'Fora do roteiro' },
      { date: '2026-12-25', city: 'Porto', name: 'Cidade que não está' },
    ],
    closed: [
      { id: 'a1', date: '2026-12-25' },
      { id: 'a2', date: '2026-12-25' }, // a2 está no dia 24
      { id: 'b1', date: '2026-12-25' },
      { id: 'b1', date: '2026-12-24' }, // 24 não é feriado
      { id: 'zz', date: '2026-12-25' },
    ],
  }), perguntado);

  assert.deepEqual(r.feriados, [{ data: '2026-12-25', cidade: 'Lisboa', nome: 'Natal' }]);
  assert.deepEqual([...r.fechados.entries()], [
    ['a1|2026-12-25', 'Natal'],
    ['b1|2026-12-25', 'Natal'],
  ]);
});

test('resposta que não é JSON devolve null', () => {
  assert.equal(lerRespostaDeFeriados('Claro! Aqui está:', perguntado), null);
});

test('JSON em cerca de código também é lido', () => {
  const r = lerRespostaDeFeriados('```json\n{"holidays":[],"closed":[]}\n```', perguntado);
  assert.deepEqual(r.feriados, []);
  assert.equal(r.fechados.size, 0);
});
