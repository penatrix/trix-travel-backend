// O filtro de vibes pelo destino (13/11): o pedido, o cache e a
// conferência da resposta.

'use strict';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizarDestino,
  lerOpcoes,
  montarPromptVibes,
  conferirVibes,
  respostaDoCache,
  linhaNovaDoCache,
  lerCache,
  gravarCache,
  MAX_OPCOES,
} = require('./vibes');

const DIA = 86400000;
const AGORA = Date.parse('2026-11-13T12:00:00Z');

describe('normalizarDestino', () => {
  test('minúsculas, pontas aparadas, espaços colapsados', () => {
    assert.strictEqual(normalizarDestino('  Belo   Horizonte,\tMG '), 'belo horizonte, mg');
    assert.strictEqual(normalizarDestino(null), '');
  });
});

describe('lerOpcoes', () => {
  test('fica só o bem formado, sem repetir', () => {
    assert.deepStrictEqual(
      lerOpcoes([
        { chave: 'Beach', nome: 'Beach' },
        { chave: ' neve ', nome: ' snow ' },
        { chave: 'Beach', nome: 'outra vez' },
        { chave: '', nome: 'sem chave' },
        { chave: 'sem_nome' },
        { chave: 3, nome: 'número' },
        'texto solto',
        null,
      ]),
      [{ chave: 'Beach', nome: 'Beach' }, { chave: 'neve', nome: 'snow' }],
    );
    assert.deepStrictEqual(lerOpcoes('nada'), []);
  });

  test('no máximo 80', () => {
    const muitas = Array.from({ length: 120 }, (_, i) => ({ chave: `c${i}`, nome: `n${i}` }));
    assert.strictEqual(lerOpcoes(muitas).length, MAX_OPCOES);
    assert.strictEqual(MAX_OPCOES, 80);
  });
});

describe('montarPromptVibes', () => {
  const p = montarPromptVibes({
    destination: 'Belo Horizonte, MG, Brasil',
    opcoes: [{ chave: 'Beach', nome: 'Beach' }, { chave: 'neve', nome: 'snow' }],
  });

  test('leva o destino e as opções com o id', () => {
    assert.match(p, /DESTINATION: Belo Horizonte, MG, Brasil/);
    assert.match(p, /- Beach: Beach\n- neve: snow/);
  });

  test('é conservador e não inventa id', () => {
    assert.match(p, /When unsure.*KEEP it/);
    assert.match(p, /Never invent an id/);
    assert.match(p, /\{ "fora": \["id", "\.\.\."\] \}/);
  });
});

describe('conferirVibes', () => {
  const pedidas = ['Beach', 'neve', 'vinicolas'];

  test('só o que foi pedido, na ordem do pedido, sem diferenciar caixa', () => {
    assert.deepStrictEqual(
      conferirVibes({ fora: ['vinicolas', 'beach', 'inventada', 7, 'neve'] }, pedidas),
      ['Beach', 'neve', 'vinicolas'],
    );
  });

  test('fora do formato vale como nada fora', () => {
    for (const bruto of [null, 'x', {}, { fora: 'Beach' }, []]) {
      assert.deepStrictEqual(conferirVibes(bruto, pedidas), []);
    }
  });
});

describe('o cache', () => {
  const linha = {
    destino: 'belo horizonte',
    fora: ['Beach', 'neve'],
    avaliadas: ['Beach', 'neve', 'Wine', 'museus'],
    criado_em: new Date(AGORA - 10 * DIA).toISOString(),
  };

  test('serve quando é novo e avaliou tudo, e devolve só o pedido', () => {
    assert.deepStrictEqual(respostaDoCache(linha, ['Beach', 'Wine'], AGORA), ['Beach']);
    assert.deepStrictEqual(respostaDoCache(linha, ['Wine'], AGORA), []);
  });

  test('não serve com chave nunca avaliada, vencido ou sem linha', () => {
    assert.strictEqual(respostaDoCache(linha, ['Beach', 'termas'], AGORA), null);
    assert.strictEqual(respostaDoCache({ ...linha, criado_em: new Date(AGORA - 90 * DIA).toISOString() }, ['Beach'], AGORA), null);
    assert.strictEqual(respostaDoCache({ ...linha, criado_em: 'ontem' }, ['Beach'], AGORA), null);
    assert.strictEqual(respostaDoCache(null, ['Beach'], AGORA), null);
  });

  test('a linha nova soma as avaliadas e guarda o fora do que não foi reavaliado', () => {
    const nova = linhaNovaDoCache('belo horizonte', linha, ['termas', 'neve'], ['termas'], AGORA);
    assert.deepStrictEqual(nova.avaliadas, ['Beach', 'neve', 'Wine', 'museus', 'termas']);
    // `neve` foi reavaliada e desta vez ficou: sai do fora.
    assert.deepStrictEqual(nova.fora, ['Beach', 'termas']);
    assert.strictEqual(nova.criado_em, new Date(AGORA).toISOString());
  });

  test('linha vencida não empresta nada', () => {
    const velha = { ...linha, criado_em: new Date(AGORA - 200 * DIA).toISOString() };
    const nova = linhaNovaDoCache('belo horizonte', velha, ['termas'], [], AGORA);
    assert.deepStrictEqual(nova.avaliadas, ['termas']);
    assert.deepStrictEqual(nova.fora, []);
  });
});

describe('o banco, por fetch', () => {
  const fetchOriginal = global.fetch;
  const envOriginal = { ...process.env };
  afterEach(() => {
    global.fetch = fetchOriginal;
    process.env = { ...envOriginal };
  });

  test('lê pelo destino com service_role', async () => {
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    let pedido;
    global.fetch = async (url, init) => {
      pedido = { url, init };
      return { ok: true, json: async () => [{ destino: 'belo horizonte', fora: [] }] };
    };
    const linha = await lerCache('belo horizonte');
    assert.strictEqual(linha.destino, 'belo horizonte');
    assert.match(pedido.url, /\/rest\/v1\/vibes_do_destino\?destino=eq\.belo%20horizonte&/);
    assert.strictEqual(pedido.init.headers.Authorization, 'Bearer srk');
  });

  test('leitura que falha é cache vazio, não erro', async () => {
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    global.fetch = async () => { throw new Error('rede'); };
    assert.strictEqual(await lerCache('x'), null);
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    assert.strictEqual(await lerCache('x'), null);
    delete process.env.SUPABASE_URL;
    assert.strictEqual(await lerCache('x'), null);
  });

  test('grava por upsert no destino, e a falha não lança', async () => {
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'srk';
    let pedido;
    global.fetch = async (url, init) => { pedido = { url, init }; return { ok: true }; };
    assert.strictEqual(await gravarCache({ destino: 'x', fora: [], avaliadas: ['a'], criado_em: 'agora' }), true);
    assert.match(pedido.url, /vibes_do_destino\?on_conflict=destino$/);
    assert.match(pedido.init.headers.Prefer, /resolution=merge-duplicates/);
    global.fetch = async () => { throw new Error('rede'); };
    assert.strictEqual(await gravarCache({ destino: 'x' }), false);
  });
});

describe('o handler', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const inicio = fonte.indexOf('async function filtrarVibes');
  const vibes = fonte.slice(inicio, fonte.indexOf('exports.suggestCities'));

  test('declara thinkingConfig e teto de tempo na chamada', () => {
    assert.ok(inicio > 0);
    assert.match(vibes, /thinkingConfig: \{ thinkingLevel: 'LOW' \}/);
    assert.match(vibes, /signal: AbortSignal\.timeout\(TETO_VIBES_MS\)/);
    assert.match(vibes, /maxOutputTokens: \d+/);
  });

  test('o cache vem antes do modelo', () => {
    assert.ok(vibes.indexOf('respostaDoCache(') < vibes.indexOf('generativelanguage'));
  });

  test('a falha responde 200 com a lista vazia', () => {
    const falha = vibes.slice(vibes.indexOf('} catch (erro)'));
    assert.match(falha, /res\.status\(200\)\.json\(\{ fora: \[\] \}\)/);
    assert.doesNotMatch(falha, /status\(500\)/);
  });

  test('o desvio para o modo vibes vem antes do alarme das cidades', () => {
    assert.ok(fonte.indexOf("req.body?.modo === 'vibes'") < fonte.indexOf('const alarme = setTimeout'));
  });
});
