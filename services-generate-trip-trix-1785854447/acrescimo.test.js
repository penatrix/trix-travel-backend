// O refazer que só acrescenta (13/10): quando vale, o que o modelo
// recebe, e o que nunca pode acontecer -- repetir lugar ou mexer nos
// dias que já existem.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chave,
  planoDoAcrescimo,
  montarPromptDoAcrescimo,
  semRepeticao,
  roteiroDasPecas,
  aplicarAcrescimo,
  MARCA_DO_SCHEMA,
} = require('./acrescimo');
const { montarPromptDaGeracao } = require('./prompt-da-geracao');

const atividade = (place, extra = {}) => ({
  place,
  period: 'Manhã',
  cost_estimate: 'BRL 50 no total',
  maps_search_query: `${place}, Cidade`,
  ...extra,
});

/// Lisboa (2 dias) e Porto (2 dias), com uma marca de Reservado.
function roteiroDeHoje() {
  return {
    trip_title: 'Lisboa e Porto',
    estimated_cost_brl: 5000,
    cost_breakdown: {
      flights: 2000,
      accommodation: 1600,
      activities_and_tickets: 600,
      food_not_listed: 500,
      local_transport: 300,
    },
    concierge: { quick_facts: [{ city_name: 'Lisboa' }, { city_name: 'Porto' }], checklist: { items: [] } },
    destinations: [
      {
        city: 'Lisboa',
        accommodation: { name: 'Hotel Lisboa' },
        itinerary: [
          { day: 1, activities: [atividade('Castelo de São Jorge', { booking_required: true, reserved: true })] },
          { day: 2, activities: [atividade('Belém')] },
        ],
        backup_activities: [atividade('Alfama')],
      },
      {
        city: 'Porto',
        accommodation: { name: 'Hotel Porto' },
        itinerary: [
          { day: 3, activities: [atividade('Ribeira')] },
          { day: 4, activities: [atividade('Livraria Lello')] },
        ],
        backup_activities: [],
      },
    ],
  };
}

const pedido = (cidades, extra = {}) => ({ origem: 'Recife, PE, Brasil', nota: '', cidades, ...extra });

test('chave ignora acento, caixa e pontuação', () => {
  assert.equal(chave('Castelo de São Jorge'), chave('castelo de sao jorge!'));
});

test('mais dias numa cidade do meio vira uma peça, com o número final do dia', () => {
  const plano = planoDoAcrescimo(roteiroDeHoje(), 'Recife, PE, Brasil', pedido([
    { destination: 'Lisboa, Portugal', days: 4 },
    { destination: 'Porto, Portugal', days: 2 },
  ]));
  assert.deepEqual(plano.pecas, [
    { tipo: 'estender', indice: 0, cidade: 'Lisboa', diasHoje: 2, diasNovos: 2, primeiroDia: 3 },
  ]);
});

test('cidade nova no fim vira uma peça nova, chegando da última', () => {
  const plano = planoDoAcrescimo(roteiroDeHoje(), 'Recife, PE, Brasil', pedido([
    { destination: 'Lisboa, Portugal', days: 2 },
    { destination: 'Porto, Portugal', days: 2 },
    { destination: 'Coimbra, Portugal', days: 2 },
  ]));
  assert.deepEqual(plano.pecas, [
    { tipo: 'nova', destination: 'Coimbra, Portugal', dias: 2, primeiroDia: 5, vemDe: 'Porto' },
  ]);
});

test('o que não é só acréscimo refaz tudo', () => {
  const r = roteiroDeHoje();
  const base = [
    { destination: 'Lisboa, Portugal', days: 3 },
    { destination: 'Porto, Portugal', days: 2 },
  ];
  // nota vale para o roteiro todo
  assert.equal(planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido(base, { nota: 'sem museus' })), null);
  // origem trocada
  assert.equal(planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido(base, { origem: 'Natal, RN, Brasil' })), null);
  // menos dias
  assert.equal(planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido([
    { destination: 'Lisboa, Portugal', days: 1 },
    { destination: 'Porto, Portugal', days: 2 },
  ])), null);
  // cidade trocada
  assert.equal(planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido([
    { destination: 'Sintra, Portugal', days: 2 },
    { destination: 'Porto, Portugal', days: 2 },
  ])), null);
  // cidade removida
  assert.equal(planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido([
    { destination: 'Lisboa, Portugal', days: 4 },
  ])), null);
  // nada mudou
  assert.equal(planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido([
    { destination: 'Lisboa, Portugal', days: 2 },
    { destination: 'Porto, Portugal', days: 2 },
  ])), null);
});

test('o prompt leva o que existe, o que nunca repetir e só o schema das peças', () => {
  const r = roteiroDeHoje();
  const plano = planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido([
    { destination: 'Lisboa, Portugal', days: 4 },
    { destination: 'Porto, Portugal', days: 2 },
    { destination: 'Coimbra, Portugal', days: 2 },
  ]));
  const linha = {
    user_language: 'pt',
    start_date: '2026-11-01',
    end_date: '2026-11-08',
    travelers_count: 2,
    planned_destinations: [
      { destination: 'Lisboa, Portugal', days: 4 },
      { destination: 'Porto, Portugal', days: 2 },
      { destination: 'Coimbra, Portugal', days: 2 },
    ],
  };
  const geracao = montarPromptDaGeracao(linha, null);
  assert.ok(geracao.includes(MARCA_DO_SCHEMA));
  const p = montarPromptDoAcrescimo(geracao, plano, r, { pt: true, travelers: 2 });
  assert.ok(p.includes('EXTENSION OF AN ITINERARY THAT ALREADY EXISTS'));
  for (const lugar of ['Castelo de São Jorge', 'Belém', 'Alfama', 'Ribeira', 'Livraria Lello', 'Hotel Lisboa']) {
    assert.ok(p.includes(lugar), `falta ${lugar} na lista do que nunca repetir`);
  }
  assert.ok(p.includes('numbered days 3 to 4'));
  assert.ok(p.includes('Coimbra, Portugal: a NEW city'));
  assert.ok(p.includes('EXACTLY 2 entries'));
  // O schema da geração inteira saiu: o modelo não reescreve o roteiro.
  assert.ok(!p.includes('"trip_title": "Creative'));
});

test('lugar repetido vira backup novo no mesmo período, ou sai', () => {
  const pecas = [{
    city: 'Lisboa',
    itinerary: [
      { activities: [
        atividade('Castelo de Sao Jorge', { period: 'Tarde' }),
        atividade('LX Factory'),
        atividade('lx factory'),
      ] },
    ],
    backup_activities: [atividade('Alfama'), atividade('Oceanário')],
  }];
  const r = semRepeticao(pecas, roteiroDeHoje());
  const dia = pecas[0].itinerary[0].activities;
  assert.deepEqual(dia.map((a) => a.place), ['Oceanário', 'LX Factory']);
  assert.equal(dia[0].period, 'Tarde');
  assert.deepEqual(r, { trocadas: 1, removidas: 1 });
  // O backup que repetia o roteiro (Alfama) também saiu, e o usado não fica como backup.
  assert.deepEqual(pecas[0].backup_activities, []);
});

test('aplicar: os dias de hoje ficam intactos, os novos entram e tudo é renumerado', () => {
  const r = roteiroDeHoje();
  const plano = planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido([
    { destination: 'Lisboa, Portugal', days: 3 },
    { destination: 'Porto, Portugal', days: 2 },
    { destination: 'Coimbra, Portugal', days: 1 },
  ]));
  const resposta = {
    added_cost: { accommodation: 400, activities_and_tickets: 100, food_not_listed: 80, local_transport: 60 },
    quick_facts: [{ city_name: 'Coimbra' }],
    pieces: [
      { city: 'Lisboa', itinerary: [{ day: 9, activities: [atividade('LX Factory')] }], backup_activities: [atividade('Oceanário')] },
      { city: 'Coimbra', accommodation: { name: 'Hotel Coimbra' }, itinerary: [{ day: 1, activities: [atividade('Universidade')] }], backup_activities: [] },
    ],
  };
  roteiroDasPecas(resposta.pieces, plano);
  assert.equal(resposta.pieces[0].itinerary[0].day, 3);
  assert.equal(resposta.pieces[1].itinerary[0].day, 6);

  const novo = aplicarAcrescimo(r, plano, resposta);
  assert.deepEqual(
    novo.destinations.map((d) => [d.city, d.itinerary.map((x) => x.day)]),
    [['Lisboa', [1, 2, 3]], ['Porto', [4, 5]], ['Coimbra', [6]]],
  );
  assert.equal(novo.destinations[0].days, 3);
  assert.equal(novo.destinations[2].days, 1);
  // A marca de Reservado do dia 1 continua.
  assert.equal(novo.destinations[0].itinerary[0].activities[0].reserved, true);
  assert.deepEqual(novo.destinations[0].backup_activities.map((b) => b.place), ['Alfama', 'Oceanário']);
  // O custo soma só o acrescentado; a passagem não muda.
  assert.equal(novo.estimated_cost_brl, 5640);
  assert.equal(novo.cost_breakdown.flights, 2000);
  assert.equal(novo.cost_breakdown.accommodation, 2000);
  assert.deepEqual(novo.concierge.quick_facts.map((f) => f.city_name), ['Lisboa', 'Porto', 'Coimbra']);
  assert.equal(novo.trip_title, 'Lisboa e Porto');
  // O roteiro de hoje não foi tocado.
  assert.equal(r.destinations[0].itinerary.length, 2);
});

test('resposta com peça a menos é falha, e o roteiro fica como estava', () => {
  const r = roteiroDeHoje();
  const plano = planoDoAcrescimo(r, 'Recife, PE, Brasil', pedido([
    { destination: 'Lisboa, Portugal', days: 3 },
    { destination: 'Porto, Portugal', days: 3 },
  ]));
  assert.throws(() => aplicarAcrescimo(r, plano, { pieces: [{}] }), /1 peça\(s\); eram 2/);
});
