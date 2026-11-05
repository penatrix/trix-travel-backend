// O lugar está à venda na Tiqets, e na cidade certa? (05/11)
//
// O app mostra "Ingressos na Tiqets" ao lado do "Pede reserva". A
// primeira versão abria a busca da Tiqets pelo nome do lugar, e quando a
// Tiqets não vende o lugar a busca devolve atrações do mundo inteiro: a
// Villa Müller, em Praga, abriu um ferry em Cancún. Link errado é pior
// que nenhum, então o botão só aparece com o endereço conferido aqui,
// como o lugar fechado só não aparece porque o Places conferiu antes.
//
// A conferência, medida em 05/11:
//   1. a busca pelo nome (`/pt/search?q=`) responde 302 direto para a
//      página do lugar quando a Tiqets o vende ("Castelo de Praga",
//      "Rijksmuseum", "Museu Nacional de Arte Antiga"); quando não vende,
//      responde 200 com uma lista genérica ("Villa Müller");
//   2. a página do lugar traz a cidade no `BOOTSTRAP_DATA`, em inglês e
//      em português ("Prague" e "Praga"). Ela tem de ser a do roteiro:
//      "Museu Nacional" existe em muitas cidades.
//
// Nada disso é API documentada. Se a Tiqets mudar o site, a conferência
// volta "não vende" e o botão some: nunca mostra coisa errada.
//
// O resultado fica em `ingressos_conferidos` (scripts/p6.0 no app), como
// a foto: a primeira pessoa que abre um roteiro com o Louvre paga a
// conferência, e as outras só leem.

const TIQETS = 'https://www.tiqets.com';
const AGENTE = 'Mozilla/5.0 (compatible; TrixTravel/1.0; +https://trix.travel)';

// Quanto vale o que foi conferido. Lugar à venda muda pouco; o que não
// vendia pode entrar no catálogo.
const DIAS_COM_PAGINA = 30;
const DIAS_SEM_PAGINA = 14;

/// Sem acento, minúsculo, um espaço só. O mesmo `normalizarNome` do app.
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function chaveDoIngresso({ lugar, cidade }) {
  return `tiqets|${normalizar(lugar)}|${normalizar(cidade)}`;
}

/// A página de um lugar na Tiqets: `/pt/<slug>-l<número>/`.
function ehPaginaDeLugar(url) {
  try {
    const u = new URL(url, TIQETS);
    return u.origin === TIQETS && /^\/pt\/[a-z0-9-]+-l\d+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

/// A cidade da página, em inglês e em português, do `BOOTSTRAP_DATA`.
function cidadeDaPagina(html) {
  const m = /BOOTSTRAP_DATA\s*=\s*\{\s*"city"\s*:\s*\{([^}]*)\}/.exec(html ?? '');
  if (!m) return null;
  const campo = (nome) => {
    const c = new RegExp(`"${nome}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(m[1]);
    if (!c) return '';
    try {
      return JSON.parse(c[1]);
    } catch {
      return '';
    }
  };
  const nome = campo('name');
  const ingles = campo('admin_name');
  return nome || ingles ? { nome, ingles } : null;
}

/// A cidade do roteiro é a da página? "Praga" bate com "Praga" ou
/// "Prague"; "Lisboa" com "Lisboa" ou "Lisbon".
function mesmaCidade(cidadeDoRoteiro, daPagina) {
  const alvo = normalizar(cidadeDoRoteiro);
  if (!alvo || !daPagina) return false;
  return [daPagina.nome, daPagina.ingles]
    .map(normalizar)
    .filter(Boolean)
    .some((c) => c === alvo);
}

async function buscarComTeto(url, opcoes, tetoMs, fetchFn) {
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), tetoMs);
  try {
    return await fetchFn(url, {
      ...opcoes,
      headers: { 'User-Agent': AGENTE, 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: controlador.signal,
    });
  } finally {
    clearTimeout(alarme);
  }
}

/// Confere um lugar. Devolve `{url, cidade}` quando a Tiqets vende o
/// lugar naquela cidade, `null` quando não vende, e LANÇA quando não deu
/// para saber (rede, tempo): falha não se grava, para não esconder o
/// botão por um mês por causa de um soluço.
async function conferirNaTiqets({ lugar, cidade }, { tetoMs = 6000, fetchFn = fetch } = {}) {
  if (!normalizar(lugar) || !normalizar(cidade)) return null;
  const busca = `${TIQETS}/pt/search?q=${encodeURIComponent(lugar.trim())}`;
  const resposta = await buscarComTeto(busca, { redirect: 'manual' }, tetoMs, fetchFn);
  if (resposta.status >= 500) throw new Error(`Tiqets respondeu ${resposta.status}.`);
  const destino = resposta.headers.get('location');
  if (!(resposta.status >= 300 && resposta.status < 400) || !destino) return null;
  if (!ehPaginaDeLugar(destino)) return null;

  const url = new URL(destino, TIQETS).toString();
  const pagina = await buscarComTeto(url, {}, tetoMs, fetchFn);
  if (pagina.status >= 500) throw new Error(`Tiqets respondeu ${pagina.status}.`);
  if (!pagina.ok) return null;
  const daPagina = cidadeDaPagina(await pagina.text());
  if (!mesmaCidade(cidade, daPagina)) return null;
  return { url, cidade: daPagina.nome || daPagina.ingles };
}

/// A linha guardada ainda vale?
function linhaAindaVale(linha, agora = Date.now()) {
  if (!linha?.conferido_em) return false;
  const dias = linha.url ? DIAS_COM_PAGINA : DIAS_SEM_PAGINA;
  return agora - Date.parse(linha.conferido_em) < dias * 24 * 3600 * 1000;
}

function linhaDoIngresso({ lugar, cidade }, achado) {
  return {
    chave: chaveDoIngresso({ lugar, cidade }),
    parceiro: 'tiqets',
    lugar,
    cidade,
    url: achado?.url ?? null,
    cidade_da_pagina: achado?.cidade ?? null,
    conferido_em: new Date().toISOString(),
  };
}

/// O que vai para o app: o endereço conferido, ou null.
function paraOApp(linha) {
  return linha?.url ? { url: linha.url } : null;
}

module.exports = {
  normalizar,
  chaveDoIngresso,
  ehPaginaDeLugar,
  cidadeDaPagina,
  mesmaCidade,
  conferirNaTiqets,
  linhaAindaVale,
  linhaDoIngresso,
  paraOApp,
};
