// As sub-vibes no prompt da geração (13/11).
//
// O que se trava aqui: sem sub-vibe e sem esporte, o prompt é o mesmo de
// antes (os casos do `prompt-da-geracao.casos.json` continuam valendo
// sem regenerar); com sub-vibe, uma linha agrupada por vibe; e o
// esporte nunca promete jogo em data marcada.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { montarPromptDaGeracao } = require('./prompt-da-geracao');
const { montarPromptDoAcrescimo } = require('./acrescimo');
const {
  chavesDaLinha,
  resolverSubVibes,
  linhasDasSubVibes,
} = require('./sub-vibes');
const casos = require('./prompt-da-geracao.casos.json');

const HOJE = { hoje: '2026-10-26' };

// Linhas como estão em `trix_subvibes` em 13/11.
const CATALOGO = [
  { vibe_tag: 'Gastronomy', chave: 'comida_de_rua', ai_prompt: 'street food stalls and food markets', ordem: 2 },
  { vibe_tag: 'Gastronomy', chave: 'achados_locais', ai_prompt: 'little-known places where locals eat, away from the usual tourist lists (still real, established and open)', ordem: 4 },
  { vibe_tag: 'Sports', chave: 'estadios', ai_prompt: 'stadium visits, stadium tours and club museums; never schedule or promise a specific match, game date or ticket', ordem: 1 },
  { vibe_tag: 'Wine', chave: 'vinicolas', ai_prompt: 'winery visits and tastings', ordem: 1 },
];
const doCatalogo = (...chaves) => CATALOGO.filter((s) => chaves.includes(s.chave));

const base = casos[0].linha; // vibe_tags 'Wine, Slow travel'

describe('sem sub-vibe e sem esporte, o prompt não muda', () => {
  test('em todos os casos de regressão, com lista vazia ou ausente', () => {
    // Os casos de antes de 13/11: nenhum tem sub-vibe nem esporte.
    const antigos = casos.filter((c) => !c.linha.sub_vibes_resolvidas && !/sports/i.test(c.linha.vibe_tags ?? ''));
    assert.ok(antigos.length >= 9);
    for (const c of antigos) {
      assert.strictEqual(montarPromptDaGeracao({ ...c.linha, sub_vibes_resolvidas: [] }, c.dna, HOJE), c.esperado, c.nome);
      assert.strictEqual(montarPromptDaGeracao({ ...c.linha, sub_vibes_resolvidas: null }, c.dna, HOJE), c.esperado, c.nome);
      assert.strictEqual(montarPromptDaGeracao({ ...c.linha, sub_vibes: 'comida_de_rua' }, c.dna, HOJE), c.esperado,
        'a coluna crua não entra: só o que o handler resolveu');
    }
  });

  test('nem a linha nova nem a trava aparecem', () => {
    const p = montarPromptDaGeracao(base, null, HOJE);
    assert.doesNotMatch(p, /Within those interests/);
    assert.doesNotMatch(p, /no event calendar/);
  });
});

describe('com sub-vibes', () => {
  const linha = {
    ...base,
    vibe_tags: 'Sports, Gastronomy',
    // Fora de ordem de propósito: o grupo segue as vibe_tags e, dentro
    // dele, a `ordem` da tabela.
    sub_vibes_resolvidas: doCatalogo('achados_locais', 'estadios', 'comida_de_rua'),
  };
  const p = montarPromptDaGeracao(linha, null, HOJE);

  test('vêm logo depois de "Main interests", agrupadas pela ordem das vibes', () => {
    assert.ok(p.includes(
      '  Main interests: Sports, Gastronomy.\n' +
      '  Within those interests, specifically: ' +
      'Sports: stadium visits, stadium tours and club museums; never schedule or promise a specific match, game date or ticket. ' +
      'Gastronomy: street food stalls and food markets; little-known places where locals eat, away from the usual tourist lists (still real, established and open).\n',
    ));
  });

  test('o resto do prompt é o mesmo de antes', () => {
    const semSub = montarPromptDaGeracao({ ...linha, vibe_tags: 'Wine, Slow travel', sub_vibes_resolvidas: [] }, null, HOJE);
    const tirarLinhasNovas = (t) => t
      .replace(/\n  Within those interests[^\n]*/, '')
      .replace(/\n  There is no event calendar[^\n]*/, '')
      .replace('Main interests: Sports, Gastronomy.', 'Main interests: Wine, Slow travel.');
    assert.strictEqual(tirarLinhasNovas(p), semSub);
  });

  test('chave desconhecida não chega ao prompt', () => {
    // O banco não devolve a chave que não existe; o que voltar sem frase
    // também é ignorado.
    const q = montarPromptDaGeracao({
      ...base,
      vibe_tags: 'Wine',
      sub_vibes_resolvidas: [...doCatalogo('vinicolas'), { vibe_tag: 'Wine', chave: 'fantasma', ai_prompt: '  ', ordem: 9 }],
    }, null, HOJE);
    assert.match(q, /\n  Within those interests, specifically: Wine: winery visits and tastings\.\n  Special requests:/);
  });

  test('sub-vibe de uma vibe que saiu das tags ainda entra, depois', () => {
    const [l] = linhasDasSubVibes('Wine', doCatalogo('vinicolas', 'comida_de_rua'));
    assert.strictEqual(l, 'Within those interests, specifically: Wine: winery visits and tastings. Gastronomy: street food stalls and food markets.');
  });

  test('a mesma chave duas vezes entra uma', () => {
    const [l] = linhasDasSubVibes('Wine', [...doCatalogo('vinicolas'), ...doCatalogo('vinicolas')]);
    assert.strictEqual(l, 'Within those interests, specifically: Wine: winery visits and tastings.');
  });
});

describe('a trava do esporte', () => {
  const TRAVA = /\n  There is no event calendar for this trip: NEVER schedule or promise a specific match, game, show or event on a given date, nor tickets for one\. Stadium visits, stadium tours and club museums are fine\.\n  Special requests:/;

  test('com Sports nas vibes, mesmo sem sub-vibe', () => {
    const p = montarPromptDaGeracao({ ...base, vibe_tags: 'Wine, sports' }, null, HOJE);
    assert.match(p, TRAVA);
    assert.doesNotMatch(p, /Within those interests/);
  });

  test('com sub-vibe de esporte, vem depois da linha das sub-vibes', () => {
    const p = montarPromptDaGeracao({ ...base, vibe_tags: 'Sports', sub_vibes_resolvidas: doCatalogo('estadios') }, null, HOJE);
    assert.ok(p.indexOf('Within those interests') < p.indexOf('There is no event calendar'));
    assert.match(p, TRAVA);
  });

  test('sem Sports, não aparece', () => {
    const p = montarPromptDaGeracao({ ...base, vibe_tags: 'Gastronomy', sub_vibes_resolvidas: doCatalogo('comida_de_rua') }, null, HOJE);
    assert.doesNotMatch(p, /event calendar/);
    // "Sports" como parte de outra palavra não conta.
    assert.deepStrictEqual(linhasDasSubVibes('Water sports fans', []), []);
  });
});

test('o acréscimo reaproveita o prompt da geração, com as linhas novas', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(fonte, /montarPromptDoAcrescimo\(\s*montarPromptDaGeracao\(linhaNova, dna\)/);
  const geracao = montarPromptDaGeracao({ ...base, vibe_tags: 'Sports', sub_vibes_resolvidas: doCatalogo('estadios') }, null, HOJE);
  const p = montarPromptDoAcrescimo(
    geracao,
    { pecas: [{ tipo: 'estender', cidade: 'Lisboa', primeiroDia: 10, diasNovos: 1, diasHoje: 5 }] },
    { destinations: [] },
    { pt: true, travelers: 2 },
  );
  assert.match(p, /\n  Within those interests, specifically: Sports: stadium visits/);
  assert.match(p, /\n  There is no event calendar for this trip/);
});

describe('o handler resolve as sub-vibes nos três caminhos', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

  test('o select lê sub_vibes', () => {
    assert.match(fonte, /planned_destinations, sub_vibes'/);
  });

  test('a geração resolve antes de montar o prompt', () => {
    const resolve = fonte.indexOf('tripAtual.sub_vibes_resolvidas = await resolverSubVibes(supabase, tripAtual)');
    assert.ok(resolve > 0);
    assert.ok(resolve < fonte.indexOf('montarPromptDaGeracao(tripAtual, dono?.travel_dna ?? null)'));
  });

  test('o refazer (e o acréscimo, pela linhaNova) também', () => {
    const refazer = fonte.slice(fonte.indexOf('async function refazerRoteiro'), fonte.indexOf('exports.generateTrip'));
    const resolve = refazer.indexOf('sub_vibes_resolvidas: await resolverSubVibes(supabase, tripAtual)');
    assert.ok(resolve > 0);
    assert.ok(resolve < refazer.indexOf('gerarAcrescimo('));
    assert.ok(resolve < refazer.indexOf('gerarEValidar('));
  });
});

describe('resolverSubVibes', () => {
  // Um cliente falso com a forma do supabase-js: from().select().in().
  function clienteFalso(resposta, registro = {}) {
    return {
      from(tabela) {
        registro.tabela = tabela;
        return {
          select(colunas) {
            registro.colunas = colunas;
            return {
              in(coluna, valores) {
                registro.in = [coluna, valores];
                if (resposta instanceof Error) return Promise.reject(resposta);
                return Promise.resolve(resposta);
              },
            };
          },
        };
      },
    };
  }

  test('lê só as chaves bem formadas, sem filtrar por ativa', async () => {
    const reg = {};
    const r = await resolverSubVibes(
      clienteFalso({ data: doCatalogo('comida_de_rua'), error: null }, reg),
      { id: 1, sub_vibes: 'comida_de_rua, Fantasma ,comida_de_rua, ; drop table' },
    );
    assert.strictEqual(reg.tabela, 'trix_subvibes');
    assert.doesNotMatch(reg.colunas, /ativa/);
    assert.deepStrictEqual(reg.in, ['chave', ['comida_de_rua', 'fantasma']]);
    assert.deepStrictEqual(r, doCatalogo('comida_de_rua'));
  });

  test('sem sub_vibes, não vai ao banco', async () => {
    const reg = {};
    for (const v of [null, undefined, '', '  , ']) {
      assert.deepStrictEqual(await resolverSubVibes(clienteFalso({ data: [] }, reg), { sub_vibes: v }), []);
    }
    assert.strictEqual(reg.tabela, undefined);
  });

  test('falha do banco não derruba a geração', async () => {
    assert.deepStrictEqual(
      await resolverSubVibes(clienteFalso({ data: null, error: { message: 'boom' } }), { id: 2, sub_vibes: 'estadios' }),
      [],
    );
    assert.deepStrictEqual(
      await resolverSubVibes(clienteFalso(new Error('rede')), { id: 3, sub_vibes: 'estadios' }),
      [],
    );
  });

  test('chavesDaLinha', () => {
    assert.deepStrictEqual(chavesDaLinha('a_b, c1'), ['a_b', 'c1']);
    assert.deepStrictEqual(chavesDaLinha(42), []);
  });
});
