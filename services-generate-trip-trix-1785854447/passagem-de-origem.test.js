// A ida e volta da origem pelo grupo todo: `passagem-de-origem.js`.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { normalizarPassagem } = require('./passagem-de-origem');
const { montarPromptDaGeracao } = require('./prompt-da-geracao');
const casos = require('./prompt-da-geracao.casos.json');

/// O roteiro 333 de 02/10: 2 viajantes, R$ 2.500 de passagem "para o
/// grupo", as cinco linhas somando R$ 11.400.
function roteiro(origem) {
  return {
    estimated_cost_brl: 11400,
    cost_breakdown: {
      flights: 2500,
      accommodation: 4200,
      activities_and_tickets: 3040,
      food_not_listed: 800,
      local_transport: 860,
    },
    ...(origem === undefined ? {} : { origin_transfer: origem }),
  };
}

const soma = (bd) => Object.values(bd).reduce((a, b) => a + b, 0);

test('a passagem é o valor por pessoa vezes o grupo', () => {
  const r = roteiro({ mode: 'bus', per_person_brl: 320 });
  const res = normalizarPassagem(r, 2);
  assert.strictEqual(r.cost_breakdown.flights, 640);
  assert.deepStrictEqual(res, { modo: 'bus', de: 2500, para: 640 });
});

test('o total muda pela diferença, e as cinco linhas continuam somando', () => {
  const r = roteiro({ mode: 'bus', per_person_brl: 320 });
  normalizarPassagem(r, 2);
  assert.strictEqual(r.estimated_cost_brl, 11400 - 2500 + 640);
  assert.strictEqual(soma(r.cost_breakdown), r.estimated_cost_brl);
});

test('dois viajantes custam o dobro de um', () => {
  // O 333 e o 335 vieram com o mesmo R$ 2.500, um com 2 pessoas e o
  // outro com 1. Com a conta aqui, isso não se repete.
  const um = roteiro({ mode: 'flight', per_person_brl: 1250 });
  const dois = roteiro({ mode: 'flight', per_person_brl: 1250 });
  normalizarPassagem(um, 1);
  normalizarPassagem(dois, 2);
  assert.strictEqual(dois.cost_breakdown.flights, 2 * um.cost_breakdown.flights);
});

test('valor por pessoa em texto de dígitos é lido; o resto não', () => {
  const r = roteiro({ mode: 'car', per_person_brl: '1.500' });
  normalizarPassagem(r, 2);
  assert.strictEqual(r.cost_breakdown.flights, 3000);
  assert.strictEqual(r.origin_transfer.per_person_brl, 1500);

  for (const ruim of [null, 0, -200, 'BRL 300 por pessoa', 'cerca de 300', {}]) {
    const x = roteiro({ mode: 'bus', per_person_brl: ruim });
    const res = normalizarPassagem(x, 2);
    assert.strictEqual(x.cost_breakdown.flights, 2500, String(ruim));
    assert.strictEqual(x.estimated_cost_brl, 11400, String(ruim));
    assert.deepStrictEqual(res, { modo: 'bus', de: null, para: null });
  }
});

test('sem origin_transfer nada muda, e o retorno diz isso', () => {
  // Roteiro sem cidade de origem, ou prompt legado: o `flights` é o que
  // o modelo pôs.
  const r = roteiro();
  assert.strictEqual(normalizarPassagem(r, 2), null);
  assert.strictEqual(r.cost_breakdown.flights, 2500);
  assert.strictEqual(r.estimated_cost_brl, 11400);
  assert.strictEqual(normalizarPassagem(roteiro([]), 2), null);
  assert.strictEqual(normalizarPassagem(null, 2), null);
});

test('meio fora da lista sai do JSON, e o valor ainda vale', () => {
  const r = roteiro({ mode: 'Ônibus leito', per_person_brl: 300 });
  const res = normalizarPassagem(r, 1);
  assert.ok(!('mode' in r.origin_transfer));
  assert.strictEqual(res.modo, null);
  assert.strictEqual(r.cost_breakdown.flights, 300);
  // Caixa e espaço não são meio errado.
  const r2 = roteiro({ mode: ' Flight ', per_person_brl: 300 });
  normalizarPassagem(r2, 1);
  assert.strictEqual(r2.origin_transfer.mode, 'flight');
});

test('viajantes inválido conta como um', () => {
  const r = roteiro({ mode: 'bus', per_person_brl: 300 });
  normalizarPassagem(r, NaN);
  assert.strictEqual(r.cost_breakdown.flights, 300);
});

test('o prompt pede o objeto só quando há origem', () => {
  const com = montarPromptDaGeracao(casos[0].linha);
  assert.match(com, /You MUST include an "origin_transfer" object/);
  assert.match(com, /"per_person_brl": "integer: the round trip for ONE traveler"/);
  assert.match(com, /bus or car when the road trip takes about 6 hours or less each way/);
  assert.match(com, /set this to its "per_person_brl" multiplied by 2\./);
  assert.doesNotMatch(com, /round-trip airfare/, 'a regra de sempre voo voltou');

  const sem = montarPromptDaGeracao({ ...casos[0].linha, origin_city: null });
  assert.doesNotMatch(sem, /origin_transfer/);
  assert.match(sem, /origin city is UNKNOWN, so set this to 0/);
});

test('o handler normaliza antes de validar lugares, e registra o meio', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const normaliza = fonte.indexOf('normalizarPassagem(tripJsonObject');
  const valida = fonte.indexOf('await validarEConsertarRoteiro(');
  assert.notStrictEqual(normaliza, -1);
  assert.notStrictEqual(valida, -1);
  assert.ok(normaliza < valida);
  assert.ok(normaliza > fonte.indexOf('JSON.parse(cleanText)'));
  assert.match(fonte, /passagem: passagem\?\.modo \?\? null/);
});
