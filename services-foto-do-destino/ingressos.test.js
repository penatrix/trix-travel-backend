// A conferência do lugar na Tiqets (05/11), com a Tiqets e o banco de
// mentira. O que se trava: só sai endereço quando a busca leva direto à
// página do lugar E a página é da cidade do roteiro; "não vende" se
// grava, falha de rede não; e o que já foi conferido não se confere de
// novo.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

process.env.SUPABASE_JWT_SECRET = 'segredo';
process.env.SUPABASE_URL = 'https://banco.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
process.env.UNSPLASH_ACCESS_KEY = 'chave';

const ingressos = require('./ingressos');
const { fotoDoDestino } = require('./index');

const token = jwt.sign({ role: 'authenticated', sub: 'u1' }, 'segredo');

// Um trecho da página real da Tiqets (Castelo de Praga, 05/11).
function paginaDe(ingles, nome, produtos = []) {
  const ld = produtos
    .map((p) => `{"@type": "Product", "location": "Lugar", "name": "${p}", "offers": {}}`)
    .join(', ');
  return `<script>window.BUILD_VERSION = "v1";
      window.BOOTSTRAP_DATA = {"city": {"admin_name": "${ingles}", "id": 76528, "in_city": "em ${nome}", "name": "${nome}", "today": "2026-11-05"}, "venue": {}};</script>
      <script type="application/ld+json">[${ld}]</script>`;
}

const LUGARES = {
  'Castelo de Praga': { pagina: '/pt/bilhetes-castelo-de-praga-l144211/', ingles: 'Prague', nome: 'Praga' },
  Rijksmuseum: { pagina: '/pt/bilhetes-rijksmuseum-l127351/', ingles: 'Amsterdam', nome: 'Amsterd\\u00e3' },
  'Museu Nacional': { pagina: '/pt/bilhetes-museu-nacional-de-arte-antiga-l202731/', ingles: 'Lisbon', nome: 'Lisboa' },
  // Fica em Kilchberg, ao lado de Zurique; a página vende passeios que
  // citam Zurique.
  'Lindt Home of Chocolate': {
    pagina: '/pt/bilhetes-lindt-home-of-chocolate-l193050/',
    ingles: 'Kilchberg',
    nome: 'Kilchberg',
    produtos: ['Lindt Home of Chocolate: bilhete de entrada', 'Zurique: Visita guiada \\u00e0 Cidade Velha + Lindt'],
  },
  // A Tiqets só acha pelo nome sem o parêntese.
  'Palácio Ducal': { pagina: '/pt/bilhetes-palacio-ducal-l143993/', ingles: 'Venice', nome: 'Veneza' },
};

let banco;
let pedidosATiqets;
let tiqetsFora;

beforeEach(() => {
  banco = new Map();
  pedidosATiqets = [];
  tiqetsFora = false;
  global.fetch = async (url, opcoes = {}) => {
    const u = new URL(url);
    if (u.host === 'banco.test') {
      if ((opcoes.method ?? 'GET') === 'GET') {
        const lista = decodeURIComponent(u.search).match(/in\.\((.*)\)/)[1];
        const chaves = [...lista.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
        return new Response(JSON.stringify(chaves.filter((c) => banco.has(c)).map((c) => banco.get(c))), { status: 200 });
      }
      const linha = JSON.parse(opcoes.body);
      banco.set(linha.chave, linha);
      return new Response('', { status: 201 });
    }
    if (u.host === 'www.tiqets.com') {
      pedidosATiqets.push(u.pathname + u.search);
      if (tiqetsFora) throw new Error('rede');
      if (u.pathname === '/pt/search') {
        assert.strictEqual(opcoes.redirect, 'manual', 'a busca não segue o redirecionamento');
        const l = LUGARES[u.searchParams.get('q')];
        if (!l) return new Response('<html>57 atrações</html>', { status: 200 });
        return new Response('', { status: 302, headers: { location: `https://www.tiqets.com${l.pagina}` } });
      }
      const l = Object.values(LUGARES).find((x) => x.pagina === u.pathname);
      return new Response(paginaDe(l.ingles, l.nome, l.produtos), { status: 200 });
    }
    throw new Error(`fetch inesperado: ${url}`);
  };
});

function chamar(corpo) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      set() {},
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, corpo: b }); },
      send(b) { resolve({ status: this.statusCode, corpo: b }); },
    };
    fotoDoDestino({ method: 'POST', headers: { authorization: `Bearer ${token}` }, body: corpo }, res);
  });
}

test('lugar à venda na cidade do roteiro: o endereço da página', async () => {
  const r = await chamar({ ingressos: [{ lugar: 'Castelo de Praga', cidade: 'Praga' }] });
  assert.deepStrictEqual(r.corpo.ingressos, [
    { url: 'https://www.tiqets.com/pt/bilhetes-castelo-de-praga-l144211/' },
  ]);
  assert.strictEqual(banco.get('tiqets|castelo de praga|praga').cidade_da_pagina, 'Praga');
});

test('a cidade em inglês também vale, e o acento da página não atrapalha', async () => {
  const r = await chamar({
    ingressos: [
      { lugar: 'Castelo de Praga', cidade: 'Prague' },
      { lugar: 'Rijksmuseum', cidade: 'Amsterdã' },
    ],
  });
  assert.ok(r.corpo.ingressos[0]?.url);
  assert.ok(r.corpo.ingressos[1]?.url);
});

test('lugar que a Tiqets não vende (a Villa Müller): sem endereço, e guardado', async () => {
  const r = await chamar({ ingressos: [{ lugar: 'Villa Müller', cidade: 'Praga' }] });
  assert.deepStrictEqual(r.corpo.ingressos, [null]);
  assert.strictEqual(banco.get('tiqets|villa muller|praga').url, null);
});

test('lugar na cidade vizinha vale quando um produto da página cita a cidade', async () => {
  const r = await chamar({ ingressos: [{ lugar: 'Lindt Home of Chocolate', cidade: 'Zurique' }] });
  assert.deepStrictEqual(r.corpo.ingressos, [
    { url: 'https://www.tiqets.com/pt/bilhetes-lindt-home-of-chocolate-l193050/' },
  ]);
});

test('o nome sem o parêntese também se tenta, com a mesma conferência', async () => {
  const r = await chamar({ ingressos: [{ lugar: 'Palácio Ducal (Palazzo Ducale)', cidade: 'Veneza' }] });
  assert.deepStrictEqual(r.corpo.ingressos, [{ url: 'https://www.tiqets.com/pt/bilhetes-palacio-ducal-l143993/' }]);
  assert.deepStrictEqual(
    ingressos.nomesATentar('Palácio Ducal (Palazzo Ducale)'),
    ['Palácio Ducal (Palazzo Ducale)', 'Palácio Ducal', 'Palazzo Ducale'],
  );
  assert.deepStrictEqual(ingressos.nomesATentar('Coliseu'), ['Coliseu']);
});

test('lugar de outra cidade que nenhum produto cita: sem endereço', async () => {
  const r = await chamar({ ingressos: [{ lugar: 'Castelo de Praga', cidade: 'Viena' }] });
  assert.deepStrictEqual(r.corpo.ingressos, [null]);
});

test('a página é de outra cidade: sem endereço', async () => {
  const r = await chamar({ ingressos: [{ lugar: 'Museu Nacional', cidade: 'Rio de Janeiro' }] });
  assert.deepStrictEqual(r.corpo.ingressos, [null]);
});

test('o que já foi conferido não vai de novo à Tiqets', async () => {
  await chamar({ ingressos: [{ lugar: 'Castelo de Praga', cidade: 'Praga' }, { lugar: 'Villa Müller', cidade: 'Praga' }] });
  pedidosATiqets = [];
  const r = await chamar({ ingressos: [{ lugar: 'Castelo de Praga', cidade: 'Praga' }, { lugar: 'Villa Müller', cidade: 'Praga' }] });
  assert.deepStrictEqual(pedidosATiqets, []);
  assert.ok(r.corpo.ingressos[0]?.url);
  assert.strictEqual(r.corpo.ingressos[1], null);
});

test('Tiqets fora do ar: null, e nada gravado para tentar de novo', async () => {
  tiqetsFora = true;
  const r = await chamar({ ingressos: [{ lugar: 'Castelo de Praga', cidade: 'Praga' }] });
  assert.deepStrictEqual(r.corpo.ingressos, [null]);
  assert.strictEqual(banco.size, 0);
});

test('pedido só de fotos segue como antes, com a lista de ingressos vazia', async () => {
  const r = await chamar({ destinos: [], lugares: [] });
  assert.deepStrictEqual(r.corpo, { destinos: [], lugares: [], ingressos: [], paginas: [] });
});

test('redirecionamento para fora da página de um lugar não vale', () => {
  assert.ok(ingressos.ehPaginaDeLugar('https://www.tiqets.com/pt/bilhetes-coliseu-l145769/'));
  assert.ok(ingressos.ehPaginaDeLugar('/pt/bilhetes-coliseu-l145769/'));
  assert.ok(!ingressos.ehPaginaDeLugar('https://www.tiqets.com/pt/search?q=x'));
  assert.ok(!ingressos.ehPaginaDeLugar('https://outro.com/pt/bilhetes-coliseu-l145769/'));
  assert.ok(!ingressos.ehPaginaDeLugar('https://www.tiqets.com/pt/roma-c71631/'));
});

test('linha sem página vale 14 dias; com página, 30', () => {
  const dia = 24 * 3600 * 1000;
  const agora = Date.parse('2026-11-30T00:00:00Z');
  const em = (dias) => new Date(agora - dias * dia).toISOString();
  assert.ok(ingressos.linhaAindaVale({ url: 'x', conferido_em: em(29) }, agora));
  assert.ok(!ingressos.linhaAindaVale({ url: 'x', conferido_em: em(31) }, agora));
  assert.ok(ingressos.linhaAindaVale({ url: null, conferido_em: em(13) }, agora));
  assert.ok(!ingressos.linhaAindaVale({ url: null, conferido_em: em(15) }, agora));
});
