// O prompt do brainstorming de destinos, montado aqui a partir da linha.
//
// Até 01/10 ele era montado pelo `buildBrainstormingPrompt`, no
// `custom_functions.dart` do app, e gravado pronto na coluna
// `prompt_payload`. Dois vazamentos com isso:
//
// 1. **O template ia no bundle**, em claro no `main.dart.js`.
// 2. **E ia em cada linha.** A tabela tinha leitura pública
//    (`USING (true)`), então qualquer pessoa com a chave anônima listava
//    as linhas -- e cada uma carregava o prompt inteiro, com o pedido
//    escrito de quem pediu.
//
// Agora o app grava só os PARÂMETROS nas colunas da linha (dias, datas,
// vibes, gasto, origem, idioma, escopo, pedido e recusados) e o prompt
// nasce aqui, na hora de chamar o modelo, sem ser gravado em lugar nenhum.
//
// O texto é o do Dart palavra por palavra. A regressão
// (`prompt-do-brainstorming.test.js`) compara contra o prompt que o app
// montava para os mesmos parâmetros. Uma diferença só, e de propósito: a
// data. O app passava `DateTime.toString()` ("2026-12-01 00:00:00.000");
// a coluna é `date`, e chega "2026-12-01". A hora nunca significou nada
// ali -- era meia-noite em todo pedido.

// Teto do pedido em texto livre, o mesmo da constraint da coluna. Os
// outros campos vêm de lista fechada ou de número, e o banco já os limita.
const MAX_PEDIDO = 500;
const MAX_RECUSADOS = 30;

function texto(valor) {
  return valor === null || valor === undefined ? '' : String(valor);
}

// A lista de destinos recusados como o prompt a escreve: sem repetição,
// na ordem em que foram recusados, separados por "; ". O `toSet()` do
// Dart preserva a ordem de inserção, e o `Set` daqui também.
function listaDeRecusados(recusados) {
  if (!Array.isArray(recusados)) return [];
  return [...new Set(
    recusados
      .map((r) => texto(r).trim())
      .filter((r) => r.length > 0),
  )].slice(0, MAX_RECUSADOS);
}

function montarPromptDoBrainstorming(linha) {
  const l = linha || {};
  const targetLanguage = l.language === 'pt' ? 'PORTUGUESE (pt-BR)' : 'ENGLISH';

  const inicio = texto(l.start_date);
  const fim = texto(l.end_date);
  let travelDates = 'Flexible / Not specified';
  if (inicio && fim) {
    travelDates = `From ${inicio} to ${fim}`;
  } else if (inicio) {
    travelDates = `Starting on ${inicio}`;
  }

  const vibes = texto(l.liked_vibes) || 'surprise me with popular experiences';

  // `??` e não `||`, como o `??` do Dart: texto vazio chega vazio ao
  // prompt, só a ausência vira o padrão.
  const finalBudgetStyle = l.budget_style ?? 'Flexible / Not specified';
  const finalDays = l.days ?? 7;
  const finalOrigin = l.originTown ?? 'Not specified';

  const rejeitados = listaDeRecusados(l.excluded_destinations);
  const forbiddenBlock = rejeitados.length === 0
    ? ''
    : '\n\nCRITICAL - THE USER HAS ALREADY SEEN AND REJECTED THESE '
      + `DESTINATIONS: ${rejeitados.join('; ')}.\n`
      + 'You are STRICTLY FORBIDDEN from suggesting any of them again, '
      + 'including the same city or region under a different name. The 3 '
      + 'destinations you return MUST be genuinely different from those.';

  let scopeBlock = '';
  if (l.trip_scope === 'domestic') {
    scopeBlock = '\n\nSCOPE - DOMESTIC: the user explicitly asked to stay INSIDE their '
      + 'own country. All 3 destinations MUST be in the same country as the '
      + `origin (${finalOrigin}). If the origin is not specified, assume Brazil.`;
  } else if (l.trip_scope === 'international') {
    scopeBlock = '\n\nSCOPE - INTERNATIONAL: the user explicitly asked to travel ABROAD. '
      + 'All 3 destinations MUST be OUTSIDE the origin country '
      + `(${finalOrigin}). If the origin is not specified, assume the user `
      + 'lives in Brazil, so do NOT suggest Brazilian destinations.';
  }

  // O teto do "Jeito de gastar", por pessoa, desde 01/10. Sem ele o nível
  // sozinho ("Comfort") deixava passar destino de R$ 25 mil para quem
  // disse R$ 12 mil. Só entra quando é um número positivo: o caso sem teto
  // continua com o prompt de antes, letra por letra.
  const teto = Number(l.budget_limit_per_person);
  const budgetBlock = Number.isFinite(teto) && teto > 0
    ? `\n\nHARD BUDGET LIMIT: BRL ${Math.round(teto)} per person for the WHOLE trip, `
      + 'transport from origin included. Every estimated_cost_per_person_brl '
      + 'MUST be at or below this limit. If a destination cannot fit it, do '
      + 'not suggest it.'
    : '';

  const pedido = texto(l.special_request).trim().slice(0, MAX_PEDIDO);
  const requestBlock = pedido === ''
    ? ''
    : '\n\nTHE USER WROTE THIS IN THEIR OWN WORDS, and it OVERRIDES any '
      + `inference you would make from the vibes above: "${pedido}". If it `
      + 'names a place, a season, an event or a constraint, every one of the '
      + '3 destinations must respect it.';

  return `You are the elite luxury travel concierge for the Trix app. The user is looking for inspiration for their next trip with the following parameters:
- Budget Style: ${finalBudgetStyle}
- Duration: ${finalDays} days
- Travel Dates: ${travelDates}
- Origin: ${finalOrigin}
- Interests and "Vibes" liked by the user: ${vibes}

Your mission: Suggest 3 incredible destinations (can be specific cities or small routes/regions that make sense for the number of days).
CRITICAL: Strictly evaluate the seasonality and weather. Do NOT suggest destinations with extreme weather or monsoons during the indicated period (${travelDates}). The budget style (${finalBudgetStyle}) must also be realistic for the destination. To define estimated cost, you MUST consider the transport from origin city, if specified: ${finalOrigin}.${budgetBlock}${scopeBlock}${requestBlock}${forbiddenBlock}

Your response MUST be EXCLUSIVELY a raw JSON object, without markdown formatting or code blocks. Strictly follow this exact SCHEMA. 
CRITICAL: The JSON keys MUST remain exactly as written in English. ONLY the generated values/content MUST BE IN ${targetLanguage}:

{
  "destinations": [
    {
      "title": "Destination or Route Name",
      "country": "Country Name",
      "base_city": "The SINGLE city the traveler should base themselves in, as a plain city name searchable on Google Maps. If the title is a route or a region, pick its main city. Never repeat the route or region name here.",
      "pitch": "A persuasive sentence, strictly in ${targetLanguage}, explaining why this place is perfect based on their chosen vibes, budget, and time of year.",
      "estimated_cost_per_person_brl": 15000,
      "unsplash_query": "Search terms strictly in ENGLISH to find an image of this place, e.g., 'paris city architecture'"
    }
  ]
}
`;
}

module.exports = {
  montarPromptDoBrainstorming,
  listaDeRecusados,
  MAX_PEDIDO,
  MAX_RECUSADOS,
};
