// Suíte do verificarStatus. Rode com: node --test
//
// Por que este arquivo existe: um FALSO POSITIVO aqui é o defeito caro.
// Se um lugar aberto for classificado como fechado, o usuário paga uma
// espera inteira (outra ida ao Gemini) para trocar uma sugestão que
// estava ótima - e ninguém percebe, porque o resultado continua sendo
// "uma sugestão". O caminho contrário, deixar passar um fechado, ao menos
// aparece na tela.
//
// Por isso a maior parte dos casos abaixo verifica o que NÃO deve ser
// tratado como fechado: sem business_status, ZERO_RESULTS, erro de rede,
// quota estourada, timeout.
//
// Não chama o Google: troca o `fetch` global por um dublê.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { verificarStatus, FECHADO } = require('./verificar-status');

const CHAVE = 'chave-de-teste';
const BUSCA = 'Museu do Amanhã, Rio de Janeiro, Brasil';

const fetchOriginal = global.fetch;

function dubleDeFetch(resposta) {
  global.fetch = async () => resposta;
}

function respostaOk(corpo) {
  return { ok: true, status: 200, json: async () => corpo };
}

describe('verificarStatus', () => {
  beforeEach(() => {
    global.fetch = fetchOriginal;
  });

  afterEach(() => {
    global.fetch = fetchOriginal;
  });

  // ---------------------------------------------------------------
  // O que DEVE ser fechado
  // ---------------------------------------------------------------

  for (const status of [...FECHADO]) {
    test(`business_status ${status} -> fechado`, async () => {
      dubleDeFetch(respostaOk({
        status: 'OK',
        results: [{ business_status: status, place_id: 'x', name: 'Lugar' }],
      }));

      const r = await verificarStatus(BUSCA, CHAVE);
      assert.equal(r.veredito, 'fechado');
      assert.equal(r.status, status);
      assert.equal(r.nomeGoogle, 'Lugar');
    });
  }

  // ---------------------------------------------------------------
  // O que NÃO pode ser fechado - a parte que importa
  // ---------------------------------------------------------------

  test('OPERATIONAL -> aberto', async () => {
    dubleDeFetch(respostaOk({
      status: 'OK',
      results: [{ business_status: 'OPERATIONAL', place_id: 'x', name: 'Lugar' }],
    }));

    assert.equal((await verificarStatus(BUSCA, CHAVE)).veredito, 'aberto');
  });

  test('sem business_status -> aberto (praça, mirante, praia)', async () => {
    dubleDeFetch(respostaOk({
      status: 'OK',
      results: [{ place_id: 'x', name: 'Praia de Copacabana' }],
    }));

    const r = await verificarStatus(BUSCA, CHAVE);
    assert.equal(r.veredito, 'aberto');
    assert.equal(r.semStatus, true);
  });

  test('ZERO_RESULTS -> nao_encontrado, nunca fechado', async () => {
    dubleDeFetch(respostaOk({ status: 'ZERO_RESULTS', results: [] }));

    assert.equal((await verificarStatus(BUSCA, CHAVE)).veredito, 'nao_encontrado');
  });

  test('results vazio com status OK -> nao_encontrado', async () => {
    dubleDeFetch(respostaOk({ status: 'OK', results: [] }));

    assert.equal((await verificarStatus(BUSCA, CHAVE)).veredito, 'nao_encontrado');
  });

  test('OVER_QUERY_LIMIT -> erro, nunca fechado', async () => {
    dubleDeFetch(respostaOk({ status: 'OVER_QUERY_LIMIT' }));

    const r = await verificarStatus(BUSCA, CHAVE);
    assert.equal(r.veredito, 'erro');
    assert.equal(r.motivo, 'OVER_QUERY_LIMIT');
  });

  test('REQUEST_DENIED (chave inválida) -> erro, nunca fechado', async () => {
    dubleDeFetch(respostaOk({ status: 'REQUEST_DENIED' }));

    assert.equal((await verificarStatus(BUSCA, CHAVE)).veredito, 'erro');
  });

  test('HTTP 500 do Google -> erro', async () => {
    dubleDeFetch({ ok: false, status: 500, json: async () => ({}) });

    const r = await verificarStatus(BUSCA, CHAVE);
    assert.equal(r.veredito, 'erro');
    assert.equal(r.motivo, 'HTTP 500');
  });

  test('falha de rede -> erro, e NÃO lança', async () => {
    global.fetch = async () => { throw new Error('ECONNRESET'); };

    const r = await verificarStatus(BUSCA, CHAVE);
    assert.equal(r.veredito, 'erro');
    assert.equal(r.motivo, 'ECONNRESET');
  });

  test('timeout -> erro com motivo timeout, e não deixa timer pendurado', async () => {
    // Nunca resolve: quem tem de cortar é o AbortController.
    global.fetch = (_url, opcoes) =>
      new Promise((_resolver, rejeitar) => {
        opcoes.signal.addEventListener('abort', () => {
          const e = new Error('abortado');
          e.name = 'AbortError';
          rejeitar(e);
        });
      });

    const r = await verificarStatus(BUSCA, CHAVE, 50);
    assert.equal(r.veredito, 'erro');
    assert.equal(r.motivo, 'timeout');
  });

  // ---------------------------------------------------------------
  // Entradas ruins: falham sem chamar o Google
  // ---------------------------------------------------------------

  test('sem chave -> erro sem chamar o Google', async () => {
    let chamou = false;
    global.fetch = async () => { chamou = true; return respostaOk({}); };

    const r = await verificarStatus(BUSCA, undefined);
    assert.equal(r.veredito, 'erro');
    assert.match(r.motivo, /GOOGLE_MAPS_KEY/);
    assert.equal(chamou, false);
  });

  test('maps_search_query vazio ou só espaço -> erro sem chamar o Google', async () => {
    let chamadas = 0;
    global.fetch = async () => { chamadas += 1; return respostaOk({}); };

    for (const entrada of ['', '   ', undefined, null]) {
      const r = await verificarStatus(entrada, CHAVE);
      assert.equal(r.veredito, 'erro', `entrada ${JSON.stringify(entrada)}`);
    }
    assert.equal(chamadas, 0);
  });
});
