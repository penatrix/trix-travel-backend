// O refazer do roteiro: o pedido que o app grava e os parâmetros que ele
// vira na linha (09/10).
//
// O app grava em `trips.refazer_pedido`:
//
//   { origem: "Recife, PE, Brasil" | null,
//     cidades: [{ destination: "Lisboa, Portugal", days: 4 }, ...],
//     nota: "sem museus" }
//
// e o gatilho `trips_guarda_do_refazer` (scripts/p4.4 do app) já barrou
// quem não pode pedir e pedido fora do formato. Daqui sai o que muda na
// linha: as cidades (`planned_destinations`, no mesmo formato da
// criação), a origem, o fim das datas (o início fica: a pessoa pode ter
// escolhido a data) e o pedido especial, com a nota no fim.
//
// Puro, sem banco: é o que o teste exercita.

const MAX_DIAS = 30;
const MAX_CIDADES = 15;
const MAX_PEDIDO = 1000;

function textoLimpo(v, teto) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, teto);
}

/// O pedido como o backend confia nele, ou `null` quando não serve.
///
/// O gatilho já confere o formato; conferir de novo aqui é barato, e é o
/// que impede um pedido gravado pelo SQL Editor (que passa pelo gatilho
/// sem checagem) de virar um prompt quebrado.
function lerPedido(bruto) {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return null;
  if (!Array.isArray(bruto.cidades)) return null;
  const cidades = [];
  for (const c of bruto.cidades) {
    const destination = textoLimpo(c?.destination, 200);
    const days = Math.round(Number(c?.days));
    if (!destination || !Number.isFinite(days) || days < 1) return null;
    cidades.push({ destination, days });
  }
  if (cidades.length < 1 || cidades.length > MAX_CIDADES) return null;
  const total = cidades.reduce((s, c) => s + c.days, 0);
  if (total > MAX_DIAS) return null;
  return {
    origem: textoLimpo(bruto.origem, 200) || null,
    cidades,
    nota: textoLimpo(bruto.nota, MAX_PEDIDO),
  };
}

/// 'AAAA-MM-DD' + n dias, em UTC.
function somarDias(data, dias) {
  const m = String(data ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + dias));
  return t.toISOString().slice(0, 10);
}

/// O que muda na linha do roteiro.
///
/// A nota entra no FIM do pedido especial, separada por ponto: o que a
/// pessoa pediu na criação continua valendo, e o novo vem por último,
/// que é como o modelo lê prioridade.
function parametrosDoRefazer(linha, pedido) {
  const total = pedido.cidades.reduce((s, c) => s + c.days, 0);
  const anterior = textoLimpo(linha?.special_request, MAX_PEDIDO);
  const pedidoEspecial = pedido.nota
    ? (anterior ? `${anterior.replace(/[.\s]+$/, '')}. ${pedido.nota}` : pedido.nota).slice(0, MAX_PEDIDO)
    : (anterior || null);
  return {
    origin_city: pedido.origem,
    planned_destinations: pedido.cidades,
    end_date: somarDias(linha?.start_date, total - 1) ?? linha?.end_date ?? null,
    special_request: pedidoEspecial,
  };
}

/// A frase que vai para `refazer_erro`, e dali para a tela. Curta e sem
/// a exceção: o detalhe fica no log e na `eventos`.
function erroParaATela(lang) {
  return lang === 'pt'
    ? 'Não deu para refazer o roteiro agora. Ele ficou como estava, e você pode tentar de novo.'
    : 'We could not rebuild the itinerary right now. It stayed as it was, and you can try again.';
}

module.exports = { lerPedido, parametrosDoRefazer, somarDias, erroParaATela };
