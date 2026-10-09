// O refazer do roteiro (09/10): o pedido, os parâmetros que ele vira, e
// as regras do Paulo que o handler tem que respeitar.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { lerPedido, parametrosDoRefazer, somarDias, erroParaATela } = require('./refazer');

const PEDIDO = {
  origem: ' Recife, PE, Brasil ',
  cidades: [
    { destination: 'Lisboa, Portugal', days: 4 },
    { destination: 'Porto, Portugal', days: 3 },
  ],
  nota: 'Sem museus, por favor',
};

describe('lerPedido', () => {
  test('o pedido do app, aparado', () => {
    const p = lerPedido(PEDIDO);
    assert.equal(p.origem, 'Recife, PE, Brasil');
    assert.deepEqual(p.cidades, PEDIDO.cidades);
    assert.equal(p.nota, 'Sem museus, por favor');
  });

  test('origem e nota são opcionais', () => {
    const p = lerPedido({ cidades: [{ destination: 'Roma', days: 2 }] });
    assert.equal(p.origem, null);
    assert.equal(p.nota, '');
  });

  test('recusa o que o gatilho também recusa', () => {
    assert.equal(lerPedido(null), null);
    assert.equal(lerPedido([]), null);
    assert.equal(lerPedido({ cidades: [] }), null);
    assert.equal(lerPedido({ cidades: [{ destination: '', days: 2 }] }), null);
    assert.equal(lerPedido({ cidades: [{ destination: 'Roma', days: 0 }] }), null);
    assert.equal(lerPedido({ cidades: [{ destination: 'Roma', days: 31 }] }), null);
    const dezesseis = Array.from({ length: 16 }, () => ({ destination: 'X', days: 1 }));
    assert.equal(lerPedido({ cidades: dezesseis }), null);
  });
});

describe('parametrosDoRefazer', () => {
  const linha = {
    start_date: '2026-11-10',
    end_date: '2026-11-14',
    special_request: 'Viajo com minha mãe.',
  };

  test('o início fica, o fim acompanha a soma dos dias', () => {
    const n = parametrosDoRefazer(linha, lerPedido(PEDIDO));
    assert.equal(n.end_date, '2026-11-16');
    assert.equal('start_date' in n, false);
  });

  test('as cidades no formato da criação', () => {
    const n = parametrosDoRefazer(linha, lerPedido(PEDIDO));
    assert.deepEqual(n.planned_destinations, PEDIDO.cidades);
    assert.equal(n.origin_city, 'Recife, PE, Brasil');
  });

  test('a nota vem depois do pedido da criação, que continua valendo', () => {
    const n = parametrosDoRefazer(linha, lerPedido(PEDIDO));
    assert.equal(n.special_request, 'Viajo com minha mãe. Sem museus, por favor');
  });

  test('sem nota, o pedido da criação fica como estava', () => {
    const n = parametrosDoRefazer(linha, lerPedido({ cidades: PEDIDO.cidades }));
    assert.equal(n.special_request, 'Viajo com minha mãe.');
  });

  test('origem apagada vira nula, e a passagem sai da conta', () => {
    const n = parametrosDoRefazer(linha, lerPedido({ ...PEDIDO, origem: '' }));
    assert.equal(n.origin_city, null);
  });

  test('somarDias atravessa mês e ano', () => {
    assert.equal(somarDias('2026-12-30', 3), '2027-01-02');
    assert.equal(somarDias('lixo', 3), null);
  });
});

test('a frase de erro não carrega exceção', () => {
  assert.match(erroParaATela('pt'), /ficou como estava/);
  assert.doesNotMatch(erroParaATela('pt'), /Error|Exception/);
});

describe('o handler respeita as regras do refazer', () => {
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const inicio = fonte.indexOf('async function refazerRoteiro');
  const fim = fonte.indexOf('exports.generateTrip');
  const refazer = fonte.slice(inicio, fim);

  test('existe, e vem antes do handler', () => {
    assert.ok(inicio > 0 && fim > inicio);
  });

  test('não gasta cota nem crédito', () => {
    assert.doesNotMatch(refazer, /consume_trip_quota|refund_trip_quota|gastar_roteiro_premium/);
  });

  test('nunca marca o roteiro como falho nem em geração', () => {
    assert.doesNotMatch(refazer, /status:\s*'(failed|generating)'/);
  });

  test('toma posse numa escrita condicional antes de gerar', () => {
    const posse = refazer.indexOf(".is('refazer_iniciado_em', null)");
    const gera = refazer.indexOf('gerarEValidar(');
    assert.ok(posse > 0 && posse < gera);
  });

  test('confere o Premium do roteiro antes de gerar', () => {
    const premium = refazer.indexOf("'premium_no_roteiro'");
    assert.ok(premium > 0 && premium < refazer.indexOf('gerarEValidar('));
  });

  test('o sucesso marca refeito_em; a falha não', () => {
    const falha = refazer.slice(refazer.lastIndexOf('} catch (error)'));
    assert.match(refazer, /refeito_em: new Date\(\)/);
    assert.doesNotMatch(falha, /refeito_em/);
    assert.match(falha, /refazer_erro: erroParaATela/);
  });

  test('o desvio para o refazer vem antes da trava de status', () => {
    assert.ok(
      fonte.indexOf('return await refazerRoteiro(') <
        fonte.indexOf("if (tripAtual.status !== 'generating')"),
    );
  });
});
