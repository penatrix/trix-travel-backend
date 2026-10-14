// O pedido da geração exige JSON do próprio modelo (14/10).
//
// Varredura do fonte: a chamada ao Gemini não roda em teste, e é a
// configuração dela que importa aqui. Sem `responseMimeType` o texto é
// livre, e uma vírgula faltando derruba o roteiro inteiro (trip 393).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('a geração pede application/json ao Gemini', () => {
  const inicio = fonte.indexOf('async function pedirJsonAoGemini(');
  assert.notStrictEqual(inicio, -1, 'não achei pedirJsonAoGemini');
  const corpo = fonte.slice(inicio, fonte.indexOf('\n}\n', inicio));
  assert.match(corpo, /responseMimeType: "application\/json"/);
  // O thinking e o teto continuam explícitos no ponto de chamada.
  assert.match(corpo, /thinkingConfig: \{ thinkingLevel: "MEDIUM" \}/);
  assert.match(corpo, /maxOutputTokens: 32768/);
});
