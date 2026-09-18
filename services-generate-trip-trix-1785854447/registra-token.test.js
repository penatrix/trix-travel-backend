// O registro de gasto de token.
//
// Roda com `node --test`, sem rede: o `fetch` global é substituído em
// cada caso. O que se trava aqui é o que o compilador não vê e o que a
// produção só contaria meses depois -- linha que não grava, tipo
// errado, e a regra de nunca derrubar quem chamou.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { registrarToken, TIPOS } = require('./registra-token');

const fetchOriginal = global.fetch;
const warnOriginal = console.warn;
const logOriginal = console.log;

let chamadas;
let avisos;

function fingirFetch(resposta) {
  global.fetch = async (url, opcoes) => {
    chamadas.push({ url, opcoes, corpo: JSON.parse(opcoes.body) });
    return resposta;
  };
}

const ok = { ok: true, status: 201, text: async () => '' };

beforeEach(() => {
  chamadas = [];
  avisos = [];
  console.warn = (m) => avisos.push(String(m));
  console.log = () => {};
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico';
  fingirFetch(ok);
});

afterEach(() => {
  global.fetch = fetchOriginal;
  console.warn = warnOriginal;
  console.log = logOriginal;
});

describe('o caminho feliz', () => {
  test('grava na token_usage, com a chave de serviço', async () => {
    const gravou = await registrarToken({
      kind: 'micro_activity',
      tokens: 1234,
      tripId: 290,
      userId: 'abc',
      model: 'gemini-3.1-pro',
    });
    assert.equal(gravou, true);
    assert.equal(chamadas.length, 1);
    assert.match(chamadas[0].url, /\/rest\/v1\/token_usage$/);
    assert.equal(chamadas[0].opcoes.method, 'POST');
    assert.equal(chamadas[0].opcoes.headers.apikey, 'chave-de-servico');
    // Sem isto o PostgREST devolve a linha inteira de graça.
    assert.equal(chamadas[0].opcoes.headers.Prefer, 'return=minimal');
    assert.deepEqual(chamadas[0].corpo, {
      kind: 'micro_activity',
      tokens: 1234,
      trip_id: 290,
      user_id: 'abc',
      model: 'gemini-3.1-pro',
    });
  });

  test('o roteiro vai como número, não como texto', async () => {
    // `trips.id` é bigint. O app manda número; um handler que repassasse
    // a string do corpo faria o PostgREST coagir -- ou recusar.
    await registrarToken({ kind: 'brainstorming', tokens: 10, tripId: '290' });
    assert.strictEqual(chamadas[0].corpo.trip_id, 290);
  });
});

describe('o que falta é nulo, não erro', () => {
  test('sem roteiro grava mesmo assim', async () => {
    // 80 dos 88 brainstormings medidos em 18/09 nunca viraram roteiro.
    // Exigir `trip_id` transformaria 21% do gasto real em falha de
    // escrita.
    const gravou = await registrarToken({ kind: 'brainstorming', tokens: 2653 });
    assert.equal(gravou, true);
    assert.strictEqual(chamadas[0].corpo.trip_id, null);
    assert.strictEqual(chamadas[0].corpo.user_id, null);
  });

  test('roteiro inválido vira nulo em vez de derrubar', async () => {
    for (const ruim of [0, -1, 'abc', null, undefined, NaN]) {
      chamadas = [];
      await registrarToken({ kind: 'traveler_memory', tokens: 5, tripId: ruim });
      assert.strictEqual(chamadas[0].corpo.trip_id, null, `tripId=${ruim}`);
    }
  });
});

describe('o que não é gasto não vira linha', () => {
  test('zero e negativo não gravam', async () => {
    for (const nada of [0, -5, null, undefined, 'x', NaN]) {
      assert.equal(
        await registrarToken({ kind: 'micro_activity', tokens: nada }),
        false,
        `tokens=${nada}`,
      );
    }
    assert.equal(chamadas.length, 0);
  });

  test('tipo fora da lista não grava, e avisa alto', async () => {
    // A lista é fechada por `check` no banco. Barrar aqui troca um 400
    // opaco do PostgREST por uma linha de log que diz o nome errado.
    const gravou = await registrarToken({ kind: 'geracao', tokens: 100 });
    assert.equal(gravou, false);
    assert.equal(chamadas.length, 0);
    assert.ok(avisos.some((a) => a.includes('geracao')));
  });

  test('os cinco tipos do banco são exatamente estes', async () => {
    assert.deepEqual(
      [...TIPOS].sort(),
      [
        'brainstorming',
        'classify_conflicts',
        'generate_trip',
        'micro_activity',
        'traveler_memory',
      ],
    );
  });
});

describe('nunca derruba quem chamou', () => {
  test('variável de ambiente faltando avisa e segue', async () => {
    // O `classify-conflicts` sobe hoje com duas variáveis só. Se a
    // configuração do Cloud Run não ganhar as novas, o serviço continua
    // servindo e o log diz por que o número não aparece.
    delete process.env.SUPABASE_URL;
    const gravou = await registrarToken({ kind: 'classify_conflicts', tokens: 9 });
    assert.equal(gravou, false);
    assert.equal(chamadas.length, 0);
    assert.ok(avisos.some((a) => a.includes('SUPABASE_URL')));
  });

  test('PostgREST recusando não estoura', async () => {
    fingirFetch({ ok: false, status: 401, text: async () => 'sem permissao' });
    const gravou = await registrarToken({ kind: 'generate_trip', tokens: 9000 });
    assert.equal(gravou, false);
    assert.ok(avisos.some((a) => a.includes('401')));
  });

  test('rede caída não estoura', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const gravou = await registrarToken({ kind: 'generate_trip', tokens: 9000 });
    assert.equal(gravou, false);
    assert.ok(avisos.some((a) => a.includes('ECONNREFUSED')));
  });

  test('corpo ilegível na resposta de erro também não estoura', async () => {
    fingirFetch({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('corpo quebrado');
      },
    });
    assert.equal(
      await registrarToken({ kind: 'generate_trip', tokens: 1 }),
      false,
    );
  });
});
