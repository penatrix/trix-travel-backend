// A conferência das páginas de parceiro (05/11), com o parceiro de mentira.
const { test } = require('node:test');
const assert = require('node:assert');
const paginas = require('./paginas');

function parceiro(mapa) {
  return async (url, opcoes) => {
    assert.strictEqual(opcoes.redirect, 'manual');
    const r = mapa[url];
    if (r === 'rede') throw new Error('rede');
    if (typeof r === 'number') return new Response('', { status: r });
    if (r) return new Response('', { status: 301, headers: { location: r } });
    return new Response('', { status: 404 });
  };
}

test('só parceiros conhecidos, com caminho de página', () => {
  assert.ok(paginas.enderecoAceito('https://www.airalo.com/czech-republic-esim'));
  assert.ok(paginas.enderecoAceito('https://radicalstorage.com/storage-list/prague'));
  assert.ok(!paginas.enderecoAceito('https://www.airalo.com/'));
  assert.ok(!paginas.enderecoAceito('http://www.airalo.com/czech-republic-esim'));
  assert.ok(!paginas.enderecoAceito('https://evil.com/storage-list/prague'));
  assert.ok(!paginas.enderecoAceito('https://radicalstorage.com/storage-list/prague/../../x'));
});

test('200 existe; 404 não; redirecionar para a inicial não', async () => {
  const fetchFn = parceiro({
    'https://www.airalo.com/czech-republic-esim': 200,
    'https://www.airalo.com/czechia-esim': 'https://www.airalo.com/',
  });
  assert.strictEqual(await paginas.conferirPagina('https://www.airalo.com/czech-republic-esim', { fetchFn }), true);
  assert.strictEqual(await paginas.conferirPagina('https://www.airalo.com/czechia-esim', { fetchFn }), false);
  assert.strictEqual(await paginas.conferirPagina('https://www.airalo.com/atlantida-esim', { fetchFn }), false);
});

test('redirecionamento para outra página do mesmo parceiro vale', async () => {
  const fetchFn = parceiro({
    'https://radicalstorage.com/storage-list/prague': 'https://radicalstorage.com/storage-list/prague/',
    'https://radicalstorage.com/storage-list/prague/': 200,
  });
  assert.strictEqual(await paginas.conferirPagina('https://radicalstorage.com/storage-list/prague', { fetchFn }), true);
});

test('rede, 429 e 5xx lançam: não se grava "não existe" por um soluço', async () => {
  await assert.rejects(paginas.conferirPagina('https://www.airalo.com/japan-esim', { fetchFn: parceiro({ 'https://www.airalo.com/japan-esim': 'rede' }) }));
  await assert.rejects(paginas.conferirPagina('https://www.airalo.com/japan-esim', { fetchFn: parceiro({ 'https://www.airalo.com/japan-esim': 429 }) }));
  await assert.rejects(paginas.conferirPagina('https://www.airalo.com/japan-esim', { fetchFn: parceiro({ 'https://www.airalo.com/japan-esim': 503 }) }));
});
