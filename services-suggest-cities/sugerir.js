// A parte pura da sugestão de cidades: montar o pedido e conferir a
// resposta.
//
// Separada do index.js pelo mesmo motivo do classify-conflicts: é aqui
// que moram os erros que importam -- prompt frouxo e resposta malformada
// -- e é o que dá para exercitar sem rede.
//
// =====================================================================
// O QUE ESTE SERVIÇO FAZ (decisão do Paulo, 25/09)
//
// O passo 3 do wizard do app mostra as cidades do roteiro. Antes ele
// punha o destino da Home num cartão tal como veio -- "Itália" virava
// uma cidade chamada Itália. Agora pergunta ao Flash:
//
//   1. O destino é cidade ou lugar maior (país, estado, região)?
//   2. Cidade: ela fica sozinha. Lugar maior: até `max_cities` cidades
//      dele, com `days` como peso da repartição.
//   3. Mais 3 ou 4 cidades próximas, cada uma com o motivo em uma linha
//      -- a caixa "Adicionar Praga · a 2h15 de Dresden" do protótipo.
//
// Flash, e não Pro: é escolha curta dentro de um conjunto conhecido, com
// a pessoa parada olhando a tela. O `max_cities` quem calcula é o app
// (metade dos dias, piso de 2 por cidade) e o app refaz a conta de
// qualquer jeito -- o modelo recebe o teto para não gastar token com
// cidade que não vai caber.
// =====================================================================

const MAX_EXTRAS = 4;

/// Monta o prompt.
///
/// Instruções em inglês, como no resto do projeto. O idioma da RESPOSTA
/// é o da tela (`lang`), porque nome de cidade e motivo aparecem direto
/// no cartão: "Florença", não "Florence", para quem usa o app em pt.
///
/// **O `search` também vem na língua da tela, e não em inglês.** O app
/// compara o país do `search` ("Florença, Itália") com o da lista do
/// Google, que vem no idioma do app ("Pisa, Província de Pisa, Itália")
/// -- é o aviso de "cidade em outro país". Com o `search` em inglês,
/// "Italy" contra "Itália" avisaria outro país dentro da Itália.
function montarPrompt({ destination, days, maxCities, vibes = [], cities = [], lang = 'pt' }) {
  const idioma = lang === 'en' ? 'English' : 'Brazilian Portuguese';
  const gostos = vibes.length ? vibes.join(', ') : 'none given';
  const atuais = cities.length ? cities.join('; ') : 'none yet';

  return `You help plan a ${days}-day trip.

DESTINATION (as typed by the traveler): ${destination}
TRAVELER VIBES: ${gostos}
CITIES ALREADY IN THE ITINERARY: ${atuais}

TASK:
1. Decide whether the destination is a single CITY or a larger place (country, state, region, island group, continent).
2. "itinerary":
   - If it is a CITY: return exactly that one city.
   - Otherwise: return between 1 and ${maxCities} cities inside that place, best first, chosen for the vibes and for a sensible route. "days" is how many of the ${days} days each city deserves; it is a weight, the app rebalances it.
3. "extras": up to ${MAX_EXTRAS} OTHER cities worth adding, near the itinerary cities, reachable in a few hours by land. Never repeat an itinerary city.

RULES:
- Real, existing cities only. Never invent a place. Never return coordinates.
- "search" is "City, Country", both in ${idioma}, so that a maps search finds the right one (e.g. "${lang === 'en' ? 'Florence, Italy' : 'Florença, Itália'}").
- "name", "search" and "reason" are in ${idioma}.
- "reason" is ONE concrete line, max 12 words: distance or travel time from an itinerary city plus why it fits the vibes. Example: "a 2h de trem de Berlim, pelo vale do Elba". No hype words, no emojis.
- Interpret vibes literally.

Your response MUST be EXCLUSIVELY a raw JSON object matching this schema exactly:
{
  "kind": "city" | "region",
  "itinerary": [ { "name": "...", "search": "City, Country", "reason": "...", "days": 3 } ],
  "extras": [ { "name": "...", "search": "City, Country", "reason": "..." } ]
}`;
}

/// Confere e limpa a resposta do modelo.
///
/// Nunca lança. Cidade sem nome ou sem motivo sai, repetida sai, extra
/// que já está no roteiro sai, e o roteiro respeita o teto. Destino
/// cidade fica com UMA cidade, diga o modelo o que disser -- é a regra
/// do produto ("se escolhi uma cidade, deixa apenas a cidade"), e o app
/// aplica a mesma de novo.
///
/// Devolve `null` quando não sobra roteiro nenhum: aí o app segue com o
/// destino como veio, que é melhor do que uma lista inventada às pressas.
function conferirResposta(bruto, { maxCities }) {
  if (!bruto || typeof bruto !== 'object') return null;

  const kind = String(bruto.kind ?? '').trim().toLowerCase() === 'city' ? 'city' : 'region';
  const vistos = new Set();
  const descartados = [];

  const limpar = (c, comDias) => {
    const name = String(c?.name ?? '').trim();
    const reason = String(c?.reason ?? '').trim().slice(0, 140);
    if (!name || !reason) {
      descartados.push(`${name || '(sem nome)'}: sem nome ou sem motivo`);
      return null;
    }
    const chave = name.toLowerCase();
    if (vistos.has(chave)) {
      descartados.push(`${name}: repetida`);
      return null;
    }
    vistos.add(chave);
    const search = String(c?.search ?? '').trim() || name;
    const saida = { name, search, reason };
    if (comDias) {
      const d = Math.round(Number(c?.days));
      if (Number.isFinite(d) && d > 0) saida.days = d;
    }
    return saida;
  };

  const teto = kind === 'city' ? 1 : Math.max(1, Number(maxCities) || 1);
  const itinerary = (Array.isArray(bruto.itinerary) ? bruto.itinerary : [])
    .map((c) => limpar(c, true))
    .filter(Boolean)
    .slice(0, teto);
  if (itinerary.length === 0) return null;

  // Os nomes cortados pelo teto voltam a ser elegíveis como extra: o
  // modelo achou que valiam, só não couberam no começo.
  for (const chave of [...vistos]) {
    if (!itinerary.some((c) => c.name.toLowerCase() === chave)) vistos.delete(chave);
  }

  const extras = (Array.isArray(bruto.extras) ? bruto.extras : [])
    .map((c) => limpar(c, false))
    .filter(Boolean)
    .slice(0, MAX_EXTRAS);

  return { resposta: { kind, itinerary, extras }, descartados };
}

module.exports = { montarPrompt, conferirResposta, MAX_EXTRAS };
