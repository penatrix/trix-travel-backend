const { test } = require('node:test');
const assert = require('node:assert');
const { corrigirDiariaDaEstadia, valorDoCusto, noitesPorDestino } = require('./diaria-da-estadia');

const roteiro = (destinos, hospedagem) => ({
  cost_breakdown: { accommodation: hospedagem },
  destinations: destinos.map(([dias, diaria]) => ({
    days: dias,
    accommodation: { estimated_cost_per_night: diaria },
  })),
});

test('o 543: a estadia de Gramado vira diária, Canela fica', () => {
  const r = roteiro([[6, 'BRL 4000 no total'], [1, 'BRL 600 no total']], 4600);
  const feito = corrigirDiariaDaEstadia(r);
  assert.deepStrictEqual(feito, { de: [4000, 600], para: [670, 600] });
  assert.strictEqual(r.destinations[0].accommodation.estimated_cost_per_night, 'BRL 670 no total');
  assert.strictEqual(r.destinations[1].accommodation.estimated_cost_per_night, 'BRL 600 no total');
});

test('diária certa não muda (o caso comum)', () => {
  // 541: 1 cidade, 5 dias = 4 noites de 800 = 3.200.
  const r = roteiro([[5, 'BRL 800 no total']], 3200);
  assert.strictEqual(corrigirDiariaDaEstadia(r), null);
  assert.strictEqual(r.destinations[0].accommodation.estimated_cost_per_night, 'BRL 800 no total');
  // 537: três cidades, diárias vezes noites perto da linha.
  assert.strictEqual(corrigirDiariaDaEstadia(
    roteiro([[3, 'BRL 3000'], [3, 'BRL 3000'], [2, 'BRL 3000']], 22000)), null);
});

test('só uma noite por cidade não tem como errar assim', () => {
  // 484: dois destinos de 1 dia, soma das diárias igual à linha.
  assert.strictEqual(corrigirDiariaDaEstadia(roteiro([[1, 'BRL 425'], [1, 'BRL 400']], 825)), null);
});

test('sem número legível ou sem linha, não mexe', () => {
  assert.strictEqual(corrigirDiariaDaEstadia(roteiro([[6, 'sob consulta']], 4000)), null);
  assert.strictEqual(corrigirDiariaDaEstadia(roteiro([[6, 'BRL 4000']], 0)), null);
  assert.strictEqual(corrigirDiariaDaEstadia({}), null);
});

test('leitura do número e das noites', () => {
  assert.strictEqual(valorDoCusto('BRL 4.000 no total'), 4000);
  assert.strictEqual(valorDoCusto('R$ 1,500 total'), 1500);
  assert.strictEqual(valorDoCusto(800), 800);
  assert.strictEqual(valorDoCusto('grátis'), null);
  assert.deepStrictEqual(noitesPorDestino([{ days: 6 }, { days: 1 }]), [6, 0]);
  assert.deepStrictEqual(noitesPorDestino([{ days: 5 }]), [4]);
});
