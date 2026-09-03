// Teste de integração da passada de conserto.
//
// Os testes de `reordenar-dia.test.js` travam a REGRA; este trava a
// LIGAÇÃO — que a reordenação está de fato no caminho, antes do banco de
// backup, e que ela muta o roteiro que o handler vai gravar. É a parte
// que uma função pura testada isoladamente não prova.
//
// O `fetch` é substituído por um dublê. Nenhum destes testes toca o
// Google.

const { test } = require('node:test');
const assert = require('node:assert');

const { validarEConsertarRoteiro } = require('./validar-lugares');

const CHAVE = 'chave-de-teste';
// Segunda-feira, para o dia 1 do roteiro cair num dia útil.
const DATA_INICIO = '2026-09-07';

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

/// `lugares` é { "<place>": { status?, periods? } }.
/// Sem `status` = OPERATIONAL. Sem `periods` = sem horário cadastrado.
function comGoogle(lugares) {
  const original = global.fetch;

  global.fetch = async (url) => {
    const u = String(url);

    if (u.includes('/textsearch/')) {
      const query = decodeURIComponent(/[?&]query=([^&]*)/.exec(u)[1]);
      const nome = Object.keys(lugares).find((k) => query.includes(k));
      if (!nome) return json({ status: 'ZERO_RESULTS' });
      return json({
        status: 'OK',
        results: [{
          place_id: `id:${nome}`,
          name: nome,
          business_status: lugares[nome].status ?? 'OPERATIONAL',
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

/// Roteiro mínimo com um dia de duas atividades e um banco de backup.
function roteiroDeUmDia({ atividades, backups = [] }) {
  return {
    estimated_cost_brl: 1000,
    destinations: [{
      city: 'Curitiba',
      accommodation: {},
      itinerary: [{ day: 1, activities: atividades }],
      backup_activities: backups,
    }],
  };
}

function atv(place, period, custo = 'BRL 100 por pessoa') {
  return {
    place,
    period,
    cost_estimate: custo,
    maps_search_query: `${place} + Curitiba + Brasil`,
  };
}

const dia1 = (r) => r.destinations[0].itinerary[0].activities;

// =====================================================================

test('jantar num restaurante de almoço é reordenado, sem gastar backup', async () => {
  const restaura = comGoogle({
    // Parque sem horário cadastrado: recebe qualquer período.
    Parque: {},
    // Cantina só serve almoço.
    Cantina: { periods: todosOsDias('1130', '1500') },
    Backup: { periods: todosOsDias('0900', '2300') },
  });

  try {
    const roteiro = roteiroDeUmDia({
      atividades: [atv('Parque', 'Tarde'), atv('Cantina', 'Noite')],
      backups: [atv('Backup', undefined)],
    });

    const resumo = await validarEConsertarRoteiro(roteiro, CHAVE, {
      dataInicio: DATA_INICIO,
    });

    assert.strictEqual(resumo.fora_do_horario, 1, 'detectou o problema');
    assert.strictEqual(resumo.reordenados, 1, 'resolveu reordenando');
    assert.strictEqual(resumo.trocados_por_horario, 0, 'sem gastar backup');
    assert.strictEqual(
      roteiro.destinations[0].backup_activities.length, 1,
      'o banco continua cheio',
    );

    // A cantina foi para a tarde, o parque para a noite, e a ordem do dia
    // continua tarde-antes-de-noite.
    assert.deepStrictEqual(
      dia1(roteiro).map((a) => [a.place, a.period]),
      [['Cantina', 'Tarde'], ['Parque', 'Noite']],
    );

    // Reordenar não mexe em dinheiro: ninguém entrou nem saiu.
    assert.strictEqual(resumo.deltaCusto, 0);
    assert.strictEqual(roteiro.estimated_cost_brl, 1000);

    // E ninguém foi marcado para aviso na tela: o problema foi resolvido.
    assert.ok(!dia1(roteiro).some((a) => a.hours_mismatch));
  } finally {
    restaura();
  }
});

test('sem parceira possível, gasta backup — o caminho antigo continua', async () => {
  const restaura = comGoogle({
    // A balada só abre à noite, então não pode receber o slot do jantar...
    // ela JÁ é o jantar. O problema é a cantina, e o único outro slot é o
    // da balada, que quebraria de tarde.
    Balada: { periods: todosOsDias('2200', '2359') },
    Cantina: { periods: todosOsDias('1130', '1500') },
    Backup: { periods: todosOsDias('1800', '2300') },
  });

  try {
    const roteiro = roteiroDeUmDia({
      atividades: [atv('Cantina', 'Noite'), atv('Balada', 'Noite')],
      backups: [atv('Backup', undefined, 'BRL 100 por pessoa')],
    });

    const resumo = await validarEConsertarRoteiro(roteiro, CHAVE, {
      dataInicio: DATA_INICIO,
    });

    assert.strictEqual(resumo.reordenados, 0, 'mesmo período, nada a trocar');
    assert.strictEqual(resumo.trocados_por_horario, 1, 'caiu no backup');
    assert.ok(dia1(roteiro).some((a) => a.place === 'Backup'));
  } finally {
    restaura();
  }
});

test('sem troca e sem backup, o lugar fica MARCADO para avisar na tela', async () => {
  const restaura = comGoogle({
    Cantina: { periods: todosOsDias('1130', '1500') },
  });

  try {
    const roteiro = roteiroDeUmDia({
      atividades: [atv('Cantina', 'Noite')],
      backups: [],
    });

    const resumo = await validarEConsertarRoteiro(roteiro, CHAVE, {
      dataInicio: DATA_INICIO,
    });

    assert.strictEqual(resumo.reordenados, 0);
    assert.strictEqual(resumo.trocados_por_horario, 0);
    assert.strictEqual(resumo.mantidos_fora_do_horario, 1);

    // Continua no roteiro: buraco no dia é pior que período errado. Mas
    // agora o app tem como dizer isso ao usuário.
    assert.strictEqual(dia1(roteiro).length, 1);
    assert.strictEqual(dia1(roteiro)[0].hours_mismatch, true);
  } finally {
    restaura();
  }
});

test('lugar fechado não vira parceiro de troca — ele sai', async () => {
  const restaura = comGoogle({
    Fechado: { status: 'CLOSED_PERMANENTLY' },
    Cantina: { periods: todosOsDias('1130', '1500') },
  });

  try {
    const roteiro = roteiroDeUmDia({
      atividades: [atv('Fechado', 'Tarde'), atv('Cantina', 'Noite')],
      backups: [],
    });

    const resumo = await validarEConsertarRoteiro(roteiro, CHAVE, {
      dataInicio: DATA_INICIO,
    });

    assert.strictEqual(resumo.reordenados, 0, 'não se troca slot com condenado');
    assert.strictEqual(resumo.removidos, 1, 'o fechado saiu');
    // A cantina fica, com aviso: o slot da tarde foi removido, não cedido.
    const restantes = dia1(roteiro);
    assert.strictEqual(restantes.length, 1);
    assert.strictEqual(restantes[0].place, 'Cantina');
    assert.strictEqual(restantes[0].hours_mismatch, true);
  } finally {
    restaura();
  }
});

test('roteiro sem problema de horário não recebe marca nenhuma', async () => {
  const restaura = comGoogle({
    Parque: {},
    Bistro: { periods: todosOsDias('1800', '2300') },
  });

  try {
    const roteiro = roteiroDeUmDia({
      atividades: [atv('Parque', 'Tarde'), atv('Bistro', 'Noite')],
    });

    const resumo = await validarEConsertarRoteiro(roteiro, CHAVE, {
      dataInicio: DATA_INICIO,
    });

    assert.strictEqual(resumo.fora_do_horario, 0);
    assert.strictEqual(resumo.reordenados, 0);
    assert.strictEqual(resumo.mantidos_fora_do_horario, 0);
    assert.ok(!dia1(roteiro).some((a) => a.hours_mismatch));
    assert.deepStrictEqual(
      dia1(roteiro).map((a) => a.period),
      ['Tarde', 'Noite'],
      'nada se moveu',
    );
  } finally {
    restaura();
  }
});
