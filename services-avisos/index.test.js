// Os caminhos do handler, com o banco e o Firebase trocados por
// respostas prontas, roteadas pela URL.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const ambiente = {
  AVISOS_WEBHOOK_SECRET: 'segredo',
  SUPABASE_URL: 'https://projeto.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  FIREBASE_PROJECT_ID: 'trix',
};

const { enviarAvisos } = require('./index');

let chamadas;
let banco;
const fetchOriginal = global.fetch;

function resposta(status, corpo) {
  return { ok: status >= 200 && status < 300, status, json: async () => corpo, text: async () => '' };
}

beforeEach(() => {
  Object.assign(process.env, ambiente);
  chamadas = [];
  banco = {
    trips: [{ id: 42, title: 'Lisboa e Porto', user_id: 'dono', status: 'ready' }],
    membros: [{ trip_id: 42, user_id: 'dono' }, { trip_id: 42, user_id: 'novo' }],
    usuarios: [{ first_name: 'Ana Souza' }],
    aparelhos: [{ token: 't-dono', plataforma: 'ios', idioma: 'pt' }],
    jaEnviados: new Set(),
    fcm: () => resposta(200, {}),
  };
  global.fetch = async (url, opcoes = {}) => {
    const u = String(url);
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    chamadas.push({ url: u, metodo: opcoes.method ?? 'GET', corpo });
    if (u.includes('metadata.google.internal')) return resposta(200, { access_token: 'a', expires_in: 3600 });
    if (u.includes('fcm.googleapis.com')) return banco.fcm(corpo);
    if (u.includes('/rest/v1/trips')) return resposta(200, banco.trips);
    if (u.includes('/rest/v1/trip_members')) return resposta(200, banco.membros);
    if (u.includes('/rest/v1/users')) return resposta(200, banco.usuarios);
    if (u.includes('/rest/v1/aparelhos_de_notificacao')) return resposta(200, banco.aparelhos);
    if (u.includes('/rest/v1/avisos_enviados')) {
      const novos = corpo.filter((l) => !banco.jaEnviados.has(l.chave));
      novos.forEach((l) => banco.jaEnviados.add(l.chave));
      return resposta(201, novos);
    }
    return resposta(500, { error: `sem resposta para ${u}` });
  };
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

function chamar(corpo, segredo = 'segredo') {
  return new Promise((resolve) => {
    const res = {
      code: 0,
      status(c) { this.code = c; return this; },
      json(b) { resolve({ status: this.code, corpo: b }); },
    };
    enviarAvisos({ method: 'POST', headers: { 'x-webhook-secret': segredo }, body: corpo }, res);
  });
}

const entrada = {
  type: 'INSERT', table: 'trip_members',
  record: { id: 'm9', trip_id: 42, user_id: 'novo', role: 'viewer' },
};

const enviosAoFirebase = () => chamadas.filter((c) => c.url.includes('fcm.googleapis.com'));

test('segredo errado não toca em nada', async () => {
  const r = await chamar(entrada, 'outro');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(chamadas.length, 0);
});

test('alguém entrou: o dono recebe, com o nome de quem entrou', async () => {
  const r = await chamar(entrada);
  assert.strictEqual(r.status, 200);
  const registro = chamadas.find((c) => c.url.includes('avisos_enviados'));
  assert.deepStrictEqual(registro.corpo.map((l) => l.user_id), ['dono']);
  const [envio] = enviosAoFirebase();
  assert.strictEqual(envio.corpo.message.notification.title, 'Ana entrou no seu roteiro');
  assert.strictEqual(envio.corpo.message.data.trip_id, '42');
});

test('o mesmo gatilho duas vezes manda uma vez só', async () => {
  await chamar(entrada);
  await chamar(entrada);
  assert.strictEqual(enviosAoFirebase().length, 1);
});

test('o dono entrando ao criar não avisa ninguém', async () => {
  const r = await chamar({ ...entrada, record: { ...entrada.record, role: 'owner' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(chamadas.length, 0);
});

test('véspera: avisa todo mundo do roteiro uma vez por dia de rodada', async () => {
  banco.aparelhos = [
    { token: 't-dono', plataforma: 'ios', idioma: 'pt' },
    { token: 't-novo', plataforma: 'android', idioma: 'en' },
  ];
  const r = await chamar({ modo: 'vespera' });
  assert.strictEqual(r.status, 200);
  const consulta = chamadas.find((c) => c.url.includes('/rest/v1/trips'));
  assert.match(consulta.url, /is_date_set=is\.true/);
  assert.match(consulta.url, /status=eq\.ready/);
  const titulos = enviosAoFirebase().map((e) => e.corpo.message.notification.title).sort();
  assert.deepStrictEqual(titulos, ['Sua viagem começa amanhã', 'Your trip starts tomorrow']);
  await chamar({ modo: 'vespera' });
  assert.strictEqual(enviosAoFirebase().length, 2);
});

test('token morto sai da tabela', async () => {
  banco.fcm = () => resposta(404, {});
  await chamar(entrada);
  const apagou = chamadas.find((c) => c.metodo === 'DELETE');
  assert.match(apagou.url, /aparelhos_de_notificacao\?token=eq\.t-dono/);
});

test('banco fora responde 500', async () => {
  global.fetch = async () => resposta(503, {});
  const r = await chamar(entrada);
  assert.strictEqual(r.status, 500);
});
