// Testes da parte pura da classificação.
//
// Nenhum toca a rede: o que precisa ficar travado aqui é a CONFERÊNCIA da
// resposta, porque a substituição no app acontece por posição — um id
// inventado pelo modelo mexeria na atividade errada do roteiro.
//
// O prompt também é testado, mas de forma deliberadamente frouxa: fixar o
// texto inteiro tornaria qualquer ajuste de redação um teste vermelho, e
// aí o teste passa a atrapalhar. O que se verifica é que as três coisas
// que NÃO podem sair dele continuam lá.

const { test } = require('node:test');
const assert = require('node:assert');

const { montarPrompt, conferirResposta } = require('./classificar');

const ITENS = [
  { id: 'a0', place: 'Pizzaria Bráz', description: 'Pizza napolitana' },
  { id: 'a1', place: 'Mirante Dona Marta', description: 'Vista da cidade' },
  { id: 'b0', place: 'Confeitaria Colombo', description: 'Café histórico' },
];

// =====================================================================
// CONFERÊNCIA DA RESPOSTA
// =====================================================================

test('aceita os ids que mandamos', () => {
  const { conflitos, descartados } = conferirResposta(
    { conflicts: [{ id: 'a0', reason: 'pizzeria, wheat dough' }] },
    ITENS,
  );
  assert.deepStrictEqual(conflitos, [{ id: 'a0', reason: 'pizzeria, wheat dough' }]);
  assert.deepStrictEqual(descartados, []);
});

test('DESCARTA id que não estava na lista enviada', () => {
  // É o caso perigoso: o app substitui por posição, então um id inventado
  // mexeria na atividade errada.
  const { conflitos, descartados } = conferirResposta(
    { conflicts: [{ id: 'a0', reason: 'ok' }, { id: 'z9', reason: 'inventado' }] },
    ITENS,
  );
  assert.deepStrictEqual(conflitos.map((c) => c.id), ['a0']);
  assert.strictEqual(descartados.length, 1);
  assert.match(descartados[0], /z9/);
});

test('descarta id repetido, mantendo a primeira ocorrência', () => {
  const { conflitos, descartados } = conferirResposta(
    { conflicts: [{ id: 'b0', reason: 'primeira' }, { id: 'b0', reason: 'segunda' }] },
    ITENS,
  );
  assert.deepStrictEqual(conflitos, [{ id: 'b0', reason: 'primeira' }]);
  assert.strictEqual(descartados.length, 1);
  assert.match(descartados[0], /repetido/);
});

test('lista vazia é resposta válida: nada conflita', () => {
  const { conflitos, descartados } = conferirResposta({ conflicts: [] }, ITENS);
  assert.deepStrictEqual(conflitos, []);
  assert.deepStrictEqual(descartados, []);
});

test('resposta inutilizável vira lista vazia, nunca exceção', () => {
  // O caminho seguro é "nada a fazer". Explodir aqui derrubaria a emenda
  // inteira por causa de uma resposta malformada.
  for (const bruto of [null, undefined, {}, { conflicts: null }, { conflicts: 'x' }, []]) {
    const { conflitos } = conferirResposta(bruto, ITENS);
    assert.deepStrictEqual(conflitos, [], `falhou para ${JSON.stringify(bruto)}`);
  }
});

test('item sem id é descartado, não vira id vazio', () => {
  const { conflitos, descartados } = conferirResposta(
    { conflicts: [{ reason: 'sem id' }, { id: '', reason: 'id vazio' }] },
    ITENS,
  );
  assert.deepStrictEqual(conflitos, []);
  assert.strictEqual(descartados.length, 2);
});

test('reason ausente não derruba o conflito, só vem vazia', () => {
  // O motivo é para o log e para a tela. Perdê-lo é ruim; perder o
  // conflito por causa dele seria pior.
  const { conflitos } = conferirResposta({ conflicts: [{ id: 'a0' }] }, ITENS);
  assert.deepStrictEqual(conflitos, [{ id: 'a0', reason: '' }]);
});

test('reason gigante é truncada, não rejeitada', () => {
  const { conflitos } = conferirResposta(
    { conflicts: [{ id: 'a0', reason: 'x'.repeat(500) }] },
    ITENS,
  );
  assert.strictEqual(conflitos.length, 1);
  assert.strictEqual(conflitos[0].reason.length, 120);
});

test('id numérico do modelo casa com id string nosso', () => {
  // JSON.parse devolve número se o modelo escrever 0 em vez de "0".
  const itens = [{ id: '0', place: 'Pizzaria' }];
  const { conflitos } = conferirResposta({ conflicts: [{ id: 0, reason: 'ok' }] }, itens);
  assert.deepStrictEqual(conflitos, [{ id: '0', reason: 'ok' }]);
});

// =====================================================================
// O PROMPT
//
// Frouxo de propósito: só o que não pode sair dele.
// =====================================================================

test('o prompt leva a restrição e todos os ids', () => {
  const p = montarPrompt('gluten_free', ITENS);
  assert.match(p, /gluten_free/);
  for (const i of ITENS) {
    assert.ok(p.includes(`id=${i.id}`), `falta id=${i.id}`);
    assert.ok(p.includes(i.place), `falta ${i.place}`);
  }
});

test('o prompt proíbe certificar o que acomoda', () => {
  // É o limite duro do escopo: o modelo não sabe se um restaurante tem
  // opção sem glúten, e prometer isso é alucinação com consequência de
  // saúde. Se esta instrução sair do prompt, o contrato mudou.
  const p = montarPrompt('gluten_free', ITENS);
  assert.match(p, /NEVER assume a place accommodates/i);
});

test('o prompt manda não sinalizar na dúvida', () => {
  const p = montarPrompt('gluten_free', ITENS);
  assert.match(p, /WHEN IN DOUBT, DO NOT flag/i);
});

test('o prompt exclui atividade que não é de comida', () => {
  const p = montarPrompt('gluten_free', ITENS);
  assert.match(p, /museums, parks, hikes/i);
});

test('item sem description não quebra o prompt', () => {
  const p = montarPrompt('vegan', [{ id: 'a0', place: 'Churrascaria' }]);
  assert.match(p, /id=a0 \| Churrascaria/);
});
