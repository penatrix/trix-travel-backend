// "Com quem você costuma viajar" no prompt da geração (09/10).

const { test } = require('node:test');
const assert = require('node:assert');
const { montarPromptDaGeracao, companhiaDoPerfil } = require('./prompt-da-geracao');

const linha = {
  user_language: 'pt',
  start_date: '2026-11-10',
  end_date: '2026-11-12',
  planned_destinations: [{ destination: 'Lisboa, Portugal', days: 3 }],
};

test('vira frase, e ignora o que o app não grava', () => {
  assert.deepEqual(companhiaDoPerfil(['Couple', 'Pet', 'Alien', 3]), [
    'as a couple',
    'with a pet (pet-friendly lodging and places only)',
  ]);
  assert.deepEqual(companhiaDoPerfil(undefined), []);
});

test('entra no perfil do viajante quando existe', () => {
  const p = montarPromptDaGeracao(linha, { companions: ['Kids'] });
  assert.match(p, /TRAVELER PROFILE/);
  assert.match(p, /Usually travels with children\./);
});

test('sem companhia, o prompt é o mesmo de antes', () => {
  assert.equal(
    montarPromptDaGeracao(linha, { likes: ['Museums'] }),
    montarPromptDaGeracao(linha, { likes: ['Museums'], companions: [] }),
  );
  assert.doesNotMatch(montarPromptDaGeracao(linha, null), /Usually travels/);
});
