// As tentativas da chamada ao Gemini (20/10, trip 446).

const { test } = require('node:test');
const assert = require('node:assert');
const {
  PLANO,
  PRAZO_TOTAL_MS,
  ehTransitorio,
  chamarComTentativas,
} = require('./tentativas-do-gemini');

const calado = { log() {}, error() {} };

/// Um relógio que só anda quando o teste manda: as tentativas não esperam
/// tempo de verdade.
function relogioFalso() {
  let agora = 0;
  return { agora: () => agora, andar: (ms) => { agora += ms; } };
}

/// Uma "chamada" que trava até o sinal abortar, como o Gemini da 446.
function travada(relogio, msAteAbortar) {
  return ({ signal }) => new Promise((_, rejeitar) => {
    relogio.andar(msAteAbortar);
    const erro = new Error('The operation was aborted');
    erro.name = 'AbortError';
    if (signal) rejeitar(erro);
  });
}

test('o plano: 240s, três tentativas, e a última pensa menos', () => {
  assert.deepStrictEqual(
    PLANO.map((t) => [t.timeoutMs, t.thinking]),
    [[240000, 'MEDIUM'], [240000, 'MEDIUM'], [240000, 'LOW']],
  );
});

test('o prazo cabe nos 900s do Cloud Run e do coletor do banco', () => {
  // + ~105s de validação de lugares e as escritas: tem de sobrar folga.
  assert.ok(PRAZO_TOTAL_MS + 105000 < 900000 - 60000);
});

test('429 e 5xx são transitórios; 400 e 403 não', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.ok(ehTransitorio(s), String(s));
  for (const s of [200, 400, 401, 403, 404]) assert.ok(!ehTransitorio(s), String(s));
});

test('a primeira que responde vale, com o thinking dela', async () => {
  const pedidos = [];
  const r = await chamarComTentativas(async ({ thinking }) => {
    pedidos.push(thinking);
    return { ok: true, status: 200 };
  }, 'teste', { log: calado });
  assert.deepStrictEqual(pedidos, ['MEDIUM']);
  assert.strictEqual(r.tentativa, 1);
  assert.strictEqual(r.thinking, 'MEDIUM');
});

test('duas travadas: a terceira sai com thinking LOW', async () => {
  const relogio = relogioFalso();
  const pedidos = [];
  let n = 0;
  const r = await chamarComTentativas(async (args) => {
    pedidos.push(args.thinking);
    n += 1;
    if (n < 3) return travada(relogio, 240000)(args);
    return { ok: true, status: 200 };
  }, 'teste', { relogio: relogio.agora, log: calado });
  assert.deepStrictEqual(pedidos, ['MEDIUM', 'MEDIUM', 'LOW']);
  assert.strictEqual(r.tentativa, 3);
});

test('três travadas: lança com "timeout", que o evento grava como timeout', async () => {
  const relogio = relogioFalso();
  await assert.rejects(
    chamarComTentativas(travada(relogio, 240000), 'trip 1', {
      relogio: relogio.agora, log: calado,
    }),
    /Falha de rede ao chamar o Gemini \(trip 1\): timeout de \d+s/,
  );
});

test('a tentativa que não cabe no prazo não começa', async () => {
  const relogio = relogioFalso();
  let chamadas = 0;
  await assert.rejects(
    chamarComTentativas(async (args) => {
      chamadas += 1;
      return travada(relogio, 240000)(args);
    }, 'teste', { relogio: relogio.agora, log: calado, prazoTotalMs: 500000 }),
    /timeout/,
  );
  // 240 + 240 = 480s: sobram 20s, menos que o mínimo de 60s.
  assert.strictEqual(chamadas, 2);
});

test('o prazo vale entre pedidos: o segundo herda o que sobrou', async () => {
  const relogio = relogioFalso();
  const fim = relogio.agora() + PRAZO_TOTAL_MS;
  // O primeiro pedido gastou 650s e respondeu (com JSON quebrado, digamos).
  relogio.andar(650000);
  let chamadas = 0;
  await assert.rejects(
    chamarComTentativas(async () => { chamadas += 1; return { ok: true, status: 200 }; },
      'teste', { relogio: relogio.agora, log: calado, fim }),
    /não coube|timeout|nenhuma/,
  );
  assert.strictEqual(chamadas, 0);
});

test('503 repete depois de uma pausa; 400 devolve na hora', async () => {
  const pausas = [];
  let n = 0;
  const r = await chamarComTentativas(async () => {
    n += 1;
    return n === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
  }, 'teste', { log: calado, esperar: async (ms) => { pausas.push(ms); } });
  assert.strictEqual(r.tentativa, 2);
  assert.deepStrictEqual(pausas, [5000]);

  let m = 0;
  const r400 = await chamarComTentativas(async () => {
    m += 1;
    return { ok: false, status: 400 };
  }, 'teste', { log: calado, esperar: async () => {} });
  assert.strictEqual(m, 1);
  assert.strictEqual(r400.resposta.status, 400);
});

test('503 até o fim: devolve a última resposta, para o erro dizer o que veio', async () => {
  const r = await chamarComTentativas(async () => ({ ok: false, status: 503 }),
    'teste', { log: calado, esperar: async () => {} });
  assert.strictEqual(r.tentativa, 3);
  assert.strictEqual(r.resposta.status, 503);
});
