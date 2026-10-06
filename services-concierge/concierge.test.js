// A parte pura do concierge: a entrada com teto, o roteiro que o modelo
// lê, e a resposta conferida. Nenhum teste toca a rede.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  limparEntrada,
  compactarRoteiro,
  montarInstrucoes,
  montarConversa,
  conferirResposta,
  mensagemDoLimite,
  MAX_MENSAGEM,
  MAX_TROCAS,
  MAX_DESCRICAO,
  LIMITE_DIARIO,
} = require('./concierge');

const row = (extra = {}) => ({
  user_id: 'ana',
  title: 'Costa do Cacau',
  travelers_count: 2,
  start_date: '2026-10-12',
  end_date: '2026-10-14',
  is_date_set: true,
  itinerary_json: {
    trip_title: 'Refúgio na Costa do Cacau',
    estimated_cost_brl: 1800,
    cost_breakdown: { flights: 0, accommodation: 900 },
    concierge: {
      checklist: { items: [{ item_title: 'Repelente' }, { item_title: '' }] },
      quick_facts: [{ city_name: 'Ilhéus', voltage: '127V' }],
    },
    destinations: [{
      city: 'Ilhéus',
      days: 3,
      itinerary: [{
        day: 1,
        activities: [{
          place: 'Fazenda Yrerê',
          period: 'Manhã',
          place_id: 'ChIJ-segredo',
          cost_estimate: 'BRL 100 por pessoa',
          logistics: 'Agende com 2 dias.',
          description: 'x'.repeat(1000),
          maps_search_query: 'Fazenda Yrerê, Ilhéus, Brazil',
        }],
      }],
    }],
  },
  ...extra,
});

// =====================================================================
// ENTRADA
// =====================================================================

test('pergunta vazia ou sem roteiro não gasta Gemini', () => {
  assert.equal(limparEntrada({ trip_id: 1, mensagem: '   ' }), null);
  assert.equal(limparEntrada({ mensagem: 'oi' }), null);
  assert.equal(limparEntrada({ trip_id: 'abc', mensagem: 'oi' }), null);
  assert.equal(limparEntrada({ trip_id: -3, mensagem: 'oi' }), null);
});

test('a mensagem tem teto', () => {
  const e = limparEntrada({ trip_id: 7, mensagem: 'a'.repeat(5000) });
  assert.equal(e.mensagem.length, MAX_MENSAGEM);
  assert.equal(e.tripId, 7);
  assert.equal(e.lang, 'pt');
});

test('o histórico fica com as ÚLTIMAS trocas, e só com papéis conhecidos', () => {
  const historico = Array.from({ length: 25 }, (_, i) => ({
    papel: i % 2 ? 'trix' : 'qualquer-coisa',
    texto: `troca ${i}`,
  }));
  historico.push({ papel: 'trix', texto: '   ' });
  const e = limparEntrada({ trip_id: 7, mensagem: 'e agora?', historico });
  assert.equal(e.historico.length, MAX_TROCAS);
  assert.equal(e.historico.at(-1).texto, 'troca 24');
  assert.ok(e.historico.every((t) => ['usuario', 'trix'].includes(t.papel)));
});

test('histórico que não é lista vira vazio', () => {
  assert.deepEqual(limparEntrada({ trip_id: 7, mensagem: 'oi', historico: 'x' }).historico, []);
});

// =====================================================================
// O ROTEIRO QUE O MODELO LÊ
// =====================================================================

test('o roteiro compacto tem o que uma resposta concreta cita', () => {
  const r = compactarRoteiro(row());
  assert.equal(r.titulo, 'Refúgio na Costa do Cacau');
  assert.equal(r.viajantes, 2);
  assert.deepEqual(r.datas, { inicio: '2026-10-12', fim: '2026-10-14' });
  const a = r.destinos[0].dia_a_dia[0].atividades[0];
  assert.equal(a.lugar, 'Fazenda Yrerê');
  assert.equal(a.custo, 'BRL 100 por pessoa');
  assert.equal(a.busca_no_maps, 'Fazenda Yrerê, Ilhéus, Brazil');
  assert.equal(a.descricao.length, MAX_DESCRICAO);
  assert.deepEqual(r.checklist, ['Repelente']);
  assert.equal(r.dados_das_cidades[0].voltage, '127V');
});

test('o que é dado de máquina não vai ao modelo', () => {
  assert.ok(!JSON.stringify(compactarRoteiro(row())).includes('ChIJ-segredo'));
});

test('data não escolhida não vai: start_date sem is_date_set é chute', () => {
  assert.equal(compactarRoteiro(row({ is_date_set: false })).datas, null);
});

test('itinerary_json em texto também é lido; lixo devolve null', () => {
  const comoTexto = row({ itinerary_json: JSON.stringify(row().itinerary_json) });
  assert.equal(compactarRoteiro(comoTexto).titulo, 'Refúgio na Costa do Cacau');
  assert.equal(compactarRoteiro(row({ itinerary_json: '{quebrado' })), null);
  assert.equal(compactarRoteiro(row({ itinerary_json: null })), null);
});

// =====================================================================
// AS INSTRUÇÕES
// =====================================================================

test('as regras da casa estão nas instruções', () => {
  const p = montarInstrucoes(compactarRoteiro(row()));
  assert.match(p, /NUNCA escreva coordenadas/);
  assert.match(p, /horário de funcionamento que não esteja no roteiro/);
  assert.match(p, /por pessoa ou total/);
  assert.match(p, /Novo roteiro/);
  assert.match(p, /"a Trix", nunca "o Trix"/);
  assert.match(p, /não agência de viagens/);
  assert.match(p, /português do Brasil/);
  assert.match(p, /Fazenda Yrerê/);
});

test('em inglês, a instrução de idioma muda', () => {
  assert.match(montarInstrucoes({}, 'en'), /Answer in English/);
});

test('a conversa termina na pergunta, com os papéis do Gemini', () => {
  const c = montarConversa(
    [{ papel: 'usuario', texto: 'oi' }, { papel: 'trix', texto: 'olá' }],
    'quanto custa o dia 1?',
  );
  assert.deepEqual(c.map((t) => t.role), ['user', 'model', 'user']);
  assert.equal(c.at(-1).parts[0].text, 'quanto custa o dia 1?');
});

// =====================================================================
// A RESPOSTA
// =====================================================================

test('coordenada que escape é apagada', () => {
  const r = conferirResposta('A fazenda fica em -14.7935, -39.0464, a 20 min do centro.');
  assert.ok(!/-14\.7935/.test(r));
  assert.match(r, /a 20 min do centro/);
});

test('preço e endereço não são confundidos com coordenada', () => {
  const r = conferirResposta('São R$ 1.250,00 no total, na Rua 15, 230.');
  assert.equal(r, 'São R$ 1.250,00 no total, na Rua 15, 230.');
});

test('resposta vazia vira null', () => {
  assert.equal(conferirResposta('   '), null);
  assert.equal(conferirResposta(undefined), null);
});

test('o aviso do limite diz o número', () => {
  assert.match(mensagemDoLimite('pt'), new RegExp(`${LIMITE_DIARIO} perguntas em 24 horas`));
});
