// A página do parceiro existe? (05/11)
//
// O app monta o endereço de cada parceiro a partir do roteiro: o eSIM do
// país na Airalo (`/czech-republic-esim`), o guarda-volumes da cidade na
// Radical Storage (`/storage-list/prague`), o transfer da cidade na
// Kiwitaxi (`/en/portugal/lisbon`). O nome em inglês vem do
// modelo (`country_slug`, `city_slug`), e o da Airalo nem sempre bate
// ("czechia" no roteiro, "czech-republic" na Airalo). Link para página que
// não existe é pior que nenhum link, como na Tiqets (`ingressos.js`):
// então o endereço só vai para a tela depois de conferido aqui.
//
// A conferência é a mais simples que diz "a página existe": 200 direto,
// ou um redirecionamento para outra página do MESMO parceiro que não seja
// a inicial. Só os parceiros desta lista; qualquer outro endereço volta
// "não existe" sem ser buscado, porque a URL deste serviço é pública.
//
// O resultado fica em `paginas_conferidas` (scripts/p6.1 no app), 30 dias
// com página e 14 sem.

const AGENTE = 'Mozilla/5.0 (compatible; TrixTravel/1.0; +https://trix.travel)';
const DIAS_COM_PAGINA = 30;
const DIAS_SEM_PAGINA = 14;

// Os parceiros e o caminho de página que se aceita de cada um.
const PARCEIROS = {
  'www.airalo.com': /^\/[a-z0-9-]+-esim\/?$/,
  'radicalstorage.com': /^\/storage-list\/[a-z0-9-]+\/?$/,
  // A página de transfer da cidade (`/en/portugal/lisbon`). Cidade sem
  // página redireciona para `/en/search-results`, que não passa aqui.
  'kiwitaxi.com': /^\/en\/[a-z0-9-]+\/[a-z0-9-]+\/?$/,
};

/// O endereço é de um parceiro conhecido, com caminho de página?
function enderecoAceito(url) {
  try {
    const u = new URL(url);
    const caminho = PARCEIROS[u.host];
    return u.protocol === 'https:' && !!caminho && caminho.test(u.pathname);
  } catch {
    return false;
  }
}

/// A página existe? `true` ou `false`, e LANÇA quando não deu para saber
/// (rede, tempo, 5xx, 429): falha não se grava.
async function conferirPagina(url, { tetoMs = 6000, fetchFn = fetch } = {}) {
  if (!enderecoAceito(url)) return false;
  let atual = url;
  for (let salto = 0; salto < 3; salto++) {
    const controlador = new AbortController();
    const alarme = setTimeout(() => controlador.abort(), tetoMs);
    let resposta;
    try {
      resposta = await fetchFn(atual, {
        redirect: 'manual',
        headers: { 'User-Agent': AGENTE, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
        signal: controlador.signal,
      });
    } finally {
      clearTimeout(alarme);
    }
    if (resposta.status >= 500 || resposta.status === 429) {
      throw new Error(`Parceiro respondeu ${resposta.status}.`);
    }
    if (resposta.status === 200) return true;
    if (resposta.status >= 300 && resposta.status < 400) {
      const destino = resposta.headers.get('location');
      if (!destino) return false;
      const proximo = new URL(destino, atual);
      // Redirecionar para a inicial, para uma busca ou para fora do
      // parceiro é o jeito educado de dizer "não existe": o destino tem de
      // ser também uma página aceita, do mesmo parceiro.
      if (proximo.host !== new URL(url).host || !enderecoAceito(proximo.toString())) return false;
      atual = proximo.toString();
      continue;
    }
    return false;
  }
  return false;
}

function linhaAindaVale(linha, agora = Date.now()) {
  if (!linha?.conferido_em) return false;
  const dias = linha.existe ? DIAS_COM_PAGINA : DIAS_SEM_PAGINA;
  return agora - Date.parse(linha.conferido_em) < dias * 24 * 3600 * 1000;
}

function linhaDaPagina(url, existe) {
  return { url, existe, conferido_em: new Date().toISOString() };
}

module.exports = { enderecoAceito, conferirPagina, linhaAindaVale, linhaDaPagina };
