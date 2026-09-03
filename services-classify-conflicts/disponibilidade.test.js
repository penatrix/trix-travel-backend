// Testes da validação de disponibilidade.
//
// `fetch` é substituído por um dublê — nenhum toca o Google. O que precisa
// ficar travado aqui é a assimetria dos vereditos, porque ela é o que
// impede a emenda de trocar um problema por outro:
//
//   status 'fechado'   -> reprova, é o pior bug do produto
//   hours_ok false     -> reprova, o lugar não abre naquele turno
//   hours_ok NULL      -> NÃO reprova: praça e mirante não têm horário
//   status 'erro'      -> não é veredito, é ausência de veredito
//
// Se alguém "limpar" isso tratando null como false, praça e mirante param
// de poder ser backup — e eles são justamente os que mais servem.

const { test } = require('node:test');
const assert = require('node:assert');

const { avaliarDisponibilidade, avaliarDisponibilidades } = require('./disponibilidade');

const CHAVE = 'chave-de-teste';

function json(corpo) {
  return { ok: true, status: 200, json: async () => corpo };
}

function todosOsDias(abre, fecha) {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    open: { day: d, time: abre },
    close: { day: d, time: fecha },
  }));
}

/// `lugares` é { "<nome>": { status?, periods?, http? } }.
function comGoogle(lugares) {
  const original = global.fetch;

  global.fetch = async (url) => {
    const u = String(url);

    if (u.includes('/textsearch/')) {
      const query = decodeURIComponent(/[?&]query=([^&]*)/.exec(u)[1]);
      const nome = Object.keys(lugares).find((k) => query.includes(k));
      if (!nome) return json({ status: 'ZERO_RESULTS' });
      const l = lugares[nome];
      if (l.http) return { ok: false, status: l.http };
      return json({
        status: 'OK',
        results: [{
          place_id: `id:${nome}`,
          name: nome,
          business_status: l.status ?? 'OPERATIONAL',
        }],
      });
    }

    if (u.includes('/place/details/')) {
      const placeId = decodeURIComponent(/[?&]place_id=([^&]*)/.exec(u)[1]);
      const l = lugares[placeId.replace(/^id:/, '')];
      return json({
        status: 'OK',
        result: l && l.periods ? { opening_hours: { periods: l.periods } } : {},
      });
    }

    throw new Error(`URL inesperada no teste: ${u}`);
  };

  return () => { global.fetch = original; };
}

const item = (id, place, period) => ({
  id,
  place,
  period,
  maps_search_query: `${place} + Curitiba + Brasil`,
});

// =====================================================================
// A ASSIMETRIA DOS VEREDITOS
// =====================================================================

test('aberto e compatível com o período passa', async () => {
  const restaura = comGoogle({ Bistro: { periods: todosOsDias('1800', '2300') } });
  try {
    const r = await avaliarDisponibilidade(item('d0-b0', 'Bistro', 'Noite'), CHAVE);
    assert.strictEqual(r.status, 'aberto');
    assert.strictEqual(r.hours_ok, true);
    assert.strictEqual(r.id, 'd0-b0');
  } finally {
    restaura();
  }
});

test('fechado permanentemente reprova, e nem pergunta o horário', async () => {
  const restaura = comGoogle({ Morto: { status: 'CLOSED_PERMANENTLY' } });
  try {
    const r = await avaliarDisponibilidade(item('d0-b1', 'Morto', 'Noite'), CHAVE);
    assert.strictEqual(r.status, 'fechado');
    assert.strictEqual(r.hours_ok, null, 'sem place_id não há horário a pedir');
  } finally {
    restaura();
  }
});

test('aberto mas fora do período reprova pelo horário', async () => {
  // O restaurante que só serve almoço, candidato a um slot de jantar.
  const restaura = comGoogle({ Cantina: { periods: todosOsDias('1130', '1500') } });
  try {
    const r = await avaliarDisponibilidade(item('d0-b2', 'Cantina', 'Noite'), CHAVE);
    assert.strictEqual(r.status, 'aberto');
    assert.strictEqual(r.hours_ok, false);
  } finally {
    restaura();
  }
});

test('SEM horário cadastrado não reprova — praça e mirante vivem aqui', async () => {
  const restaura = comGoogle({ Mirante: {} }); // OPERATIONAL, sem periods
  try {
    const r = await avaliarDisponibilidade(item('d0-b3', 'Mirante', 'Noite'), CHAVE);
    assert.strictEqual(r.status, 'aberto');
    assert.strictEqual(r.hours_ok, null, 'null é ausência de dado, não reprovação');
  } finally {
    restaura();
  }
});

test('não encontrado no Google não é reprovação, é falta de veredito', async () => {
  const restaura = comGoogle({});
  try {
    const r = await avaliarDisponibilidade(item('d0-b4', 'Fantasma', 'Noite'), CHAVE);
    assert.strictEqual(r.status, 'nao_encontrado');
    assert.strictEqual(r.hours_ok, null);
  } finally {
    restaura();
  }
});

test('erro de HTTP vira status erro, nunca exceção', async () => {
  const restaura = comGoogle({ Instavel: { http: 500 } });
  try {
    const r = await avaliarDisponibilidade(item('d0-b5', 'Instavel', 'Noite'), CHAVE);
    assert.strictEqual(r.status, 'erro');
    assert.strictEqual(r.hours_ok, null);
  } finally {
    restaura();
  }
});

test('período que não reconhecemos deixa o horário sem veredito', async () => {
  // Não é reprovação por falta de pergunta.
  const restaura = comGoogle({ Cantina: { periods: todosOsDias('1130', '1500') } });
  try {
    const r = await avaliarDisponibilidade(item('d0-b6', 'Cantina', 'Madrugada'), CHAVE);
    assert.strictEqual(r.status, 'aberto');
    assert.strictEqual(r.hours_ok, null);
  } finally {
    restaura();
  }
});

test('sem chave do Google devolve erro sem tentar a rede', async () => {
  const restaura = comGoogle({});
  try {
    const r = await avaliarDisponibilidade(item('d0-b7', 'Bistro', 'Noite'), null);
    assert.strictEqual(r.status, 'erro');
    assert.match(r.motivo, /sem chave/);
  } finally {
    restaura();
  }
});

// =====================================================================
// O LOTE
// =====================================================================

test('valida em lote e devolve um veredito por item', async () => {
  const restaura = comGoogle({
    Bistro: { periods: todosOsDias('1800', '2300') },
    Cantina: { periods: todosOsDias('1130', '1500') },
    Morto: { status: 'CLOSED_PERMANENTLY' },
  });
  try {
    const r = await avaliarDisponibilidades(
      [
        item('d0-b0', 'Bistro', 'Noite'),
        item('d0-b1', 'Cantina', 'Noite'),
        item('d0-b2', 'Morto', 'Noite'),
      ],
      CHAVE,
    );
    assert.strictEqual(r.length, 3);
    assert.deepStrictEqual(r.map((x) => x.id), ['d0-b0', 'd0-b1', 'd0-b2']);
    assert.strictEqual(r[0].hours_ok, true);
    assert.strictEqual(r[1].hours_ok, false);
    assert.strictEqual(r[2].status, 'fechado');
  } finally {
    restaura();
  }
});

test('IGNORA itens sem maps_search_query — são as atividades, já validadas', async () => {
  const restaura = comGoogle({ Bistro: { periods: todosOsDias('1800', '2300') } });
  try {
    const r = await avaliarDisponibilidades(
      [
        { id: 'd0-i0-a0', place: 'Museu' }, // sem maps_search_query
        item('d0-b0', 'Bistro', 'Noite'),
      ],
      CHAVE,
    );
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].id, 'd0-b0');
  } finally {
    restaura();
  }
});

test('lista vazia devolve lista vazia, sem tocar a rede', async () => {
  const original = global.fetch;
  global.fetch = async () => { throw new Error('não devia chamar'); };
  try {
    assert.deepStrictEqual(await avaliarDisponibilidades([], CHAVE), []);
    assert.deepStrictEqual(await avaliarDisponibilidades(null, CHAVE), []);
  } finally {
    global.fetch = original;
  }
});
