// As tentativas da chamada ao Gemini no brainstorming (20/10).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  PLANO,
  PRAZO_TOTAL_MS,
  ehTransitorio,
  chamarComTentativas,
} = require('./tentativas-do-gemini');

const calado = { log() {}, error() {} };

function relogioFalso() {
  let agora = 0;
  return { agora: () => agora, andar: (ms) => { agora += ms; } };
}

/// Uma "chamada" que trava até o teto da tentativa, como em 19/10.
function travada(relogio, ms) {
  return () => {
    relogio.andar(ms);
    const erro = new Error('The operation was aborted');
    erro.name = 'AbortError';
    return Promise.reject(erro);
  };
}

test('o plano: 40s e 30s, as duas com thinking LOW', () => {
  assert.deepStrictEqual(
    PLANO.map((t) => [t.timeoutMs, t.thinking]),
    [[40000, 'LOW'], [30000, 'LOW']],
  );
});

test('o prazo cabe nos 90s do Cloud Run, com folga para o catch', () => {
  const yaml = fs.readFileSync(path.join(__dirname, 'cloudbuild.yaml'), 'utf8');
  const teto = Number(/--timeout=(\d+)/.exec(yaml)[1]) * 1000;
  assert.ok(PRAZO_TOTAL_MS + 15000 <= teto, `${PRAZO_TOTAL_MS} + 15s > ${teto}`);
});

test('429 e 5xx são transitórios; 400 não', () => {
  assert.ok(ehTransitorio(429));
  assert.ok(ehTransitorio(503));
  assert.ok(!ehTransitorio(400));
});

test('a primeira trava, a segunda responde', async () => {
  const relogio = relogioFalso();
  let n = 0;
  const r = await chamarComTentativas(async (args) => {
    n += 1;
    if (n === 1) return travada(relogio, 40000)(args);
    return { ok: true, status: 200 };
  }, 'teste', { relogio: relogio.agora, log: calado });
  assert.strictEqual(r.tentativa, 2);
  assert.strictEqual(r.thinking, 'LOW');
});

test('as duas travam: lança com "timeout"', async () => {
  const relogio = relogioFalso();
  await assert.rejects(
    chamarComTentativas(travada(relogio, 40000), 'brainstorming 1', {
      relogio: relogio.agora, log: calado,
    }),
    /Falha de rede ao chamar o Gemini \(brainstorming 1\): timeout de \d+s/,
  );
});

test('a chamada do serviço usa o plano, com o thinking da tentativa', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(fonte, /chamarComTentativas\(/);
  assert.match(fonte, /thinkingConfig: \{ thinkingLevel: thinking \}/);
  assert.doesNotMatch(fonte, /GEMINI_TIMEOUT_MS/);
});
