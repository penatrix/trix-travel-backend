// Os caminhos do handler, com a rede trocada por um dublê que responde
// pela URL: banco, Nager, Gemini (Flash e Pro) e Google.
//
// O que se trava aqui é a ordem e o que acontece em cada falha: sem
// conta não lê nada; roteiro de outra pessoa não gasta modelo; horário
// guardado não vai ao Google; Flash fora não derruba a checagem; e a
// resposta leva as duas versões do roteiro, sem a marca interna.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

const SEGREDO_JWT = 'segredo-de-teste';
const ANA = '11111111-2222-3333-4444-555555555555';

Object.assign(process.env, {
  SUPABASE_JWT_SECRET: SEGREDO_JWT,
  SUPABASE_URL: 'https://projeto.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  GEMINI_API_KEY: 'chave',
  GOOGLE_MAPS_KEY: 'chave-maps',
});

const { checarDatas } = require('./index');

/// Fecha às segundas (day 1); nos outros dias, das 10h às 18h.
const fechaAsSegundas = [0, 2, 3, 4, 5, 6].map((d) => ({
  open: { day: d, time: '1000' }, close: { day: d, time: '1800' },
}));
const todosOsDias = [0, 1, 2, 3, 4, 5, 6].map((d) => ({
  open: { day: d, time: '0800' }, close: { day: d, time: '2200' },
}));

// 2026-12-21 é segunda; o dia 5 do roteiro seria o Natal.
const SEGUNDA = '2026-12-21';

function roteiroDeLisboa({ backups = true } = {}) {
  return {
    trip_title: 'Lisboa',
    estimated_cost_brl: 1000,
    destinations: [{
      city: 'Lisboa',
      itinerary: [{
        day: 1,
        activities: [{
          place: 'Museu', period: 'Tarde', cost_estimate: 'BRL 50 por pessoa',
          maps_search_query: 'Museu, Lisboa, Portugal', place_id: 'id:Museu',
          opening_hours_periods: fechaAsSegundas,
        }],
      }],
      backup_activities: backups
        ? [{
            place: 'Mercado', cost_estimate: 'BRL 50 por pessoa',
            maps_search_query: 'Mercado, Lisboa, Portugal', place_id: 'id:Mercado',
            opening_hours_periods: todosOsDias,
          }]
        : [],
    }],
  };
}

let chamadas;
let rotas;
const fetchOriginal = global.fetch;

function json(corpo, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => corpo,
    text: async () => JSON.stringify(corpo),
  };
}

const doGemini = (texto) => json({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: texto }] } }],
  usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 60, thoughtsTokenCount: 200 },
});

beforeEach(() => {
  chamadas = [];
  rotas = {
    trip: () => json([{ user_id: ANA, status: 'ready', itinerary_json: roteiroDeLisboa() }]),
    paises: () => json([{ countryCode: 'PT', name: 'Portugal' }]),
    feriados: () => json([
      { date: '2026-12-25', localName: 'Natal', name: 'Christmas Day', countryCode: 'PT', types: ['Public'] },
    ]),
    flash: () => doGemini('{"holidays":[],"closed":[]}'),
    pro: () => doGemini(JSON.stringify({ suggestions: [
      { place: 'Oceanário', cost_estimate: 'BRL 90 por pessoa', maps_search_query: 'Oceanário, Lisboa, Portugal' },
    ] })),
    textsearch: () => json({ status: 'OK', results: [{ place_id: 'id:Oceanário', name: 'Oceanário', business_status: 'OPERATIONAL' }] }),
    details: () => json({ status: 'OK', result: { opening_hours: { periods: todosOsDias } } }),
    evento: () => json({}, 201),
  };
  global.fetch = async (url, opcoes = {}) => {
    const u = String(url);
    chamadas.push({ url: u, corpo: opcoes.body });
    if (u.includes('/rest/v1/trips')) return rotas.trip();
    if (u.includes('/rest/v1/eventos')) return rotas.evento();
    if (u.includes('AvailableCountries')) return rotas.paises();
    if (u.includes('PublicHolidays')) return rotas.feriados();
    if (u.includes('gemini-3.6-flash')) return rotas.flash();
    if (u.includes('gemini-3.1-pro')) return rotas.pro();
    if (u.includes('/textsearch/')) return rotas.textsearch();
    if (u.includes('/place/details/')) return rotas.details();
    throw new Error(`URL inesperada no teste: ${u}`);
  };
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

function pedido(corpo, { semToken = false, sub = ANA } = {}) {
  const token = jwt.sign({ sub, role: 'authenticated' }, SEGREDO_JWT, { algorithm: 'HS256' });
  return {
    method: 'POST',
    headers: semToken ? {} : { authorization: `Bearer ${token}` },
    body: corpo,
  };
}

function resposta() {
  const r = { codigo: null, corpo: null, set() {}, send() { return r; } };
  r.status = (c) => { r.codigo = c; return r; };
  r.json = (c) => { r.corpo = c; return r; };
  return r;
}

const umaVolta = () => new Promise((ok) => setImmediate(ok));
const deModelo = () => chamadas.filter((c) => c.url.includes('generativelanguage'));
const doGoogle = () => chamadas.filter((c) => c.url.includes('maps.googleapis'));

test('sem token, 401, e nada é lido', async () => {
  const r = resposta();
  await checarDatas(pedido({ trip_id: 1, data_inicio: SEGUNDA }, { semToken: true }), r);
  assert.equal(r.codigo, 401);
  assert.equal(chamadas.length, 0);
});

test('data inválida, 400, e nada é lido', async () => {
  const r = resposta();
  await checarDatas(pedido({ trip_id: 1, data_inicio: '2026-13-01' }), r);
  assert.equal(r.codigo, 400);
  assert.equal(chamadas.length, 0);
});

test('roteiro de outra pessoa: 403, e nenhum modelo é chamado', async () => {
  const r = resposta();
  await checarDatas(pedido({ trip_id: 1, data_inicio: SEGUNDA }, { sub: 'outra-pessoa' }), r);
  assert.equal(r.codigo, 403);
  assert.equal(deModelo().length, 0);
});

test('roteiro sem conteúdo: 409', async () => {
  rotas.trip = () => json([{ user_id: ANA, status: 'ready', itinerary_json: null }]);
  const r = resposta();
  await checarDatas(pedido({ trip_id: 1, data_inicio: SEGUNDA }), r);
  assert.equal(r.codigo, 409);
});

test('o caminho feliz: horário guardado, backup no lugar, as duas versões', async () => {
  const r = resposta();
  await checarDatas(pedido({ trip_id: 9, data_inicio: SEGUNDA }), r);
  assert.equal(r.codigo, 200);

  // O horário estava guardado: o Google não foi chamado.
  assert.equal(doGoogle().length, 0);

  const [m] = r.corpo.mudancas;
  assert.equal(m.tipo, 'backup');
  assert.equal(m.lugar, 'Museu');
  assert.equal(m.lugar_novo, 'Mercado');
  assert.equal(m.motivo, 'fechado_no_dia');

  const consertado = r.corpo.itinerary_json.destinations[0];
  assert.equal(consertado.itinerary[0].activities[0].place, 'Mercado');
  const desfeito = r.corpo.itinerary_json_sem_trocas.destinations[0];
  assert.equal(desfeito.itinerary[0].activities[0].place, 'Museu');
  assert.equal(desfeito.itinerary[0].activities[0].hours_mismatch, true);

  assert.ok(!JSON.stringify(r.corpo).includes('__checagem'), 'a marca interna não sai daqui');
  assert.equal(r.corpo.feriados_conferidos, true);

  // O Flash foi perguntado, com thinking e teto declarados.
  const flash = JSON.parse(deModelo()[0].corpo);
  assert.equal(flash.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.ok(flash.generationConfig.maxOutputTokens > 0);
  assert.match(flash.contents[0].parts[0].text, /a1 Museu \(Tarde\)/);

  await umaVolta();
  const evento = chamadas.find((c) => c.url.endsWith('/rest/v1/eventos'));
  const linha = JSON.parse(evento.corpo);
  assert.equal(linha.tipo, 'checagem_de_datas');
  assert.equal(linha.trip_id, 9);
});

test('roteiro antigo, sem horário guardado: o Google é chamado uma vez e o horário fica', async () => {
  const antigo = roteiroDeLisboa();
  const museu = antigo.destinations[0].itinerary[0].activities[0];
  delete museu.opening_hours_periods;
  delete museu.place_id;
  rotas.trip = () => json([{ user_id: ANA, status: 'ready', itinerary_json: antigo }]);
  rotas.textsearch = () => json({ status: 'OK', results: [{ place_id: 'id:Museu', name: 'Museu', business_status: 'OPERATIONAL' }] });
  rotas.details = () => json({ status: 'OK', result: { opening_hours: { periods: fechaAsSegundas } } });

  const r = resposta();
  await checarDatas(pedido({ trip_id: 9, data_inicio: SEGUNDA }), r);
  assert.equal(r.codigo, 200);
  assert.equal(doGoogle().length, 2, 'uma busca e um horário');
  const noBanco = r.corpo.itinerary_json.destinations[0].backup_activities
    .find((b) => b.place === 'Museu');
  assert.equal(noBanco.place_id, 'id:Museu');
  assert.ok(noBanco.opening_hours_periods, 'o horário fica para a próxima mudança de data');
});

test('feriado sem backup: o Pro troca, sabendo o dia, e a troca é contada à parte', async () => {
  rotas.trip = () => json([{ user_id: ANA, status: 'ready', itinerary_json: roteiroDeLisboa({ backups: false }) }]);
  rotas.flash = () => doGemini(JSON.stringify({
    holidays: [{ date: '2026-12-25', city: 'Lisboa', name: 'Natal' }],
    closed: [{ id: 'a1', date: '2026-12-25' }],
  }));

  const r = resposta();
  // Chegada no Natal, uma sexta: o museu abriria, mas fecha no feriado.
  await checarDatas(pedido({ trip_id: 9, data_inicio: '2026-12-25' }), r);
  assert.equal(r.codigo, 200);

  const [m] = r.corpo.mudancas;
  assert.equal(m.tipo, 'ia');
  assert.equal(m.motivo, 'feriado');
  assert.equal(m.feriado, 'Natal');
  assert.equal(m.lugar_novo, 'Oceanário');
  assert.deepEqual(r.corpo.feriados, [{ data: '2026-12-25', cidade: 'Lisboa', nome: 'Natal' }]);

  const atividade = r.corpo.itinerary_json.destinations[0].itinerary[0].activities[0];
  assert.equal(atividade.place, 'Oceanário');
  assert.equal(atividade.place_id, 'id:Oceanário');

  const pro = JSON.parse(deModelo().find((c) => c.url.includes('gemini-3.1-pro')).corpo);
  assert.equal(pro.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.match(pro.contents[0].parts[0].text, /fecha no feriado \(Natal\)/);
  assert.match(pro.contents[0].parts[0].text, /sexta-feira, 2026-12-25/);

  await umaVolta();
  const tipos = chamadas
    .filter((c) => c.url.endsWith('/rest/v1/eventos'))
    .map((c) => JSON.parse(c.corpo).tipo)
    .sort();
  assert.deepEqual(tipos, ['checagem_de_datas', 'troca_atividade']);
});

test('o Pro só traz quem fecha no mesmo dia: fica o aviso', async () => {
  rotas.trip = () => json([{ user_id: ANA, status: 'ready', itinerary_json: roteiroDeLisboa({ backups: false }) }]);
  rotas.details = () => json({ status: 'OK', result: { opening_hours: { periods: fechaAsSegundas } } });

  const r = resposta();
  await checarDatas(pedido({ trip_id: 9, data_inicio: SEGUNDA }), r);
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.mudancas[0].tipo, 'aviso');
  const atividade = r.corpo.itinerary_json.destinations[0].itinerary[0].activities[0];
  assert.equal(atividade.place, 'Museu');
  assert.equal(atividade.hours_mismatch, true);
});

test('Flash fora do ar não derruba a checagem: o horário é conferido do mesmo jeito', async () => {
  rotas.flash = () => json({ error: 'indisponível' }, 503);
  const r = resposta();
  await checarDatas(pedido({ trip_id: 9, data_inicio: SEGUNDA }), r);
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.feriados_conferidos, false);
  assert.equal(r.corpo.mudancas[0].tipo, 'backup');
});

test('Nager fora do ar: segue, mas sem dizer que os feriados foram conferidos', async () => {
  // A lista de países já ficou guardada na instância pelos testes de
  // cima; o calendário de 2030 não.
  rotas.feriados = () => json({}, 500);
  const r = resposta();
  await checarDatas(pedido({ trip_id: 9, data_inicio: '2030-01-07' }), r);
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.feriados_conferidos, false);
});
