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
//      "Museu Nacional" existe em muitas cidades. Ou, quando o lugar fica
//      na vizinha (a Lindt Home of Chocolate é de Kilchberg, ao lado de
//      Zurique), algum produto vendido na página tem de citar a cidade do
//      roteiro ("Zurique: Visita guiada à Cidade Velha + ... Lindt").
//      Medido em 05/11: o Castelo de Praga pedido para Viena e o Museu
//      Nacional de Arte Antiga pedido para o Porto não passam.
//
// O nome que o roteiro escreve nem sempre é o da Tiqets: "Palácio Ducal
// (Palazzo Ducale)" só cai na página como "Palácio Ducal". Então se
// tenta o nome inteiro, o nome sem o parêntese e o que está dentro dele,
// e cada tentativa passa pela mesma conferência.
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

/// Os nomes dos produtos vendidos na página do lugar.
function produtosDaPagina(html) {
  const nomes = [];
  const padroes = [
    /"@type"\s*:\s*"Product"[^{}]*?"name"\s*:\s*("(?:[^"\\]|\\.)*")/g,
    /"location"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*"name"\s*:\s*("(?:[^"\\]|\\.)*")/g,
  ];
  for (const padrao of padroes) {
    for (const m of (html ?? '').matchAll(padrao)) {
      try {
        nomes.push(JSON.parse(m[1]));
      } catch {
        // nome com escape que o JSON não lê: fica de fora
      }
    }
  }
  return nomes;
}

/// Algum produto da página cita a cidade do roteiro, como palavra?
function cidadeNosProdutos(cidadeDoRoteiro, html) {
  const alvo = normalizar(cidadeDoRoteiro);
  if (!alvo) return false;
  return produtosDaPagina(html).some((nome) => ` ${normalizar(nome)} `.includes(` ${alvo} `));
}

/// Os nomes a tentar: o inteiro, sem o parêntese, e o de dentro dele.
function nomesATentar(lugar) {
  const inteiro = String(lugar ?? '').trim();
  const dentro = /\(([^)]+)\)/.exec(inteiro)?.[1]?.trim() ?? '';
  const fora = inteiro.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const vistos = new Set();
  return [inteiro, fora, dentro].filter((n) => {
    const k = normalizar(n);
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
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

/// Uma tentativa: o nome leva direto à página de um lugar na cidade?
async function tentarNome(nome, cidade, tetoMs, fetchFn) {
  const busca = `${TIQETS}/pt/search?q=${encodeURIComponent(nome)}`;
  const resposta = await buscarComTeto(busca, { redirect: 'manual' }, tetoMs, fetchFn);
  if (resposta.status >= 500) throw new Error(`Tiqets respondeu ${resposta.status}.`);
  const destino = resposta.headers.get('location');
  if (!(resposta.status >= 300 && resposta.status < 400) || !destino) return null;
  if (!ehPaginaDeLugar(destino)) return null;

  const url = new URL(destino, TIQETS).toString();
  const pagina = await buscarComTeto(url, {}, tetoMs, fetchFn);
  if (pagina.status >= 500) throw new Error(`Tiqets respondeu ${pagina.status}.`);
  if (!pagina.ok) return null;
  const html = await pagina.text();
  const daPagina = cidadeDaPagina(html);
  if (mesmaCidade(cidade, daPagina)) return { url, cidade: daPagina.nome || daPagina.ingles };
  if (cidadeNosProdutos(cidade, html)) return { url, cidade: daPagina?.nome || daPagina?.ingles || null };
  return null;
}

/// Confere um lugar. Devolve `{url, cidade}` quando a Tiqets vende o
/// lugar naquela cidade, `null` quando não vende, e LANÇA quando não deu
/// para saber (rede, tempo): falha não se grava, para não esconder o
/// botão por um mês por causa de um soluço.
async function conferirNaTiqets({ lugar, cidade }, { tetoMs = 6000, fetchFn = fetch } = {}) {
  if (!normalizar(lugar) || !normalizar(cidade)) return null;
  for (const nome of nomesATentar(lugar)) {
    const achado = await tentarNome(nome, cidade, tetoMs, fetchFn);
    if (achado) return achado;
  }
  return null;
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
  produtosDaPagina,
  cidadeNosProdutos,
  nomesATentar,
  conferirNaTiqets,
  linhaAindaVale,
  linhaDoIngresso,
  paraOApp,
};
