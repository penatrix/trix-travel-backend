// Testes do prompt da geração, montado no backend a partir da row.
//
// `prompt-da-geracao.casos.json` guarda nove entradas e o prompt que este
// serviço monta para cada uma. O mesmo arquivo vive no app, e lá o
// `buildGeminiPrompt` do Dart precisa produzir exatamente o mesmo texto
// (`test/prompt_da_geracao_paridade_test.dart`). Aqui o teste trava o
// lado do backend: mudar o prompt sem regenerar os casos falha.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  montarPromptDaGeracao,
  ritmoDe,
  dietaryToDb,
  diasEntre,
} = require('./prompt-da-geracao');

const casos = require('./prompt-da-geracao.casos.json');

test('o prompt é o dos casos, que o app confere contra o Dart', () => {
  assert.ok(casos.length >= 9);
  for (const c of casos) {
    assert.strictEqual(montarPromptDaGeracao(c.linha, c.dna), c.esperado, c.nome);
  }
});

test('os dias contam as duas pontas, sem depender do fuso', () => {
  assert.strictEqual(diasEntre('2026-12-01', '2026-12-09'), 9);
  assert.strictEqual(diasEntre('2026-12-01', '2026-12-01'), 1);
  // A virada do horário de verão europeu não come um dia.
  assert.strictEqual(diasEntre('2026-10-20', '2026-10-30'), 11);
});

test('o ritmo aceita canônico, rótulo novo e nome antigo', () => {
  assert.strictEqual(ritmoDe('Balanced').paradas, 3);
  assert.strictEqual(ritmoDe('Turbina ligada').paradas, 5);
  assert.strictEqual(ritmoDe('De boa').paradas, 2);
  assert.strictEqual(ritmoDe(''), null);
  assert.strictEqual(ritmoDe('Lento'), null);
});

test('restrição alimentar vai em inglês, e desconhecida passa intacta', () => {
  assert.deepStrictEqual(dietaryToDb(['Sem glúten', 'Vegan', 'Kosher']), ['Gluten-free', 'Vegan', 'Kosher']);
});

test('as datas provisórias não viram datas fixas', () => {
  const base = casos[0].linha;
  assert.match(montarPromptDaGeracao({ ...base, is_date_set: true }), /These dates are FIXED/);
  assert.match(montarPromptDaGeracao({ ...base, is_date_set: false }), /PLACEHOLDER for duration only/);
  // Sem a coluna, o erro seguro: tratar como aproximada.
  assert.match(montarPromptDaGeracao({ ...base, is_date_set: undefined }), /PLACEHOLDER/);
});

test('o teto é do grupo, e sem teto não se inventa um', () => {
  const base = casos[0].linha;
  assert.match(montarPromptDaGeracao(base), /Total Budget: BRL 16000 for the WHOLE trip, airfare included/);
  assert.match(montarPromptDaGeracao({ ...base, budget_limit: null }), /Total Budget: Not specified/);
});

test('sem origem, a passagem é zero e não se inventa tarifa', () => {
  const base = casos[0].linha;
  assert.match(montarPromptDaGeracao({ ...base, origin_city: '  ' }), /origin city is UNKNOWN, so set this to 0/);
  assert.match(montarPromptDaGeracao(base), /departing from São Paulo/);
});

test('o handler monta aqui quando a row não traz o prompt, e diz qual veio', () => {
  // Varredura do fonte: o handler cria o cliente do Supabase na importação
  // e não roda sem ele.
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(fonte, /montarPromptDaGeracao\(tripAtual, dono\?\.travel_dna \?\? null\)/);
  assert.match(fonte, /prompt: origemDoPrompt/);
  for (const coluna of ['planned_destinations', 'origin_city', 'is_date_set', 'budget_limit', 'vibe_tags']) {
    assert.match(fonte, new RegExp(coluna), `o select precisa ler ${coluna}`);
  }
});
