// Testes do prompt da troca de atividade, agora montado no backend.
//
// O `prompt-da-troca.regressao.json` guarda o prompt que o app montava
// (`buildMicroActivityPrompt`, no `custom_functions.dart`) para três
// conjuntos de parâmetros. Foi gerado a partir do template do Dart em
// 28/09, na véspera de ele sair do app, e é o que prova que a mudança de
// casa não mudou uma vírgula do que o Gemini recebe. Quando alguém
// MELHORAR o prompt, este teste falha -- e é para falhar: o arquivo se
// regenera junto, numa mudança que diz que o prompt mudou.
//
// Não precisa do `pretest`: o módulo não depende de nada copiado.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  montarPromptDaTroca,
  lerParametros,
  listaDeEvitar,
  MAX_EVITAR,
  MAX_PEDIDO,
} = require('./prompt-da-troca');

const casos = require('./prompt-da-troca.regressao.json');

test('o prompt é o mesmo que o app montava', () => {
  assert.ok(casos.length >= 3);
  for (const { params, esperado } of casos) {
    assert.strictEqual(
      montarPromptDaTroca(lerParametros(params)),
      esperado,
      `divergiu para ${params.cidade} / ${params.period}`,
    );
  }
});

test('sem cidade ou sem período não há prompt', () => {
  assert.strictEqual(lerParametros({ period: 'tarde' }), null);
  assert.strictEqual(lerParametros({ cidade: 'Lisboa' }), null);
  assert.strictEqual(lerParametros({ cidade: '  ', period: 'tarde' }), null);
  assert.strictEqual(lerParametros(undefined), null);
  // O corpo do app antigo: só o texto pronto. Não é parâmetro, e o
  // handler decide o que fazer com ele.
  assert.strictEqual(lerParametros({ promptText: 'x', period: 'tarde' }), null);
});

test('idioma desconhecido cai em inglês, como no app', () => {
  const p = lerParametros({ cidade: 'Lisboa', period: 'tarde', idioma: 'es' });
  assert.strictEqual(p.idioma, 'en');
  assert.match(montarPromptDaTroca(p), /exclusively in ENGLISH/);
});

test('a lista do que evitar aceita texto juntado ou lista', () => {
  assert.strictEqual(listaDeEvitar('Zwinger, Frauenkirche'), 'Zwinger, Frauenkirche');
  assert.strictEqual(listaDeEvitar(['Zwinger', ' ', 'Frauenkirche ']), 'Zwinger, Frauenkirche');
  assert.strictEqual(listaDeEvitar(null), '');
  assert.strictEqual(listaDeEvitar(42), '');
});

test('lista vazia vira "None" no prompt', () => {
  const p = montarPromptDaTroca(lerParametros({ cidade: 'Lisboa', period: 'tarde', evitar: [] }));
  assert.match(p, /rejected them: \*\*None\*\*/);
});

test('corpo forjado não vira prompt gigante', () => {
  const muitos = Array.from({ length: MAX_EVITAR + 50 }, (_, i) => `Lugar ${i}`);
  assert.strictEqual(listaDeEvitar(muitos).split(', ').length, MAX_EVITAR);

  const longo = 'a'.repeat(MAX_PEDIDO * 4);
  const p = lerParametros({ cidade: 'Lisboa', period: 'tarde', pedido: longo });
  assert.strictEqual(p.pedido.length, MAX_PEDIDO);
});

test('o pedido do usuário vai na instrução; sem pedido, a surpresa', () => {
  const com = montarPromptDaTroca(lerParametros({ cidade: 'Lisboa', period: 'tarde', pedido: 'vinho' }));
  assert.match(com, /specifically asked for: "vinho"/);
  const sem = montarPromptDaTroca(lerParametros({ cidade: 'Lisboa', period: 'tarde', pedido: '   ' }));
  assert.match(sem, /Surprise the user/);
});

test('o handler monta o prompt aqui e marca o caminho legado', () => {
  // Varredura do fonte, porque o handler carrega o cliente do Supabase na
  // importação e não roda sem ele. O que importa travar é a ordem: os
  // parâmetros ganham do texto pronto, e o evento diz qual veio.
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(fonte, /const parametros = lerParametros\(req\.body\);/);
  assert.match(fonte, /parametros \? montarPromptDaTroca\(parametros\) : legado/);
  assert.match(fonte, /prompt: origemDoPrompt/);
});
