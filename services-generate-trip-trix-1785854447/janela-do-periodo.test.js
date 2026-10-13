// "Abre neste período" quer dizer aberto tempo bastante para a visita,
// não um minuto (13/10). A Fundação Serralves, que fecha às 19h, passou
// como atividade da noite no roteiro 406.

const { test } = require('node:test');
const assert = require('node:assert');
const { abreNaJanela, JANELAS, MINIMO_NA_JANELA } = require('./validar-lugares');

// Quinta-feira = 4. Horário do Google gravado na atividade do roteiro 406.
const serralves = [{ open: { day: 4, time: '1000' }, close: { day: 4, time: '1900' } }];

test('quem fecha às 19h não abre à noite', () => {
  assert.strictEqual(abreNaJanela(serralves, 4, JANELAS.noite), false);
  assert.strictEqual(abreNaJanela(serralves, 4, JANELAS.tarde), true);
  assert.strictEqual(abreNaJanela(serralves, 4, JANELAS.manha), true);
});

test('jantar que abre às 19h abre à noite', () => {
  const jantar = [{ open: { day: 4, time: '1900' }, close: { day: 4, time: '2330' } }];
  assert.strictEqual(abreNaJanela(jantar, 4, JANELAS.noite), true);
});

test('o mínimo vale na borda: 90 minutos entram, 60 não', () => {
  assert.strictEqual(MINIMO_NA_JANELA, 90);
  const ate1930 = [{ open: { day: 4, time: '1000' }, close: { day: 4, time: '1930' } }];
  assert.strictEqual(abreNaJanela(ate1930, 4, JANELAS.noite), true);
  const abre11 = [{ open: { day: 4, time: '1100' }, close: { day: 4, time: '1800' } }];
  assert.strictEqual(abreNaJanela(abre11, 4, JANELAS.manha), false);
});

test('bar de madrugada continua valendo à noite e sem close é 24h', () => {
  const bar = [{ open: { day: 4, time: '2100' }, close: { day: 5, time: '0300' } }];
  assert.strictEqual(abreNaJanela(bar, 4, JANELAS.noite), true);
  assert.strictEqual(abreNaJanela([{ open: { day: 0, time: '0000' } }], 4, JANELAS.manha), true);
});
