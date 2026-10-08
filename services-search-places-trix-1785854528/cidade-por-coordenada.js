// A cidade de uma coordenada, para o "Usar minha localização atual" do
// app (08/10).
//
// Quem converte é o Google (Geocoding, reverso), nunca o modelo: a regra
// da casa é que geolocalização é do Google. O app manda a coordenada já
// arredondada a duas casas (~1 km) e recebe só o nome da cidade, no
// mesmo formato que a busca de lugares devolve ("São Paulo, SP,
// Brasil"). A coordenada não é gravada em lugar nenhum, nem no log.
//
// Puro, sem rede, para o `npm test` travar a leitura. Quem faz o fetch é
// o `index.js`.

'use strict';

/// A coordenada do pedido, validada. `null` quando não é um par de
/// números dentro do globo. Arredonda de novo aqui, a duas casas: o app
/// já manda assim, e o servidor não confia nisso.
function lerCoordenada(texto) {
  const partes = String(texto ?? '').split(',');
  if (partes.length !== 2) return null;
  const [lat, lng] = partes.map((p) => Number(p.trim()));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const duas = (n) => Math.round(n * 100) / 100;
  return { lat: duas(lat), lng: duas(lng) };
}

/// A URL do Geocoding reverso, só com os tipos que são cidade.
function montarUrlDoReverso({ lat, lng }, lang, apiKey) {
  return 'https://maps.googleapis.com/maps/api/geocode/json' +
    `?latlng=${lat},${lng}` +
    '&result_type=locality|administrative_area_level_2' +
    `&language=${encodeURIComponent(lang)}` +
    `&key=${apiKey}`;
}

/// "Cidade, UF, País" no Brasil, "Cidade, País" fora -- a mesma forma
/// que o passo das cidades usa (`suggest-cities`, desde 07/10). `null`
/// quando o Google não devolve cidade (mar, área sem município).
function cidadeDoResultado(dados) {
  if (dados?.status !== 'OK' || !Array.isArray(dados.results)) return null;
  const resultado =
    dados.results.find((r) => (r.types ?? []).includes('locality')) ??
    dados.results[0];
  const partes = resultado?.address_components ?? [];
  const de = (tipo) => partes.find((c) => (c.types ?? []).includes(tipo));

  const cidade = de('locality') ?? de('administrative_area_level_2');
  const pais = de('country');
  if (!cidade?.long_name) return null;

  const estado = de('administrative_area_level_1');
  const noBrasil = pais?.short_name === 'BR';
  const texto = [
    cidade.long_name,
    noBrasil ? estado?.short_name : null,
    pais?.long_name,
  ].filter(Boolean).join(', ');

  return { cidade: cidade.long_name, texto };
}

module.exports = { lerCoordenada, montarUrlDoReverso, cidadeDoResultado };
