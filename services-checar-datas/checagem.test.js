// A parte pura da checagem de datas. Nenhum teste toca a rede: o
// horário vem guardado na atividade, e o feriado é um predicado.
//
// Rode com `npm test`: o `pretest` copia o validar-lugares, como o
// cloudbuild faz.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  limparEntrada,
  achatarDias,
  dataDoDia,
  diaDaSemanaDe,
  marcarLugares,
  desmarcarLugares,
  aplicarChecagem,
  aplicarTrocaDaIa,
  marcarAviso,
  pedidoParaIa,
  lugaresParaEvitar,
  ajustarCusto,
  MAX_TROCAS_PELA_IA,
  MARCA,
} = require('./checagem');

// 2026-12-21 é uma segunda-feira.
const SEGUNDA = '2026-12-21';

/// Aberto todos os dias no intervalo dado (formato do Places).
function todosOsDias(abre, fecha) {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => ({
    open: { day: d, time: abre },
    close: { day: d, time: fecha },
  }));
}

/// Fecha às segundas (day 1); nos outros dias, das 10h às 18h.
function fechaAsSegundas() {
  return [0, 2, 3, 4, 5, 6].map((d) => ({
    open: { day: d, time: '1000' },
    close: { day: d, time: '1800' },
  }));
}

function atv(place, period, horarios, custo = 'BRL 100 por pessoa') {
  const a = { place, period, cost_estimate: custo, maps_search_query: `${place}, Lisboa, Portugal` };
  if (horarios) a.opening_hours_periods = horarios;
  return a;
}

function roteiro({ dias, backups = [], destinos = null }) {
  return {
    estimated_cost_brl: 1000,
    cost_breakdown: { activities_and_tickets: 400, accommodation: 600 },
    destinations: destinos ?? [{
      city: 'Lisboa',
      itinerary: dias.map((activities, i) => ({ day: i + 1, activities })),
      backup_activities: backups,
    }],
  };
}

const atividadesDoDia = (r, n = 0) => r.destinations[0].itinerary[n].activities;

// =====================================================================
// ENTRADA E CALENDÁRIO
// =====================================================================

test('a entrada exige roteiro e data de calendário de verdade', () => {
  assert.equal(limparEntrada({ trip_id: 3, data_inicio: '2026-02-30' }), null);
  assert.equal(limparEntrada({ trip_id: 3, data_inicio: '21/12/2026' }), null);
  assert.equal(limparEntrada({ trip_id: 0, data_inicio: SEGUNDA }), null);
  assert.deepEqual(limparEntrada({ trip_id: '7', data_inicio: SEGUNDA }), {
    tripId: 7, dataInicio: SEGUNDA, idioma: 'pt',
  });
});

test('a data do dia atravessa mês e ano', () => {
  assert.equal(dataDoDia('2026-12-30', 1), '2026-12-30');
  assert.equal(dataDoDia('2026-12-30', 3), '2027-01-01');
  assert.equal(diaDaSemanaDe(SEGUNDA), 1);
});

test('o número do dia é a posição, mesmo quando o `day` reinicia por cidade', () => {
  const r = roteiro({
    destinos: [
      { city: 'Lisboa', itinerary: [{ day: 1, activities: [] }, { day: 2, activities: [] }] },
      { city: 'Porto', itinerary: [{ day: 1, activities: [] }] },
    ],
  });
  assert.deepEqual(achatarDias(r).map((d) => [d.destino.city, d.numero]), [
    ['Lisboa', 1], ['Lisboa', 2], ['Porto', 3],
  ]);
});

// =====================================================================
// O CONSERTO, DO MAIS BARATO AO MAIS CARO
// =====================================================================

test('restaurante de almoço no jantar troca de turno com quem cede, sem gastar backup', () => {
  const r = roteiro({
    dias: [[atv('Parque', 'Tarde'), atv('Cantina', 'Noite', todosOsDias('1130', '1500'))]],
    backups: [atv('Reserva', null, todosOsDias('0900', '2300'))],
  });
  const { mudancas, pendentes } = aplicarChecagem(r, { dataInicio: SEGUNDA });

  assert.deepEqual(atividadesDoDia(r).map((a) => [a.place, a.period]), [
    ['Cantina', 'Tarde'], ['Parque', 'Noite'],
  ]);
  assert.equal(mudancas.length, 1);
  assert.equal(mudancas[0].tipo, 'reordenado');
  assert.equal(mudancas[0].motivo, 'fora_do_horario');
  assert.equal(mudancas[0].periodo_novo, 'Tarde');
  assert.equal(mudancas[0].parceira, 'Parque');
  assert.equal(r.destinations[0].backup_activities.length, 1, 'o banco continua cheio');
  assert.equal(pendentes.length, 0);
});

test('museu que fecha às segundas sai para um backup aberto na segunda, e volta ao banco', () => {
  const r = roteiro({
    dias: [[atv('Museu', 'Tarde', fechaAsSegundas(), 'BRL 50 por pessoa')]],
    backups: [
      atv('Galeria', null, fechaAsSegundas()),
      atv('Mercado', null, todosOsDias('0800', '2000'), 'BRL 80 por pessoa'),
    ],
  });
  const { mudancas, deltaCusto } = aplicarChecagem(r, { dataInicio: SEGUNDA });

  assert.equal(atividadesDoDia(r)[0].place, 'Mercado', 'a Galeria também fecha na segunda');
  assert.equal(atividadesDoDia(r)[0].period, 'Tarde', 'o período é do slot');
  assert.equal(mudancas[0].tipo, 'backup');
  assert.equal(mudancas[0].motivo, 'fechado_no_dia');
  assert.equal(mudancas[0].lugar, 'Museu');
  assert.equal(mudancas[0].lugar_novo, 'Mercado');
  assert.equal(mudancas[0].data, SEGUNDA);
  assert.equal(deltaCusto, 30);

  const banco = r.destinations[0].backup_activities.map((b) => b.place);
  assert.deepEqual(banco, ['Galeria', 'Museu'], 'o museu serve em outro dia');
  assert.ok(!('period' in r.destinations[0].backup_activities[1]));
});

test('backup confirmado aberto vem antes de backup sem horário', () => {
  const r = roteiro({
    dias: [[atv('Museu', 'Tarde', fechaAsSegundas())]],
    backups: [atv('Praça', null), atv('Mercado', null, todosOsDias('0800', '2000'))],
  });
  aplicarChecagem(r, { dataInicio: SEGUNDA });
  assert.equal(atividadesDoDia(r)[0].place, 'Mercado');
});

test('sem backup que sirva, vira pendente para o Pro, até o teto; depois, aviso', () => {
  const museus = Array.from({ length: MAX_TROCAS_PELA_IA + 1 }, (_, i) =>
    atv(`Museu ${i}`, 'Tarde', fechaAsSegundas()));
  const r = roteiro({ dias: [museus] });
  const { mudancas, pendentes } = aplicarChecagem(r, { dataInicio: SEGUNDA });

  assert.equal(pendentes.length, MAX_TROCAS_PELA_IA);
  assert.equal(pendentes[0].diaDaSemana, 1);
  assert.ok(!pendentes.some((p) => p.atividade.hours_mismatch), 'pendente ainda não é aviso');
  assert.equal(mudancas.length, 1);
  assert.equal(mudancas[0].tipo, 'aviso');
  assert.equal(atividadesDoDia(r)[MAX_TROCAS_PELA_IA].hours_mismatch, true);
});

test('o feriado fecha o lugar, e o backup também precisa abrir no feriado', () => {
  const natal = '2026-12-25';
  const r = roteiro({
    dias: [[atv('Museu', 'Manhã', todosOsDias('1000', '1800'))]],
    backups: [
      atv('Palácio', null, todosOsDias('1000', '1800')),
      atv('Miradouro', null),
    ],
  });
  marcarLugares(r);
  const fechaNoNatal = new Set(['a1', 'b1']);
  const feriadoDe = (obj, data) =>
    data === natal && fechaNoNatal.has(obj[MARCA]) ? 'Natal' : null;

  const { mudancas } = aplicarChecagem(r, { dataInicio: natal, feriadoDe });
  assert.equal(atividadesDoDia(r)[0].place, 'Miradouro');
  assert.equal(mudancas[0].motivo, 'feriado');
  assert.equal(mudancas[0].feriado, 'Natal');
});

test('sem consertar, só marca o aviso: é a versão do "Desfazer"', () => {
  const r = roteiro({
    dias: [[atv('Parque', 'Tarde'), atv('Museu', 'Tarde', fechaAsSegundas())]],
    backups: [atv('Mercado', null, todosOsDias('0800', '2000'))],
  });
  const { mudancas, pendentes } = aplicarChecagem(r, { dataInicio: SEGUNDA, consertar: false });
  assert.deepEqual(atividadesDoDia(r).map((a) => a.place), ['Parque', 'Museu']);
  assert.equal(atividadesDoDia(r)[1].hours_mismatch, true);
  assert.equal(r.destinations[0].backup_activities.length, 1);
  assert.equal(mudancas.length + pendentes.length, 0);
});

test('o aviso antigo, de outra data, é recalculado do zero', () => {
  const museu = atv('Museu', 'Tarde', fechaAsSegundas());
  museu.hours_mismatch = true;
  const r = roteiro({ dias: [[museu]] });
  // Terça: o museu abre.
  const { mudancas } = aplicarChecagem(r, { dataInicio: '2026-12-22' });
  assert.ok(!('hours_mismatch' in atividadesDoDia(r)[0]));
  assert.equal(mudancas.length, 0);
});

test('lugar sem horário guardado nunca conta como fechado', () => {
  const r = roteiro({ dias: [[atv('Praia', 'Manhã')]] });
  const { mudancas, pendentes } = aplicarChecagem(r, { dataInicio: SEGUNDA });
  assert.equal(mudancas.length + pendentes.length, 0);
});

test('quem entra no slot não herda a marca de reservado de quem saiu', () => {
  const museu = atv('Museu', 'Tarde', fechaAsSegundas());
  museu.reserved = true;
  const r = roteiro({
    dias: [[museu]],
    backups: [atv('Mercado', null, todosOsDias('0800', '2000'))],
  });
  aplicarChecagem(r, { dataInicio: SEGUNDA });
  assert.ok(!('reserved' in atividadesDoDia(r)[0]));
  assert.ok(!('reserved' in r.destinations[0].backup_activities[0]));
});

// =====================================================================
// O QUE VEM DO PRO
// =====================================================================

test('a troca do Pro entra no slot, e quem saiu volta ao banco', () => {
  const r = roteiro({ dias: [[atv('Museu', 'Tarde', fechaAsSegundas(), 'BRL 50 por pessoa')]] });
  const { pendentes } = aplicarChecagem(r, { dataInicio: SEGUNDA });
  const nova = { place: 'Oceanário', cost_estimate: 'BRL 90 por pessoa', maps_search_query: 'Oceanário, Lisboa, Portugal' };

  const { mudanca, deltaCusto } = aplicarTrocaDaIa(pendentes[0], nova);
  assert.equal(atividadesDoDia(r)[0].place, 'Oceanário');
  assert.equal(atividadesDoDia(r)[0].period, 'Tarde');
  assert.equal(mudanca.tipo, 'ia');
  assert.equal(mudanca.lugar_novo, 'Oceanário');
  assert.ok(!('atividade' in mudanca), 'a mudança não carrega o objeto');
  assert.equal(deltaCusto, 40);
  assert.equal(r.destinations[0].backup_activities[0].place, 'Museu');
});

test('sem troca do Pro, a pendente vira aviso', () => {
  const r = roteiro({ dias: [[atv('Museu', 'Tarde', fechaAsSegundas())]] });
  const { pendentes } = aplicarChecagem(r, { dataInicio: SEGUNDA });
  const m = marcarAviso(pendentes[0]);
  assert.equal(m.tipo, 'aviso');
  assert.equal(atividadesDoDia(r)[0].hours_mismatch, true);
});

test('o pedido ao Pro diz por que e quando', () => {
  const p = {
    lugar: 'Museu', motivo: 'feriado', feriado: 'Natal',
    diaDaSemana: 5, data: '2026-12-25', periodo: 'Manhã',
  };
  const texto = pedidoParaIa(p, 'pt');
  assert.match(texto, /Substituto para Museu, que fecha no feriado \(Natal\)/);
  assert.match(texto, /sexta-feira, 2026-12-25, no período Manhã/);
  assert.match(pedidoParaIa({ ...p, motivo: 'fechado_no_dia', feriado: null }, 'pt'),
    /não abre nesse dia da semana/);
});

test('o Pro não repete nada do roteiro nem do banco', () => {
  const r = roteiro({
    dias: [[atv('Museu', 'Tarde')]],
    backups: [atv('Mercado', null), atv('Museu', null)],
  });
  assert.deepEqual(lugaresParaEvitar(r), ['Museu', 'Mercado']);
});

// =====================================================================
// CUSTO E MARCAS
// =====================================================================

test('o custo ajusta o total e a linha de atividades', () => {
  const r = roteiro({ dias: [[]] });
  ajustarCusto(r, 30);
  assert.equal(r.estimated_cost_brl, 1030);
  assert.equal(r.cost_breakdown.activities_and_tickets, 430);
  assert.equal(r.cost_breakdown.accommodation, 600);
});

test('a marca do Flash sai de tudo, inclusive do que mudou de lista', () => {
  const r = roteiro({
    dias: [[atv('Museu', 'Tarde', fechaAsSegundas())]],
    backups: [atv('Mercado', null, todosOsDias('0800', '2000'))],
  });
  marcarLugares(r);
  aplicarChecagem(r, { dataInicio: SEGUNDA });
  desmarcarLugares(r);
  assert.ok(!JSON.stringify(r).includes(MARCA));
});
