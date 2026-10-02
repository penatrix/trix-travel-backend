// A ida e volta da origem: o modelo dá o meio e o valor POR PESSOA, e a
// conta pelo grupo é feita aqui.
//
// Medido em 02/10, nos 35 roteiros mais recentes com `cost_breakdown`: o
// `flights` vinha como número redondo que não acompanhava o grupo. R$ 2.500
// para 1 viajante (335) e para 2 (333); R$ 2.400 para duas pessoas até
// Fortaleza (276), menos que um voo por pessoa. O prompt dizia "for the
// whole group", e o modelo não multiplicava. É a regra 4 do CLAUDE.md --
// preço por pessoa e preço total não se misturam -- só que a conta passa a
// ser do código, que não erra multiplicação.
//
// O total sobe ou desce pela DIFERENÇA, como a troca de lugar fechado faz
// em `validar-lugares.js`: recalcular a soma das cinco linhas brigaria com
// o que o modelo pôs nas outras quatro.
//
// Sem `origin_transfer` (roteiro sem cidade de origem, ou modelo que não
// mandou o objeto), nada muda.

'use strict';

const MEIOS = ['flight', 'train', 'bus', 'car', 'ferry'];

/// Inteiro positivo de um número ou de uma string só com dígitos
/// ("1500", "1.500"). Qualquer outra coisa é `null`: melhor manter o que o
/// modelo pôs no `flights` do que multiplicar um número mal lido.
function inteiroPositivo(valor) {
  let n = null;
  if (typeof valor === 'number') n = valor;
  else if (typeof valor === 'string' && /^\s*\d{1,3}([.,]?\d{3})*\s*$/.test(valor)) {
    n = Number(valor.replace(/[.,\s]/g, ''));
  }
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/// Ajusta `cost_breakdown.flights` para `per_person_brl × viajantes` e o
/// `estimated_cost_brl` pela diferença. Muda o roteiro no lugar.
///
/// Devolve `{ modo, de, para }` quando há `origin_transfer`, e `null`
/// quando não há -- é o que o handler escreve no log.
function normalizarPassagem(roteiro, viajantes) {
  const origem = roteiro?.origin_transfer;
  if (!origem || typeof origem !== 'object' || Array.isArray(origem)) return null;

  // Meio fora da lista sai do JSON: a tela traduz o valor, e texto solto
  // apareceria como veio.
  const modo = typeof origem.mode === 'string' ? origem.mode.trim().toLowerCase() : '';
  if (MEIOS.includes(modo)) {
    origem.mode = modo;
  } else {
    delete origem.mode;
  }

  const porPessoa = inteiroPositivo(origem.per_person_brl);
  const n = Number.isInteger(viajantes) && viajantes > 0 ? viajantes : 1;
  const bd = roteiro.cost_breakdown;
  if (porPessoa == null || !bd || typeof bd !== 'object' || Array.isArray(bd)) {
    return { modo: origem.mode ?? null, de: null, para: null };
  }

  const antes = Number(bd.flights);
  const de = Number.isFinite(antes) ? antes : 0;
  const para = porPessoa * n;
  bd.flights = para;
  origem.per_person_brl = porPessoa;

  const total = Number(roteiro.estimated_cost_brl);
  if (Number.isFinite(total)) {
    roteiro.estimated_cost_brl = Math.max(0, Math.round(total + (para - de)));
  }
  return { modo: origem.mode ?? null, de, para };
}

module.exports = { normalizarPassagem, MEIOS };
