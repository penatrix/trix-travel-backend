// Uma pergunta só ao Google: este lugar está fechado?
//
// =====================================================================
// POR QUE NÃO REUSAR O validar-lugares.js DO generate-trip
// =====================================================================
//
// Foi a primeira ideia e tem um problema de build. O contexto do `pack`
// é a PASTA do serviço (`dir:` + `--path=.`), então nada de fora dela
// entra na imagem. Compartilhar exigiria um passo de cópia no
// cloudbuild - o próprio CLAUDE.md do repositório documenta isso.
//
// O passo de cópia traz dois problemas piores que a duplicação:
//
// 1. A dependência fica invisível. Quem abre esta pasta não vê que ela
//    depende de um arquivo de outra, e renomear lá quebra aqui.
// 2. Não existe .gitignore neste repositório. Uma cópia commitada por
//    engano passaria a sombrear a cópia do build, e voltaríamos à
//    pergunta "qual cópia é a fonte da verdade" - exatamente o que a
//    limpeza de 01/09 matou.
//
// Então isto NÃO é uma cópia daquele módulo: é a necessidade estreita
// deste serviço. Lá, `consultarLugar` também resolve `place_id` e nome
// do Google para alimentar a passada de horário; aqui só interessa
// aberto ou fechado.
//
// O que fica de dívida: o conjunto FECHADO existe em dois lugares. Se o
// Google acrescentar um status novo, os dois precisam mudar. Nomeado
// igual nos dois arquivos de propósito, para um grep achar os dois.
// =====================================================================

// Mesmo nome e mesmo conteúdo do conjunto em
// services-generate-trip-trix-*/validar-lugares.js. Mudou um, mude o outro.
const FECHADO = new Set(['CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY']);

const TIMEOUT_PADRAO_MS = 8000;

/**
 * Devolve um veredito sobre o lugar. NUNCA lança: falha de rede, chave
 * ausente ou resposta estranha viram 'erro' ou 'nao_encontrado', e quem
 * chama decide. Derrubar uma sugestão boa por falha de infraestrutura
 * seria pior que não checar.
 *
 * vereditos: 'aberto' | 'fechado' | 'nao_encontrado' | 'erro'
 */
async function verificarStatus(textoBusca, apiKey, tetoMs = TIMEOUT_PADRAO_MS) {
  if (!apiKey) return { veredito: 'erro', motivo: 'GOOGLE_MAPS_KEY ausente' };
  if (!textoBusca || !textoBusca.trim()) {
    return { veredito: 'erro', motivo: 'maps_search_query vazio' };
  }

  const url =
    'https://maps.googleapis.com/maps/api/place/textsearch/json' +
    `?query=${encodeURIComponent(textoBusca)}&key=${apiKey}`;

  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), tetoMs);

  try {
    const resposta = await fetch(url, { signal: controlador.signal });
    if (!resposta.ok) return { veredito: 'erro', motivo: `HTTP ${resposta.status}` };

    const dados = await resposta.json();

    // O Google não achou nada com essa string. Pode ser lugar inventado
    // pelo modelo ou só uma busca ruim. Não é 'fechado': falso positivo
    // aqui descartaria sugestão boa, e o usuário paga a espera de outra.
    if (dados.status === 'ZERO_RESULTS') return { veredito: 'nao_encontrado' };
    if (dados.status !== 'OK') return { veredito: 'erro', motivo: dados.status };

    const primeiro = dados.results?.[0];
    if (!primeiro) return { veredito: 'nao_encontrado' };

    const status = primeiro.business_status;

    // Ausência de business_status é comum em praça, mirante, praia - o que
    // não é estabelecimento comercial. Ausência não é fechamento.
    if (!status) return { veredito: 'aberto', semStatus: true };

    return {
      veredito: FECHADO.has(status) ? 'fechado' : 'aberto',
      status,
      nomeGoogle: primeiro.name,
    };
  } catch (erro) {
    return {
      veredito: 'erro',
      motivo: erro.name === 'AbortError' ? 'timeout' : erro.message,
    };
  } finally {
    clearTimeout(alarme);
  }
}

module.exports = { verificarStatus, FECHADO, TIMEOUT_PADRAO_MS };
