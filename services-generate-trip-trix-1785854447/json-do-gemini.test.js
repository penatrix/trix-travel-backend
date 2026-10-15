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
  const inicio = fonte.indexOf('async function pedirJsonUmaVez(');
  assert.notStrictEqual(inicio, -1, 'não achei pedirJsonUmaVez');
  const corpo = fonte.slice(inicio, fonte.indexOf('\n}\n', inicio));
  assert.match(corpo, /responseMimeType: "application\/json"/);
  // O thinking e o teto continuam explícitos no ponto de chamada.
  assert.match(corpo, /thinkingConfig: \{ thinkingLevel: "MEDIUM" \}/);
  assert.match(corpo, /maxOutputTokens: 32768/);
});

// JSON quebrado pede de novo, uma vez (15/10, trip 424).
const { comSegundaTentativa, somarUso } = require('./json-de-novo');

test('JSON quebrado pede de novo, e a segunda vale', async () => {
  const tentativas = [];
  let avisos = 0;
  const r = await comSegundaTentativa(async (n) => {
    tentativas.push(n);
    if (n === 1) JSON.parse('{"a": 1 "b": 2}');
    return 'ok';
  }, () => { avisos += 1; });
  assert.strictEqual(r, 'ok');
  assert.deepStrictEqual(tentativas, [1, 2]);
  assert.strictEqual(avisos, 1);
});

test('duas quebras seguidas: falha, sem terceira', async () => {
  let chamadas = 0;
  await assert.rejects(
    comSegundaTentativa(async () => { chamadas += 1; JSON.parse('{'); }),
    SyntaxError,
  );
  assert.strictEqual(chamadas, 2);
});

test('erro que não é de JSON não repete', async () => {
  let chamadas = 0;
  await assert.rejects(
    comSegundaTentativa(async () => {
      chamadas += 1;
      throw new Error('Gemini interrompeu a geração (finishReason: MAX_TOKENS).');
    }),
    /MAX_TOKENS/,
  );
  assert.strictEqual(chamadas, 1);
});

test('o uso das duas tentativas é somado', () => {
  assert.deepStrictEqual(
    somarUso(
      { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
      { promptTokenCount: 100, candidatesTokenCount: 70, totalTokenCount: 170, thoughtsTokenCount: 9 },
    ),
    { promptTokenCount: 200, candidatesTokenCount: 120, totalTokenCount: 320, thoughtsTokenCount: 9 },
  );
  assert.deepStrictEqual(somarUso(null, { totalTokenCount: 1 }), { totalTokenCount: 1 });
  assert.strictEqual(somarUso(null, null), null);
});

test('a geração e o refazer passam pela segunda tentativa', () => {
  const corpo = fonte.slice(
    fonte.indexOf('async function pedirJsonAoGemini('),
    fonte.indexOf('async function pedirJsonUmaVez('),
  );
  assert.match(corpo, /comSegundaTentativa\(/);
  assert.match(corpo, /somarUso\(/);
});
