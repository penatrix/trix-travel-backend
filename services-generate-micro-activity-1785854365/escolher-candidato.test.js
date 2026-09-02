// Testes da escolha entre os candidatos da troca de atividade.
//
// Não tocam no Google: `fetch` é substituído por um dublê que responde a
// partir de um mapa de lugares declarado em cada teste. É de propósito -
// o que precisa ser exercitado aqui é a DECISÃO (quem ganha de quem, e o
// que acontece quando não dá para verificar), não o cliente HTTP.
//
// Rode com `npm test` na pasta do serviço: o `pretest` copia o
// validar-lugares.js da pasta do generate-trip, que é a mesma cópia que o
// cloudbuild faz. Rodar `node --test` direto, sem o pretest, falha no
// require - e falhar é melhor que testar uma cópia velha.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  escolherCandidato,
  abreNoPeriodoEmAlgumDia,
  penalidade,
} = require('./escolher-candidato');

const CHAVE = 'chave-de-teste';

/// Um candidato como o Gemini devolve (só o que a escolha olha).
function cand(nome) {
  return { place: nome, maps_search_query: `${nome} + Lisboa + Portugal` };
}

/// Substitui o `fetch` global por um dublê.
///
/// `lugares` é { "<nome do lugar>": { status, periods } }:
///   status  - o business_status do textsearch, ou 'ZERO_RESULTS' /
///             'ERRO_HTTP' para os caminhos ruins
///   periods - o opening_hours.periods do place/details, ou undefined
///
/// Devolve uma função para restaurar o fetch original, chamada no finally
/// de cada teste para um teste não contaminar o outro.
function comGoogle(lugares) {
  const original = global.fetch;

  global.fetch = async (url) => {
    const u = String(url);

    if (u.includes('/textsearch/')) {
      const query = decodeURIComponent(/[?&]query=([^&]*)/.exec(u)[1]);
      const nome = Object.keys(lugares).find((k) => query.includes(k));
      const l = nome ? lugares[nome] : null;

      if (!l) return json({ status: 'ZERO_RESULTS' });
      if (l.status === 'ERRO_HTTP') return { ok: false, status: 500 };
      if (l.status === 'ZERO_RESULTS') return json({ status: 'ZERO_RESULTS' });

      return json({
        status: 'OK',
        results: [{ place_id: `id:${nome}`, name: nome, business_status: l.status }],
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

function json(corpo) {
  return { ok: true, status: 200, json: async () => corpo };
}

/// Aberto todos os dias no intervalo dado (formato do Places).
function todosOsDias(abre, fecha) {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    open: { day: d, time: abre },
    close: { day: d, time: fecha },
  }));
}

// =====================================================================
// A ESCOLHA
// =====================================================================

test('fica com o primeiro quando todos passam - o modelo já ranqueia', async () => {
  const restaura = comGoogle({
    Alfa: { status: 'OPERATIONAL', periods: todosOsDias('1900', '2300') },
    Beta: { status: 'OPERATIONAL', periods: todosOsDias('1900', '2300') },
    Gama: { status: 'OPERATIONAL', periods: todosOsDias('1900', '2300') },
  });
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta'), cand('Gama')], 'noite', CHAVE);
    assert.strictEqual(r.escolhido.place, 'Alfa');
    assert.strictEqual(r.indiceEscolhido, 0);
    assert.strictEqual(r.degradado, false);
  } finally {
    restaura();
  }
});

test('pula o fechado permanentemente e entrega o próximo', async () => {
  const restaura = comGoogle({
    Alfa: { status: 'CLOSED_PERMANENTLY' },
    Beta: { status: 'OPERATIONAL', periods: todosOsDias('1900', '2300') },
  });
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta')], 'noite', CHAVE);
    assert.strictEqual(r.escolhido.place, 'Beta');
    assert.strictEqual(r.degradado, false);
  } finally {
    restaura();
  }
});

test('pula quem não abre no período pedido - o defeito que motivou tudo isto', async () => {
  // O restaurante que só serve almoço, sugerido para um slot de jantar.
  const restaura = comGoogle({
    Alfa: { status: 'OPERATIONAL', periods: todosOsDias('1200', '1500') },
    Beta: { status: 'OPERATIONAL', periods: todosOsDias('1900', '2300') },
  });
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta')], 'noite', CHAVE);
    assert.strictEqual(r.escolhido.place, 'Beta');
    assert.strictEqual(r.degradado, false);
  } finally {
    restaura();
  }
});

test('prefere o verificado ao que não deu para verificar', async () => {
  const restaura = comGoogle({
    // Alfa nem aparece no mapa: cai em ZERO_RESULTS.
    Beta: { status: 'OPERATIONAL', periods: todosOsDias('1900', '2300') },
  });
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta')], 'noite', CHAVE);
    assert.strictEqual(r.escolhido.place, 'Beta');
  } finally {
    restaura();
  }
});

test('sem horário cadastrado continua elegível - praça e mirante não têm', async () => {
  const restaura = comGoogle({
    Alfa: { status: 'OPERATIONAL' }, // sem periods
    Beta: { status: 'OPERATIONAL', periods: todosOsDias('1900', '2300') },
  });
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta')], 'noite', CHAVE);
    assert.strictEqual(r.escolhido.place, 'Alfa');
    assert.strictEqual(r.degradado, false);
  } finally {
    restaura();
  }
});

test('erro do Google não descarta o candidato, só o deixa sem veredito', async () => {
  const restaura = comGoogle({
    Alfa: { status: 'ERRO_HTTP' },
    Beta: { status: 'CLOSED_PERMANENTLY' },
  });
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta')], 'noite', CHAVE);
    // Não verificado (1) ganha de fechado (100).
    assert.strictEqual(r.escolhido.place, 'Alfa');
    assert.strictEqual(r.degradado, false);
  } finally {
    restaura();
  }
});

test('todos fechados ainda entrega algo, marcado como degradado', async () => {
  const restaura = comGoogle({
    Alfa: { status: 'CLOSED_PERMANENTLY' },
    Beta: { status: 'CLOSED_PERMANENTLY' },
  });
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta')], 'noite', CHAVE);
    assert.ok(r.escolhido, 'entregar algo é melhor que não entregar nada');
    assert.strictEqual(r.degradado, true);
    assert.match(r.motivo, /fechad/);
  } finally {
    restaura();
  }
});

test('nenhum compatível com o período entrega o menos pior, degradado', async () => {
  const restaura = comGoogle({
    Alfa: { status: 'OPERATIONAL', periods: todosOsDias('1200', '1500') },
    Beta: { status: 'OPERATIONAL', periods: todosOsDias('1200', '1500') },
  });
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta')], 'noite', CHAVE);
    assert.strictEqual(r.escolhido.place, 'Alfa');
    assert.strictEqual(r.degradado, true);
  } finally {
    restaura();
  }
});

test('sem chave do Google entrega o primeiro, sem verificar', async () => {
  const restaura = comGoogle({});
  try {
    const r = await escolherCandidato([cand('Alfa'), cand('Beta')], 'noite', null);
    assert.strictEqual(r.escolhido.place, 'Alfa');
    assert.strictEqual(r.degradado, false);
  } finally {
    restaura();
  }
});

test('app antigo: um objeto só, tratado como lista de um', async () => {
  const restaura = comGoogle({
    Alfa: { status: 'OPERATIONAL', periods: todosOsDias('1900', '2300') },
  });
  try {
    const r = await escolherCandidato(cand('Alfa'), 'noite', CHAVE);
    assert.strictEqual(r.escolhido.place, 'Alfa');
    assert.strictEqual(r.vereditos.length, 1);
  } finally {
    restaura();
  }
});

test('app antigo: sem período, a checagem de horário nem roda', async () => {
  // Só serve almoço, mas sem período informado ninguém tem como saber -
  // e o de fechamento continua valendo. É o caminho do app não atualizado.
  const restaura = comGoogle({
    Alfa: { status: 'OPERATIONAL', periods: todosOsDias('1200', '1500') },
  });
  try {
    const r = await escolherCandidato([cand('Alfa')], undefined, CHAVE);
    assert.strictEqual(r.escolhido.place, 'Alfa');
    assert.strictEqual(r.vereditos[0].horario, null);
    assert.strictEqual(r.degradado, false);
  } finally {
    restaura();
  }
});

test('lista vazia é erro de programação, não caminho degradado', async () => {
  await assert.rejects(() => escolherCandidato([], 'noite', CHAVE));
});

// =====================================================================
// NÍVEL 1: abre neste período em ALGUM dia?
// =====================================================================

test('nível 1: só almoço não abre à noite', () => {
  assert.strictEqual(
    abreNoPeriodoEmAlgumDia(todosOsDias('1200', '1500'), [18 * 60, 24 * 60]),
    false,
  );
});

test('nível 1: quem serve jantar abre à noite', () => {
  assert.strictEqual(
    abreNoPeriodoEmAlgumDia(todosOsDias('1900', '2300'), [18 * 60, 24 * 60]),
    true,
  );
});

test('nível 1: basta UM dia da semana - o brunch de domingo conta', () => {
  const periods = [{ open: { day: 0, time: '1000' }, close: { day: 0, time: '1400' } }];
  assert.strictEqual(abreNoPeriodoEmAlgumDia(periods, [6 * 60, 12 * 60]), true);
});

test('nível 1: sem dado é null, e null NÃO é fechado', () => {
  assert.strictEqual(abreNoPeriodoEmAlgumDia(null, [18 * 60, 24 * 60]), null);
  assert.strictEqual(abreNoPeriodoEmAlgumDia([], [18 * 60, 24 * 60]), null);
});

// =====================================================================
// A ORDENAÇÃO
//
// A escala é o que garante que verificar nunca PIORA a escolha. Se estes
// números mudarem sem intenção, os testes acima passam a testar outra
// coisa - por isso a ordem está fixada aqui, explícita.
// =====================================================================

test('a ordem da penalidade: verificado < não verificado < fora do período < fechado', () => {
  const verificado = penalidade({ status: 'aberto', horario: true });
  const semHorario = penalidade({ status: 'aberto', horario: null });
  const naoVerificado = penalidade({ status: 'nao_encontrado', horario: null });
  const foraDoPeriodo = penalidade({ status: 'aberto', horario: false });
  const fechado = penalidade({ status: 'fechado', horario: null });

  assert.strictEqual(verificado, 0);
  assert.strictEqual(semHorario, 0, 'ausência de horário não penaliza');
  assert.ok(verificado < naoVerificado);
  assert.ok(naoVerificado < foraDoPeriodo);
  assert.ok(foraDoPeriodo < fechado);
});
