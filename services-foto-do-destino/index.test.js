// O serviço inteiro com banco e Unsplash de mentira.
//
// O que se trava: a cascata grava cada nível que tentou (com foto ou
// sem), lê antes de buscar, não busca de novo o que já sabe, e para de
// buscar quando o limite do Unsplash acaba.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

process.env.SUPABASE_JWT_SECRET = 'segredo';
process.env.SUPABASE_URL = 'https://banco.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.UNSPLASH_ACCESS_KEY = 'chave';

const { fotoDoDestino } = require('./index');

const token = jwt.sign({ role: 'authenticated', sub: 'u1' }, 'segredo');

let banco;
let buscas;
let avisos;
let respostasDoUnsplash;

function fotoDe(id, texto, extra = {}) {
  return {
    id,
    width: 4000,
    height: 2600,
    color: '#7a6a55',
    likes: 1,
    description: texto,
    tags: [],
    urls: { regular: `https://img/${id}`, small: `https://img/${id}-s` },
    links: { html: `https://unsplash.com/photos/${id}`, download_location: `https://api.unsplash.com/photos/${id}/download` },
    user: { name: 'Fotógrafa', links: { html: 'https://unsplash.com/@f' } },
    ...extra,
  };
}

beforeEach(() => {
  banco = new Map();
  buscas = [];
  avisos = [];
  respostasDoUnsplash = {};
  global.fetch = async (url, opcoes = {}) => {
    const u = new URL(url);
    if (u.host === 'banco.test') {
      if ((opcoes.method ?? 'GET') === 'GET') {
        const lista = decodeURIComponent(u.search).match(/in\.\((.*)\)/)[1];
        const chaves = [...lista.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        const linhas = chaves.filter((c) => banco.has(c)).map((c) => banco.get(c));
        return new Response(JSON.stringify(linhas), { status: 200 });
      }
      const linha = JSON.parse(opcoes.body);
      banco.set(linha.chave, linha);
      return new Response('', { status: 201 });
    }
    if (u.pathname === '/search/photos') {
      const consulta = u.searchParams.get('query');
      buscas.push(consulta);
      const r = respostasDoUnsplash[consulta];
      if (r === 'limite') return new Response('', { status: 429 });
      return new Response(JSON.stringify({ results: r ?? [] }), { status: 200 });
    }
    if (u.pathname.endsWith('/download')) {
      avisos.push(u.pathname);
      return new Response('{}', { status: 200 });
    }
    throw new Error(`fetch inesperado: ${url}`);
  };
});

function chamar(corpo, comToken = true) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      set() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, corpo: b }); },
      send(b) { resolve({ status: this.statusCode, corpo: b }); },
    };
    fotoDoDestino({ method: 'POST', headers: comToken ? { authorization: `Bearer ${token}` } : {}, body: corpo }, res);
  });
}

test('sem token, 401', async () => {
  const r = await chamar({ destinos: [{ cidade: 'Lyon', pais: 'França' }] }, false);
  assert.strictEqual(r.status, 401);
});

test('cidade achada: devolve, grava e avisa o uso ao Unsplash uma vez', async () => {
  respostasDoUnsplash['Lyon France'] = [fotoDe('l1', 'Old town of Lyon')];
  const r = await chamar({ destinos: [{ cidade: 'Lyon', pais: 'França' }] });
  assert.strictEqual(r.corpo.destinos[0].nivel, 'cidade');
  assert.strictEqual(r.corpo.destinos[0].url, 'https://img/l1');
  assert.deepStrictEqual(buscas, ['Lyon France']);
  assert.deepStrictEqual(avisos, ['/photos/l1/download']);
  assert.ok(banco.has('lyon||franca'));

  // Segunda vez: só lê.
  buscas = [];
  avisos = [];
  const r2 = await chamar({ destinos: [{ cidade: 'Lyon', pais: 'França' }] });
  assert.strictEqual(r2.corpo.destinos[0].url, 'https://img/l1');
  assert.deepStrictEqual(buscas, []);
  assert.deepStrictEqual(avisos, []);
});

test('cidade pequena sem foto boa sobe para a região e depois para o país', async () => {
  respostasDoUnsplash['Sinop Brazil'] = [fotoDe('x', 'a random river')];
  respostasDoUnsplash['Mato Grosso Brazil'] = [];
  respostasDoUnsplash['Brazil'] = [fotoDe('br', 'Rio de Janeiro, Brazil')];
  const r = await chamar({ destinos: [{ cidade: 'Sinop', regiao: 'MT', pais: 'Brasil' }] });
  assert.strictEqual(r.corpo.destinos[0].nivel, 'pais');
  assert.deepStrictEqual(buscas, ['Sinop Brazil', 'Mato Grosso Brazil', 'Brazil']);
  assert.strictEqual(banco.get('sinop|mt|brasil').nivel, 'nenhuma', 'a cidade fica marcada sem foto');
  assert.strictEqual(banco.get('|mt|brasil').nivel, 'nenhuma');
  assert.strictEqual(banco.get('||brasil').nivel, 'pais');

  // Outra cidade do Brasil reaproveita o país sem buscar de novo.
  buscas = [];
  respostasDoUnsplash['Sorriso Brazil'] = [];
  const r2 = await chamar({ destinos: [{ cidade: 'Sorriso', regiao: 'MT', pais: 'Brasil' }] });
  assert.strictEqual(r2.corpo.destinos[0].url, 'https://img/br');
  assert.deepStrictEqual(buscas, ['Sorriso Brazil'], 'região e país já eram sabidos');
});

test('a foto escolhida à mão pela Lais no país vale sem busca', async () => {
  banco.set('||portugal', { chave: '||portugal', nivel: 'manual', url: 'https://img/lais', url_pequena: 'https://img/lais-s' });
  respostasDoUnsplash['Obidos Portugal'] = [];
  const r = await chamar({ destinos: [{ cidade: 'Obidos', pais: 'Portugal' }] });
  assert.strictEqual(r.corpo.destinos[0].url, 'https://img/lais');
  assert.deepStrictEqual(buscas, ['Obidos Portugal']);
});

test('duas cidades do mesmo país no mesmo pedido buscam o país uma vez', async () => {
  respostasDoUnsplash['France'] = [fotoDe('fr', 'France countryside')];
  const r = await chamar({ destinos: [{ cidade: 'Vilarejo', pais: 'França' }, { cidade: 'Aldeia', pais: 'França' }] });
  assert.strictEqual(r.corpo.destinos[0].url, 'https://img/fr');
  assert.strictEqual(r.corpo.destinos[1].url, 'https://img/fr');
  assert.strictEqual(buscas.filter((b) => b === 'France').length, 1);
});

test('limite do Unsplash: para de buscar e não grava "sem foto"', async () => {
  respostasDoUnsplash['Lyon France'] = 'limite';
  const r = await chamar({ destinos: [{ cidade: 'Lyon', pais: 'França' }, { cidade: 'Porto', pais: 'Portugal' }] });
  assert.deepStrictEqual(r.corpo.destinos, [null, null]);
  assert.ok(!banco.has('lyon||franca'), 'sem foto por falta de limite não é "não há foto"');
  assert.ok(buscas.length <= 2);
});

test('lugar: aceita só se o nome próprio aparece na foto', async () => {
  respostasDoUnsplash['Museu do Louvre Paris'] = [fotoDe('lv', 'The Louvre pyramid at night')];
  respostasDoUnsplash['Bistrô da Esquina Paris'] = [fotoDe('q', 'a cafe in Paris')];
  const r = await chamar({
    lugares: [
      { lugar: 'Museu do Louvre', cidade: 'Paris', pais: 'França' },
      { lugar: 'Bistrô da Esquina', cidade: 'Paris', pais: 'França' },
      { lugar: 'Mercado Central', cidade: 'Paris', pais: 'França' },
    ],
  });
  assert.strictEqual(r.corpo.lugares[0].url, 'https://img/lv');
  assert.strictEqual(r.corpo.lugares[1], null);
  assert.strictEqual(r.corpo.lugares[2], null, 'sem palavra própria, nem busca');
  assert.ok(!buscas.includes('Mercado Central Paris'));
});

test('pedido vazio responde vazio sem tocar em nada', async () => {
  const r = await chamar({});
  assert.deepStrictEqual(r.corpo, { destinos: [], lugares: [] });
  assert.deepStrictEqual(buscas, []);
});
