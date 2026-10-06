// Os caminhos do handler, com a rede trocada por respostas prontas.
//
// O que se trava aqui é a ordem das coisas e o que acontece em cada
// falha: sem conta não lê o roteiro; roteiro de outra pessoa não chama o
// Gemini; quem passou do limite não chama o Gemini; e a resposta do
// modelo chega conferida.

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
});

const { conversarComConcierge } = require('./index');

const ROTEIRO = {
  user_id: ANA,
  title: 'Lisboa',
  is_date_set: false,
  itinerary_json: { trip_title: 'Lisboa', destinations: [] },
};

let chamadas;
let respostas;
const fetchOriginal = global.fetch;

beforeEach(() => {
  chamadas = [];
  respostas = [];
  global.fetch = async (url, opcoes = {}) => {
    chamadas.push({ url: String(url), metodo: opcoes.method ?? 'GET', corpo: opcoes.body });
    const { status = 200, corpo = {}, cabecalhos = {} } = respostas.shift() ?? { status: 500 };
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n) => cabecalhos[n.toLowerCase()] ?? null },
      json: async () => corpo,
      text: async () => JSON.stringify(corpo),
    };
  };
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

function pedido(corpo, { anonimo = false, semToken = false } = {}) {
  const token = jwt.sign(
    { sub: ANA, role: 'authenticated', is_anonymous: anonimo },
    SEGREDO_JWT,
    { algorithm: 'HS256' },
  );
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

const doGemini = (texto) => ({
  corpo: {
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: texto }] } }],
    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 80, thoughtsTokenCount: 400 },
  },
});

const pergunta = { trip_id: 42, mensagem: 'Como chego à Torre de Belém?' };

test('sem token, 401, e nada é lido', async () => {
  const r = resposta();
  await conversarComConcierge(pedido(pergunta, { semToken: true }), r);
  assert.equal(r.codigo, 401);
  assert.equal(chamadas.length, 0);
});

test('sessão anônima não tem concierge', async () => {
  const r = resposta();
  await conversarComConcierge(pedido(pergunta, { anonimo: true }), r);
  assert.equal(r.codigo, 401);
});

test('pergunta vazia, 400, e nada é lido', async () => {
  const r = resposta();
  await conversarComConcierge(pedido({ trip_id: 42, mensagem: ' ' }), r);
  assert.equal(r.codigo, 400);
  assert.equal(chamadas.length, 0);
});

test('roteiro de outra pessoa: 403, e o Gemini não é chamado', async () => {
  respostas.push({ corpo: [{ ...ROTEIRO, user_id: 'outra-pessoa' }] });
  respostas.push({ corpo: [] }); // não é membro
  const r = resposta();
  await conversarComConcierge(pedido(pergunta), r);
  assert.equal(r.codigo, 403);
  assert.ok(!chamadas.some((c) => c.url.includes('generativelanguage')));
  assert.match(chamadas[1].url, /trip_members\?trip_id=eq\.42&user_id=eq\./);
});

test('o membro do roteiro conversa', async () => {
  respostas.push({ corpo: [{ ...ROTEIRO, user_id: 'dono' }] });
  respostas.push({ corpo: [{ id: 9 }] });
  respostas.push({ cabecalhos: { 'content-range': '*/0' } });
  respostas.push(doGemini('Pegue o 15E na Praça da Figueira.'));
  respostas.push({ status: 201 }); // evento
  const r = resposta();
  await conversarComConcierge(pedido(pergunta), r);
  assert.equal(r.codigo, 200);
  assert.equal(r.corpo.resposta, 'Pegue o 15E na Praça da Figueira.');
});

test('no limite diário: 429 com a frase pronta, e o Gemini não é chamado', async () => {
  respostas.push({ corpo: [ROTEIRO] });
  respostas.push({ cabecalhos: { 'content-range': '0-0/30' } });
  const r = resposta();
  await conversarComConcierge(pedido(pergunta), r);
  assert.equal(r.codigo, 429);
  assert.match(r.corpo.mensagem, /30 perguntas em 24 horas/);
  assert.ok(!chamadas.some((c) => c.url.includes('generativelanguage')));
  assert.match(chamadas[1].url, /eventos\?tipo=eq\.concierge&status=eq\.ok/);
});

test('o caminho feliz: thinking e teto declarados, resposta conferida, custo gravado', async () => {
  respostas.push({ corpo: [ROTEIRO] });
  respostas.push({ cabecalhos: { 'content-range': '0-0/3' } });
  respostas.push(doGemini('Fica em 38.6916, -9.2160. Vá de trem desde o Cais do Sodré.'));
  respostas.push({ status: 201 });
  const r = resposta();
  await conversarComConcierge(
    pedido({ ...pergunta, historico: [{ papel: 'trix', texto: 'Olá' }] }),
    r,
  );
  assert.equal(r.codigo, 200);
  assert.ok(!/38\.6916/.test(r.corpo.resposta), 'coordenada apagada');

  const gemini = chamadas.find((c) => c.url.includes('generativelanguage'));
  const corpo = JSON.parse(gemini.corpo);
  assert.equal(corpo.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  assert.ok(corpo.generationConfig.maxOutputTokens >= 4096,
    'o pensamento conta dentro do teto de saída');
  assert.match(corpo.systemInstruction.parts[0].text, /ROTEIRO:/);
  assert.deepEqual(corpo.contents.map((t) => t.role), ['model', 'user']);

  // O registro é efeito colateral sem await: dá uma volta no laço.
  await new Promise((ok) => setImmediate(ok));
  const evento = chamadas.find((c) => c.url.endsWith('/rest/v1/eventos'));
  assert.ok(evento, 'a linha de custo foi gravada');
  const linha = JSON.parse(evento.corpo);
  assert.equal(linha.tipo, 'concierge');
  assert.equal(linha.trip_id, 42);
  assert.equal(linha.tokens_saida, 480, 'o pensamento conta como saída');
});

test('Gemini truncado: 500, e o erro é registrado', async () => {
  respostas.push({ corpo: [ROTEIRO] });
  respostas.push({ cabecalhos: { 'content-range': '*/0' } });
  respostas.push({
    corpo: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'meio' }] } }] },
  });
  respostas.push({ status: 201 });
  const r = resposta();
  await conversarComConcierge(pedido(pergunta), r);
  assert.equal(r.codigo, 500);
  await new Promise((ok) => setImmediate(ok));
  const evento = chamadas.find((c) => c.url.endsWith('/rest/v1/eventos'));
  assert.equal(JSON.parse(evento.corpo).status, 'erro');
});

test('contagem do limite fora do ar não tira o concierge de ninguém', async () => {
  respostas.push({ corpo: [ROTEIRO] });
  respostas.push({ status: 503 });
  respostas.push(doGemini('Resposta.'));
  respostas.push({ status: 201 });
  const r = resposta();
  await conversarComConcierge(pedido(pergunta), r);
  assert.equal(r.codigo, 200);
});
