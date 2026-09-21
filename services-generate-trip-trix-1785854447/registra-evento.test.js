// O registro de evento do backend.
//
// Roda com `node --test`, sem rede: o `fetch` global é substituído em
// cada caso. O que se trava aqui é o que o compilador não vê e o que a
// produção só contaria meses depois -- linha que não grava, tipo
// errado, entrada somada na saída, e a regra de nunca derrubar quem
// chamou.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const {
  registrarEvento,
  contadorDePlaces,
  statusDoErro,
  lerUso,
  TIPOS,
} = require('./registra-evento');

const fetchOriginal = global.fetch;
const warnOriginal = console.warn;
const logOriginal = console.log;

let chamadas;
let avisos;

function fingirFetch(resposta) {
  global.fetch = async (url, opcoes) => {
    chamadas.push({ url, opcoes, corpo: JSON.parse(opcoes.body) });
    return resposta;
  };
}

const ok = { ok: true, status: 201, text: async () => '' };

beforeEach(() => {
  chamadas = [];
  avisos = [];
  console.warn = (m) => avisos.push(String(m));
  console.log = () => {};
  process.env.SUPABASE_URL = 'https://exemplo.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'chave-de-servico';
  fingirFetch(ok);
});

afterEach(() => {
  global.fetch = fetchOriginal;
  console.warn = warnOriginal;
  console.log = logOriginal;
});

describe('o caminho feliz', () => {
  test('grava na eventos, com a chave de serviço', async () => {
    const gravou = await registrarEvento({
      tipo: 'troca_atividade',
      tripId: 290,
      userId: 'abc',
      modelo: 'gemini-3.1-pro',
      uso: {
        promptTokenCount: 1000,
        candidatesTokenCount: 150,
        thoughtsTokenCount: 84,
        totalTokenCount: 1234,
      },
      chamadasPlaces: 6,
      duracaoMs: 4210,
    });
    assert.equal(gravou, true);
    assert.equal(chamadas.length, 1);
    assert.match(chamadas[0].url, /\/rest\/v1\/eventos$/);
    assert.equal(chamadas[0].opcoes.method, 'POST');
    assert.equal(chamadas[0].opcoes.headers.apikey, 'chave-de-servico');
    // Sem isto o PostgREST devolve a linha inteira de graça.
    assert.equal(chamadas[0].opcoes.headers.Prefer, 'return=minimal');
    assert.deepEqual(chamadas[0].corpo, {
      tipo: 'troca_atividade',
      status: 'ok',
      motivo: null,
      trip_id: 290,
      user_id: 'abc',
      modelo: 'gemini-3.1-pro',
      tokens_entrada: 1000,
      tokens_saida: 234,
      tokens_total: 1234,
      chamadas_places: 6,
      duracao_ms: 4210,
      origem: 'backend',
      meta: null,
    });
  });

  test('o roteiro vai como número, não como texto', async () => {
    // `trips.id` é bigint. O app manda número; um handler que repassasse
    // a string do corpo faria o PostgREST coagir -- ou recusar.
    await registrarEvento({ tipo: 'brainstorming', tripId: '290' });
    assert.strictEqual(chamadas[0].corpo.trip_id, 290);
  });

  test('a origem é sempre backend, e não se deixa sobrescrever', async () => {
    // A coluna separa o que o backend gravou do que veio pela RPC do app
    // e do que foi resgatado do Cloud Logging. Misturar as três faria a
    // contagem de "usuário ativo" incluir o próprio servidor.
    await registrarEvento({ tipo: 'brainstorming', origem: 'app' });
    assert.equal(chamadas[0].corpo.origem, 'backend');
  });
});

describe('entrada e saída, que é a razão de esta tabela existir', () => {
  test('o pensamento conta como SAÍDA, não como categoria à parte', async () => {
    // O `thoughtsTokenCount` é cobrado na tarifa de saída -- a cara, seis
    // vezes a de entrada -- e fica FORA do `candidatesTokenCount`. Somar
    // só candidates subestimaria justamente a linha que mais pesa na
    // fatura, e o erro apareceria como "a conta do Google não bate".
    assert.deepEqual(
      lerUso({
        promptTokenCount: 8000,
        candidatesTokenCount: 120,
        thoughtsTokenCount: 1900,
        totalTokenCount: 10020,
      }),
      { entrada: 8000, saida: 2020, total: 10020 },
    );
  });

  test('sem candidates nem thoughts, a saída é o que sobra do total', async () => {
    // Resposta antiga ou parcial. Pior que o número explícito, melhor
    // que nulo.
    assert.deepEqual(
      lerUso({ promptTokenCount: 300, totalTokenCount: 1000 }),
      { entrada: 300, saida: 700, total: 1000 },
    );
  });

  test('sem total, o total é a soma', async () => {
    assert.deepEqual(
      lerUso({ promptTokenCount: 10, candidatesTokenCount: 5 }),
      { entrada: 10, saida: 5, total: 15 },
    );
  });

  test('não medido é NULO, e nunca zero', async () => {
    // A distinção decide a média: `avg` ignora null e engole zero. É o
    // mesmo caso do `flights` que sai 0 no `cost_breakdown` sem cidade
    // de origem -- valor presente, informação ausente.
    for (const nada of [null, undefined, {}, 'x', 42]) {
      assert.deepEqual(
        lerUso(nada),
        { entrada: null, saida: null, total: null },
        `uso=${JSON.stringify(nada)}`,
      );
    }
  });

  test('número quebrado no usageMetadata vira nulo, não NaN', async () => {
    const r = lerUso({ promptTokenCount: 'abc', candidatesTokenCount: -3 });
    assert.strictEqual(r.entrada, null);
    assert.strictEqual(r.saida, null);
    assert.strictEqual(r.total, null);
  });
});

describe('a falha também é um número', () => {
  test('grava linha de erro com o motivo, sem tokens', async () => {
    // Até 21/09 falha não gravava linha nenhuma: as nove primeiras
    // falhas da história do produto só apareceram por resgate manual do
    // Cloud Logging.
    const gravou = await registrarEvento({
      tipo: 'geracao_roteiro',
      status: 'erro',
      motivo: 'Unexpected end of JSON input',
      tripId: 291,
    });
    assert.equal(gravou, true);
    assert.equal(chamadas[0].corpo.status, 'erro');
    assert.equal(chamadas[0].corpo.motivo, 'Unexpected end of JSON input');
    assert.strictEqual(chamadas[0].corpo.tokens_total, null);
  });

  test('erro DEPOIS do Gemini leva o custo junto', async () => {
    // Uma geração que responde e quebra no JSON.parse já queimou o
    // prompt inteiro. Linha de erro sem tokens diria "quebrou" sem dizer
    // quanto custou.
    await registrarEvento({
      tipo: 'geracao_roteiro',
      status: 'erro',
      motivo: 'JSON inválido',
      uso: { promptTokenCount: 9000, candidatesTokenCount: 0 },
    });
    assert.equal(chamadas[0].corpo.tokens_entrada, 9000);
  });

  test('o motivo vai truncado', async () => {
    // `error.message` de JSON quebrado carrega o texto inteiro do
    // modelo. Isso não é motivo, é despejo.
    await registrarEvento({
      tipo: 'geracao_roteiro',
      status: 'erro',
      motivo: 'x'.repeat(5000),
    });
    assert.equal(chamadas[0].corpo.motivo.length, 500);
  });

  test('status fora da lista não grava, e avisa alto', async () => {
    const gravou = await registrarEvento({
      tipo: 'geracao_roteiro',
      status: 'falhou',
    });
    assert.equal(gravou, false);
    assert.equal(chamadas.length, 0);
    assert.ok(avisos.some((a) => a.includes('falhou')));
  });

  describe('timeout tem coluna própria', () => {
    // Erro pede conserto de código; timeout pede folga no teto ou prompt
    // menor. Confundir os dois faz "está lento" e "está quebrado"
    // virarem a mesma linha na planilha.
    test('AbortError é timeout', () => {
      const e = new Error('The operation was aborted');
      e.name = 'AbortError';
      assert.equal(statusDoErro(e), 'timeout');
    });

    test('a mensagem que os handlers montam é timeout', () => {
      // É exatamente o texto que `fetchGemini` lança na segunda
      // tentativa, e o que o brainstorming e a troca de atividade
      // montam quando abortam.
      assert.equal(
        statusDoErro(new Error('Falha de rede ao chamar o Gemini (roteiro): timeout de 300s')),
        'timeout',
      );
      assert.equal(
        statusDoErro(new Error('Gemini não respondeu em 90s no brainstorming.')),
        'erro',
      );
    });

    test('o resto é erro', () => {
      assert.equal(statusDoErro(new Error('Unexpected end of JSON input')), 'erro');
      assert.equal(
        statusDoErro(new Error('Gemini interrompeu a geração (finishReason: MAX_TOKENS)')),
        'erro',
      );
      assert.equal(statusDoErro(null), 'erro');
    });
  });
});

describe('o que falta é nulo, não erro', () => {
  test('sem roteiro grava mesmo assim', async () => {
    // O brainstorming acontece ANTES de existir roteiro. Exigir
    // `trip_id` transformaria gasto real em falha de escrita.
    const gravou = await registrarEvento({ tipo: 'brainstorming' });
    assert.equal(gravou, true);
    assert.strictEqual(chamadas[0].corpo.trip_id, null);
    assert.strictEqual(chamadas[0].corpo.user_id, null);
  });

  test('roteiro inválido vira nulo em vez de derrubar', async () => {
    for (const ruim of [0, -1, 'abc', null, undefined, NaN]) {
      chamadas = [];
      await registrarEvento({ tipo: 'memoria_viajante', tripId: ruim });
      assert.strictEqual(chamadas[0].corpo.trip_id, null, `tripId=${ruim}`);
    }
  });

  test('places e duração inválidos viram nulo', async () => {
    await registrarEvento({
      tipo: 'busca_lugares',
      chamadasPlaces: 'muitas',
      duracaoMs: -1,
    });
    assert.strictEqual(chamadas[0].corpo.chamadas_places, null);
    assert.strictEqual(chamadas[0].corpo.duracao_ms, null);
  });

  test('zero chamadas de Places é ZERO, não ausência', async () => {
    // Aqui a regra é o contrário dos tokens, e de propósito: a troca de
    // atividade sem chave do Google faz zero chamadas, e isso é um fato
    // medido. Nulo diria "não sei", que é outra coisa.
    await registrarEvento({ tipo: 'troca_atividade', chamadasPlaces: 0 });
    assert.strictEqual(chamadas[0].corpo.chamadas_places, 0);
  });
});

describe('a lista de tipos é a do banco', () => {
  test('tipo fora da lista não grava, e avisa alto', async () => {
    // A lista é fechada por `check` no banco. Barrar aqui troca um 400
    // opaco do PostgREST por uma linha de log que diz o nome errado.
    const gravou = await registrarEvento({ tipo: 'generate_trip' });
    assert.equal(gravou, false);
    assert.equal(chamadas.length, 0);
    assert.ok(avisos.some((a) => a.includes('generate_trip')));
  });

  test('os seis tipos do backend são exatamente estes', async () => {
    // A coluna aceita mais -- `roteiro_aberto`, `checklist_marcado` e os
    // outros vêm do app, pela RPC `registrar_evento_do_app`. Aqui só
    // entra o que custa dinheiro numa API externa.
    assert.deepEqual(
      [...TIPOS].sort(),
      [
        'brainstorming',
        'busca_lugares',
        'emenda_restricao',
        'geracao_roteiro',
        'memoria_viajante',
        'troca_atividade',
      ],
    );
  });
});

describe('o contador de Places', () => {
  test('nasce zerado e é um objeto novo a cada chamada', () => {
    // Esta é a propriedade que importa: o Cloud Run serve requisições
    // concorrentes na mesma instância, e um contador de MÓDULO
    // misturaria o roteiro de um usuário com a troca de atividade de
    // outro -- erro que apareceria como "as chamadas não batem com a
    // fatura", sem pista de onde veio.
    const a = contadorDePlaces();
    const b = contadorDePlaces();
    assert.equal(a.chamadas, 0);
    a.chamadas += 3;
    assert.equal(b.chamadas, 0);
    assert.notStrictEqual(a, b);
  });
});

describe('nunca derruba quem chamou', () => {
  test('variável de ambiente faltando avisa e segue', async () => {
    // O `classify-conflicts` sobe hoje com duas variáveis só. Se a
    // configuração do Cloud Run não ganhar as novas, o serviço continua
    // servindo e o log diz por que o número não aparece.
    delete process.env.SUPABASE_URL;
    const gravou = await registrarEvento({ tipo: 'emenda_restricao' });
    assert.equal(gravou, false);
    assert.equal(chamadas.length, 0);
    assert.ok(avisos.some((a) => a.includes('SUPABASE_URL')));
  });

  test('PostgREST recusando não estoura', async () => {
    fingirFetch({ ok: false, status: 401, text: async () => 'sem permissao' });
    const gravou = await registrarEvento({ tipo: 'geracao_roteiro' });
    assert.equal(gravou, false);
    assert.ok(avisos.some((a) => a.includes('401')));
  });

  test('rede caída não estoura', async () => {
    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    const gravou = await registrarEvento({ tipo: 'geracao_roteiro' });
    assert.equal(gravou, false);
    assert.ok(avisos.some((a) => a.includes('ECONNREFUSED')));
  });

  test('corpo ilegível na resposta de erro também não estoura', async () => {
    fingirFetch({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('corpo quebrado');
      },
    });
    assert.equal(await registrarEvento({ tipo: 'geracao_roteiro' }), false);
  });
});
