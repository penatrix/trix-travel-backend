// "Perto de você" (09/10): o pedido e a conferência da resposta.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { montarPromptPerto, conferirPerto, tempoLimpo, QUANTOS } = require('./perto');

describe('montarPromptPerto', () => {
  const p = montarPromptPerto({ origin: 'Recife, PE, Brasil', vibes: ['Beach'], lang: 'pt' });

  test('leva a origem, as vibes e a regra de distância', () => {
    assert.match(p, /HOME CITY: Recife, PE, Brasil/);
    assert.match(p, /TRAVELER VIBES: Beach/);
    assert.match(p, /at most 5 hours by car, bus or train/);
  });

  test('pede exatamente três, sem coordenada e sem a própria origem', () => {
    assert.match(p, new RegExp(`exactly ${QUANTOS} destinations`));
    assert.match(p, /Never return coordinates/);
    assert.match(p, /Never the home city itself/);
  });

  test('resposta na língua da tela', () => {
    assert.match(p, /Brazilian Portuguese/);
    assert.match(montarPromptPerto({ origin: 'X', lang: 'en' }), /in English/);
  });
});

describe('conferirPerto', () => {
  const bom = (extra = {}) => ({
    name: 'Porto de Galinhas',
    search: 'Porto de Galinhas, PE, Brasil',
    mode: 'carro',
    time: '1h30',
    days: 3,
    reason: 'piscinas naturais na maré baixa',
    ...extra,
  });

  test('o caminho feliz', () => {
    const r = conferirPerto({ perto: [bom()] }, { origin: 'Recife, PE, Brasil' });
    assert.deepEqual(r.resposta.perto, [bom()]);
  });

  test('tira a própria origem, o repetido e o incompleto', () => {
    const r = conferirPerto({
      perto: [
        bom({ name: 'Recife' }),
        bom(),
        bom(),
        bom({ name: 'Olinda', mode: 'teletransporte' }),
        bom({ name: 'Caruaru', time: 'umas duas horas' }),
        bom({ name: 'Maragogi', reason: '' }),
      ],
    }, { origin: 'Recife, PE, Brasil' });
    assert.deepEqual(r.resposta.perto.map((c) => c.name), ['Porto de Galinhas']);
    assert.equal(r.descartados.length, 5);
  });

  test('no máximo três, e dias entre 2 e 4', () => {
    const r = conferirPerto({
      perto: ['A', 'B', 'C', 'D'].map((n, i) => bom({ name: n, days: i === 0 ? 9 : 1 })),
    }, { origin: 'Recife' });
    assert.equal(r.resposta.perto.length, QUANTOS);
    assert.equal(r.resposta.perto[0].days, 4);
    assert.equal(r.resposta.perto[1].days, 2);
  });

  test('nada utilizável vira null, e o app esconde a seção', () => {
    assert.equal(conferirPerto(null, { origin: 'X' }), null);
    assert.equal(conferirPerto({ perto: [] }, { origin: 'X' }), null);
    assert.equal(conferirPerto({ outra: [] }, { origin: 'X' }), null);
  });

  test('tempo legível', () => {
    assert.equal(tempoLimpo('2h'), '2h');
    assert.equal(tempoLimpo(' 2h 30 '), '2h30');
    assert.equal(tempoLimpo('45min'), '45min');
    assert.equal(tempoLimpo('2 horas'), null);
  });
});

test('o handler declara thinking e teto, e registra o modo', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(fonte, /thinkingConfig: \{ thinkingLevel: 'LOW' \}/);
  assert.match(fonte, /meta: \{ modo: 'perto'/);
  assert.match(fonte, /corpo\.modo === 'perto'/);
});
