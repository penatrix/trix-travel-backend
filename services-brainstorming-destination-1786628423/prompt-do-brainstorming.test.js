// Testes do prompt do brainstorming, agora montado no backend a partir
// das colunas da linha.
//
// O `prompt-do-brainstorming.regressao.json` guarda o prompt que o app
// montava (`buildBrainstormingPrompt`, no `custom_functions.dart`) para
// cinco linhas. Foi gerado a partir do template do Dart em 28/09, na
// véspera de ele sair do app, extraindo cada bloco do fonte em vez de
// copiá-lo à mão. Quando alguém MELHORAR o prompt, este teste falha -- e
// é para falhar: o arquivo se regenera junto, numa mudança que diz que o
// prompt mudou.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  montarPromptDoBrainstorming,
  listaDeRecusados,
  MAX_PEDIDO,
  MAX_RECUSADOS,
} = require('./prompt-do-brainstorming');

const casos = require('./prompt-do-brainstorming.regressao.json');

test('o prompt é o mesmo que o app montava', () => {
  assert.ok(casos.length >= 5);
  for (const [i, { linha, esperado }] of casos.entries()) {
    assert.strictEqual(montarPromptDoBrainstorming(linha), esperado, `caso ${i}`);
  }
});

test('a data da coluna entra sem hora', () => {
  const p = montarPromptDoBrainstorming({ start_date: '2026-12-01', end_date: '2026-12-09' });
  assert.match(p, /Travel Dates: From 2026-12-01 to 2026-12-09/);
  assert.doesNotMatch(p, /00:00:00/);
});

test('recusados: sem repetição, sem vazio, na ordem, com teto', () => {
  assert.deepStrictEqual(listaDeRecusados(['Porto', ' Lisboa ', 'Porto', '  ']), ['Porto', 'Lisboa']);
  assert.deepStrictEqual(listaDeRecusados(null), []);
  assert.deepStrictEqual(listaDeRecusados('Porto'), []);
  const muitos = Array.from({ length: MAX_RECUSADOS + 10 }, (_, i) => `Cidade ${i}`);
  assert.strictEqual(listaDeRecusados(muitos).length, MAX_RECUSADOS);
});

test('sem recusados, escopo ou pedido, os blocos não entram', () => {
  const p = montarPromptDoBrainstorming({ days: 5 });
  assert.doesNotMatch(p, /ALREADY SEEN AND REJECTED/);
  assert.doesNotMatch(p, /SCOPE -/);
  assert.doesNotMatch(p, /IN THEIR OWN WORDS/);
  assert.match(p, /Duration: 5 days/);
});

test('escopo desconhecido não entra com palpite', () => {
  assert.doesNotMatch(montarPromptDoBrainstorming({ trip_scope: 'lua' }), /SCOPE -/);
});

test('pedido forjado não vira prompt gigante', () => {
  const p = montarPromptDoBrainstorming({ special_request: 'a'.repeat(MAX_PEDIDO * 4) });
  const pedido = p.match(/vibes above: "(a+)"/)[1];
  assert.strictEqual(pedido.length, MAX_PEDIDO);
});

test('o handler monta aqui quando a linha não traz o prompt, e diz qual veio', () => {
  // Varredura do fonte: o handler carrega o cliente do Supabase na
  // importação e não roda sem ele.
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(fonte, /: montarPromptDoBrainstorming\(sessionRecord\);/);
  assert.match(fonte, /prompt: origemDoPrompt/);
});
