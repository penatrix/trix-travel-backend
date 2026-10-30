// A diária que veio com o valor da estadia inteira (30/10).
//
// Relato do Lucas no roteiro 543 (Serra Gaúcha, 7 dias): "a previsão está
// considerando apenas 1 dia de hotel". O modelo escreveu em
// `estimated_cost_per_night` o valor da estadia em cada cidade ("BRL 4000
// no total" para 6 noites em Gramado), e o `cost_breakdown.accommodation`
// (4.600) era a soma dessas estadias. A tela multiplica a diária pelas
// noites, como deve: 6 × R$ 4.000 em Gramado, contra 4.600 no total.
//
// Medido em 30/10, nos 40 roteiros prontos mais recentes: o normal é a
// linha `accommodation` dar as diárias vezes as noites. Só o 543 tinha a
// soma das diárias igual à linha com cidade de várias noites.
//
// O marcador do prompt em português é "no total" (quarto inteiro, não por
// pessoa), e "no total" também se lê como "a estadia toda". O prompt
// passou a dizer "UMA noite"; isto aqui é a rede para quando ele não ouvir.
//
// A conta das noites é a do app (`hospedagemPorDestino`): os dias de cada
// cidade, e o último dia do roteiro não paga diária.

'use strict';

/// O primeiro número de um texto de custo ("BRL 4.000 no total" -> 4000).
function valorDoCusto(texto) {
  if (typeof texto === 'number') return texto > 0 ? texto : null;
  if (typeof texto !== 'string') return null;
  const achado = texto.match(/\d{1,3}(?:[.,]\d{3})+|\d+/);
  if (!achado) return null;
  const n = Number(achado[0].replace(/[.,]/g, ''));
  return n > 0 ? n : null;
}

/// O mesmo texto, com o número trocado: o "BRL" e o marcador ficam.
function trocarValor(texto, novo) {
  if (typeof texto !== 'string') return `BRL ${novo}`;
  return texto.replace(/\d{1,3}(?:[.,]\d{3})+|\d+/, String(novo));
}

/// As noites de cada destino, como o app conta.
function noitesPorDestino(destinos) {
  return destinos.map((d, i) => {
    const dias = Math.max(0, Math.round(Number(d?.days) || 0));
    return i === destinos.length - 1 ? Math.max(0, dias - 1) : dias;
  });
}

const perto = (a, b, tolerancia) => Math.abs(a - b) <= tolerancia * b;

/// Divide pelas noites a diária que veio com a estadia. Muda o roteiro no
/// lugar. Devolve `{ de, para }` quando corrigiu, e `null` quando não é o
/// caso -- é o que o handler escreve no log.
function corrigirDiariaDaEstadia(roteiro) {
  const destinos = Array.isArray(roteiro?.destinations) ? roteiro.destinations : [];
  const hospedagem = valorDoCusto(roteiro?.cost_breakdown?.accommodation);
  if (!hospedagem || destinos.length === 0) return null;

  const diarias = destinos.map((d) => valorDoCusto(d?.accommodation?.estimated_cost_per_night));
  if (diarias.some((v) => v === null)) return null;
  const noites = noitesPorDestino(destinos);
  if (!noites.some((n) => n > 1)) return null;

  const somaDasDiarias = diarias.reduce((a, b) => a + b, 0);
  const somaDasEstadias = diarias.reduce((a, v, i) => a + v * noites[i], 0);
  // O padrão do erro: as diárias somadas fecham com a hospedagem, e as
  // diárias vezes as noites não.
  if (!perto(somaDasDiarias, hospedagem, 0.05)) return null;
  if (perto(somaDasEstadias, hospedagem, 0.15)) return null;

  const para = diarias.map((v, i) => (noites[i] > 1 ? Math.round(v / noites[i] / 10) * 10 : v));
  destinos.forEach((d, i) => {
    if (para[i] !== diarias[i]) {
      d.accommodation.estimated_cost_per_night = trocarValor(
        d.accommodation.estimated_cost_per_night,
        para[i],
      );
    }
  });
  return { de: diarias, para };
}

module.exports = { corrigirDiariaDaEstadia, valorDoCusto, noitesPorDestino };
