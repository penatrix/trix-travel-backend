// O prompt da geração do roteiro, montado aqui a partir da linha de `trips`.
//
// Até a fase B desta mudança ele era montado pelo `buildGeminiPrompt`, no
// `custom_functions.dart` do app, e gravado pronto em `trips.prompt_payload`.
// Era o último template de prompt servido em claro no `main.dart.js`, e
// cada membro convidado de um roteiro recebia o template junto com a row.
//
// O TEXTO É O MESMO, letra por letra. Os blocos literais deste arquivo
// foram EXTRAÍDOS do fonte Dart por script, e não copiados à mão; a lógica
// em volta (dias, densidade, backups, perfil) foi transcrita função por
// função. A prova foi o CI do app, que chamou o `buildGeminiPrompt` com as
// entradas de `prompt-da-geracao.casos.json` e exigiu o mesmo texto deste
// módulo nos nove casos (app #215). Na fase B (02/10) o Dart saiu, e este
// é o único construtor.
//
// Entrada: a linha de `trips` (as colunas abaixo) e o `travel_dna` do dono,
// que mora em `users` e é lido pelo handler com service_role.
//
//   planned_destinations  [{destination, days}] -- o `paraOPrompt` de cada
//                         cidade, gravado NO INSERT (a `trip_destinations`
//                         chega depois do webhook)
//   start_date, end_date  'YYYY-MM-DD'
//   is_date_set           datas escolhidas (true) ou provisórias (false)
//   travelers_count, budget_limit (teto do GRUPO), budget_level, pace_level
//   vibe_tags             as vibes em inglês, juntas por ', '
//   special_request, user_language, origin_city

'use strict';

// O RitmoDaViagem do app (`lib/flutter_flow/ritmo_da_viagem.dart`).
// O número de paradas é PROMESSA na tela do app ("Duas paradas por dia")
// e ordem aqui ("EXACTLY 2 activities per day"). As duas cópias vivem em
// repositórios diferentes e nada as compara: cada lado trava os seus
// números em teste. Mexeu num, mexa no outro.
const RITMOS = [
  { canonico: 'Chill', rotuloPt: 'Sem pressa', paradas: 2,
    distribuicao: '1 in the first period, 1 in the second' },
  { canonico: 'Balanced', rotuloPt: 'Rota certa', paradas: 3,
    distribuicao: '1 in each of the three periods' },
  { canonico: 'Action-packed', rotuloPt: 'Turbina ligada', paradas: 5,
    distribuicao: '2 in the first period, 2 in the second, 1 in the third' },
];
const RITMOS_ANTIGOS = {
  Maratonista: 'Action-packed',
  Equilibrado: 'Balanced',
  'De boa': 'Chill',
};

function ritmoDe(bruto) {
  const v = (bruto ?? '').trim();
  if (v === '') return null;
  const direto = RITMOS.find((r) => v === r.canonico || v === r.rotuloPt);
  if (direto) return direto;
  const antigo = RITMOS_ANTIGOS[v];
  return antigo ? RITMOS.find((r) => r.canonico === antigo) : null;
}

// O `PreferenceLabels.dietaryToDb`: rótulo em qualquer idioma -> inglês.
// Valor desconhecido passa intacto -- melhor mandar o texto original do
// que sumir com uma restrição alimentar pelo caminho.
const DIETA = [
  ['Vegetarian', 'Vegetariano'],
  ['Vegan', 'Vegano'],
  ['Gluten-free', 'Sem glúten'],
  ['Lactose-free', 'Sem lactose'],
];
function dietaryToDb(labels) {
  return (labels ?? []).map((label) => {
    if (label == null || label === '') return label;
    const linha = DIETA.find((r) => r[0] === label || r[1] === label);
    return linha ? linha[0] : label;
  });
}

function texto(v) {
  return v == null ? '' : String(v);
}

function orDefault(value, fallback) {
  return (value == null || String(value).trim() === '') ? fallback : String(value).trim();
}

// A coluna `date` chega como 'YYYY-MM-DD'; o app mandava o DateTime inteiro
// ('2026-09-09 00:00:00.000'). O modelo só precisa da data.
function dateOnly(raw) {
  if (raw == null || String(raw).trim() === '') return 'Not specified';
  const m = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(raw).trim();
}

// Dias contando as duas pontas, como o `end.difference(start).inDays + 1`
// do Dart. Em UTC para não depender do fuso do servidor.
function diasEntre(inicio, fim) {
  const a = String(inicio ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  const b = String(fim ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!a || !b) return 0;
  const ta = Date.UTC(+a[1], +a[2] - 1, +a[3]);
  const tb = Date.UTC(+b[1], +b[2] - 1, +b[3]);
  return Math.round((tb - ta) / 86400000) + 1;
}

function listaDeTexto(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
}

// "Com quem você costuma viajar" (Perfil do app, 09/10). O app grava a
// chave em inglês dentro do `travel_dna.companions`; aqui ela vira a frase
// que o modelo lê. Pet pede o explícito: hospedagem e lugares que aceitam
// animal, que é o que a vibe "Pet friendly" pedia antes de sair.
const COMPANHIA = {
  Solo: 'alone',
  Couple: 'as a couple',
  Kids: 'with children',
  Friends: 'with friends',
  Pet: 'with a pet (pet-friendly lodging and places only)',
};
function companhiaDoPerfil(lista) {
  return listaDeTexto(lista).map((c) => COMPANHIA[c]).filter(Boolean);
}

function montarPromptDaGeracao(linha, travelDna) {
  const l = linha || {};
  const isPt = l.user_language === 'pt';
  const targetLanguage = isPt ? 'PORTUGUESE (pt-BR)' : 'ENGLISH';
  const periodValues = isPt
    ? '"Manhã", "Tarde", or "Noite"'
    : '"Morning", "Afternoon", or "Evening"';
  const costExample = isPt
    ? '"BRL 150 por pessoa" ou "BRL 300 no total"'
    : '"BRL 150 per person" or "BRL 300 total"';

  const startDate = l.start_date;
  const endDate = l.end_date;
  const travelers = l.travelers_count ?? null;
  const budget = l.budget_limit == null ? '' : String(l.budget_limit);
  const budgetLevel = l.budget_level ?? null;
  const pace = l.pace_level ?? null;
  const specialRequest = l.special_request ?? null;
  const originCity = l.origin_city ?? null;
  const datasConfirmadas = l.is_date_set === true;
  const destinations = Array.isArray(l.planned_destinations) ? l.planned_destinations : null;

  // 1. Dias do roteiro e dias já alocados.
  const totalTripDays = (texto(startDate) !== '' && texto(endDate) !== '')
    ? diasEntre(startDate, endDate)
    : 0;
  let totalAllocatedDays = 0;

  // 2. Destinos.
  let destText = 'No destinations specified';
  if (destinations && destinations.length > 0) {
    const formattedList = [];
    for (const dest of destinations) {
      const days = Number.isInteger(dest?.days) ? dest.days : 0;
      totalAllocatedDays += days;
      const cityName = texto(dest?.destination);
      formattedList.push(days > 0 ? `${cityName} (${days} days)` : `${cityName} (flexible days)`);
    }
    destText = formattedList.join(', ');
  }

  // 2.5. Datas escolhidas ou provisórias: só um dos dois blocos entra.
  const dateInstruction = datasConfirmadas
    ? `  These dates are FIXED, and the traveler will be there on them. Check the destination's calendar for public holidays, religious observances and local closing days that fall inside the range, and plan around what will actually be closed or overrun. A museum shut on 25 December is a ruined day, not a detail.`
    : `  These dates are a PLACEHOLDER for duration only: the traveler has NOT chosen dates yet. Do not build the itinerary around a specific week, holiday or dated event.`;

  // 3. Dias não alocados.
  const unallocatedDays = totalTripDays - totalAllocatedDays;
  let gapInstruction = '';
  if (unallocatedDays > 0 && totalTripDays > 0) {
    gapInstruction = `  [CRITICAL - ITINERARY GAP FILLING]
  The user's trip is for a total of ${totalTripDays} days, but they have only specified destinations for ${totalAllocatedDays} days.
  THERE ARE ${unallocatedDays} UNALLOCATED DAYS REMAINING.
  As an expert travel concierge, you MUST fill these ${unallocatedDays} remaining days by suggesting new, logical destinations (nearby cities, regions, or day trips).
  Your extra suggestions must make logistical sense (easy travel from the user's last specified destination) and perfectly match their Budget/Pace and chosen Vibe.
  The final generated JSON itinerary MUST contain exactly ${totalTripDays} days in total, without missing any day.
  `;
  }

  // 4. Vibes, já em inglês na coluna.
  const vibesText = texto(l.vibe_tags).trim() !== '' ? texto(l.vibe_tags) : 'None';

  // 4.5. O Travel DNA do dono, literal.
  let travelerProfileText = '';
  if (travelDna && typeof travelDna === 'object' && !Array.isArray(travelDna)) {
    const likes = listaDeTexto(travelDna.likes);
    const dislikes = listaDeTexto(travelDna.dislikes);
    const dietary = listaDeTexto(travelDna.dietary);
    const travelStyle = listaDeTexto(travelDna.travel_style);
    // "Com quem você costuma viajar", do Perfil (09/10). Só entra quando
    // existe, para o texto dos roteiros sem isso não mudar uma vírgula.
    const companhia = companhiaDoPerfil(travelDna.companions);
    const profileLines = [];
    if (likes.length) profileLines.push(`Known likes: ${likes.join(', ')}.`);
    if (dislikes.length) profileLines.push(`Known dislikes (avoid these): ${dislikes.join(', ')}.`);
    if (dietary.length) {
      profileLines.push(`Dietary restrictions (STRICT - every meal/restaurant suggestion must comply): ${dietaryToDb(dietary).join(', ')}.`);
    }
    if (travelStyle.length) profileLines.push(`Travel style: ${travelStyle.join(', ')}.`);
    if (companhia.length) {
      profileLines.push(`Usually travels ${companhia.join(', ')}. Plan for that company: places, pace and lodging must suit it.`);
    }
    if (profileLines.length) {
      travelerProfileText = `  TRAVELER PROFILE (learned from past trips - interpret literally, do not over-infer beyond what is listed):
  ${profileLines.join('\n  ')}
`;
    }
  }

  // 4c. Densidade diária por ritmo. `Balanced` para quem não escolheu.
  const ritmo = ritmoDe(pace) ?? RITMOS[1];
  const paceCanonico = ritmo.canonico;
  const atividadesPorDia = ritmo.paradas;
  const distribuicao = ritmo.distribuicao;
  const densityBlock = `  PACE AND DAILY DENSITY (non-negotiable):
  - The pace is "${paceCanonico}", which means EXACTLY ${atividadesPorDia} activities per day. Not fewer, not more.
  - This trip has ${totalTripDays} days, so the itinerary MUST contain about ${totalTripDays * atividadesPorDia} activities in total, spread evenly across the days.
  - The "period" key has only three possible values, so with ${atividadesPorDia} activities per day you MUST repeat a period within the same day. That is expected and correct. Suggested split: ${distribuicao}.
  - Order the activities inside each day chronologically, so repeated periods still read as a sensible sequence.
  - If the traveler profile rejects an entire period (for example, no evening activities), REDISTRIBUTE those activities into the remaining periods. Never drop them: the daily count above must hold.
`;

  // 4d. Backups: 30% das atividades, arredondado para cima, mínimo de 4.
  const totalAtividades = totalTripDays * atividadesPorDia;
  const backupsPara = (atividades) => {
    const trintaPorCento = Math.trunc((atividades * 3 + 9) / 10);
    return trintaPorCento < 4 ? 4 : trintaPorCento;
  };
  const numDestinos = (!destinations || destinations.length === 0) ? 1 : destinations.length;
  const minimoPorDestinos = 4 * numDestinos;
  const porPorcentagem = backupsPara(totalAtividades);
  const backupsTotais = porPorcentagem < minimoPorDestinos ? minimoPorDestinos : porPorcentagem;
  const exemploBackup = `a city with 5 days has ${5 * atividadesPorDia} activities and therefore ${backupsPara(5 * atividadesPorDia)} backup activities`;
  const backupBlock = `  BACKUP ACTIVITIES (the count is PROPORTIONAL to the itinerary, never a fixed number):
  - Inside EACH destination object, you MUST provide an array called "backup_activities".
  - For EACH destination, the number of backups MUST be 30% of that destination's OWN activity count, rounded UP, with a minimum of 4. For example, ${exemploBackup}.
  - Across this whole trip that adds up to roughly ${backupsTotais} backups for about ${totalAtividades} activities. Do not stop early.
  - Backups are wildcards for that specific city that are NOT already in its main itinerary.
  - Vary them deliberately: different KINDS of place (a museum, a hidden-gem restaurant, a park, something indoors) and different times of day. A backup replaces an activity in ANY period, so a bank made only of dinner restaurants is useless for a morning slot.
  - "Backup" is an internal concept of the app: the traveler never sees the word or the role. When a planned place turns out to be closed, a backup is silently promoted into that exact day and period, and from then on it is just an activity like any other.
  - So write "description" and "logistics" describing ONLY the place itself. Never call it a backup, substitute, alternative or replacement, and never tie the text to a day, a period or a situation ("ideal for a rainy afternoon", "great to swap for a formal evening") - the same place may land in a morning slot.
  - They follow the exact same schema as a regular activity (place, description, logistics, cost_estimate, booking_required, maps_search_query) BUT omit the "period" key, as they are flexible.
`;

  // 4e. Custo total.
  const noites = totalTripDays > 0 ? totalTripDays - 1 : 0;
  const origemLimpa = texto(originCity).trim();
  const linhaPassagem = origemLimpa === ''
    ? `"flights": the traveler's origin city is UNKNOWN, so set this to 0 and do NOT invent a fare.`
    : `"flights": getting there and back for the whole group: ${origemLimpa} to the first city, and the last city back to ${origemLimpa}. Use the way people realistically make that trip: a flight when that is how it is done, bus or car when the road trip takes about 6 hours or less each way (car = fuel and tolls for one car, split among the group). Fill "origin_transfer" first, then set this to its "per_person_brl" multiplied by ${travelers ?? 1}.`;
  // A ida e volta da origem, POR PESSOA, num objeto próprio. A conta pelo
  // grupo quem faz é o `passagem-de-origem.js`: medido em 02/10, o modelo
  // devolvia o mesmo número redondo para 1 e 2 viajantes (333 e 335).
  // Sem origem não há o que pedir: o `flights` é 0 e o objeto não existe.
  const regraOrigem = origemLimpa === ''
    ? ''
    : `  - You MUST include an "origin_transfer" object at the root: "mode" is EXACTLY one of flight, train, bus, car, ferry (in English), and "per_person_brl" is the integer round-trip cost for ONE traveler, in BRL.
`;
  const schemaOrigem = origemLimpa === ''
    ? ''
    : `
    "origin_transfer": {
      "mode": "flight, train, bus, car or ferry",
      "per_person_brl": "integer: the round trip for ONE traveler"
    },`;
  const trasladoBlock = `  TRAVEL BETWEEN CITIES (an itinerary that teleports the traveler is not real):
  - Every destination AFTER the first MUST carry an "arrival_transfer" object: how the group gets there from the previous destination. The first destination has none.
    * "from": the previous city, localized. "mode": EXACTLY one of flight, train, bus, car, ferry (in English). "duration": door to door (e.g. "3h30"). "cost_estimate": same pattern as activities (${costExample}). "how_to_book": one sentence with the company or site and when to buy, in ${targetLanguage}.
  - Pick the mode that is realistic for the distance and the route, and a realistic duration.
  - The travel happens on the FIRST day of the new destination: schedule nothing in the period spent travelling, and start that day with something compatible with the arrival time.
  - This cost goes into "local_transport", never into "activities_and_tickets".
`;
  const custoBlock = `  TOTAL COST (this is the number the traveler judges us by):
  - You MUST include a "cost_breakdown" object at the root, with EXACTLY these five keys. Every value is an integer in BRL, for the whole trip and the whole group of ${travelers ?? 1}:
    * ${linhaPassagem}
    * "accommodation": every night added up. Count NIGHTS, not days: this trip of ${totalTripDays} days has ${noites} nights, and the nights per city must add up to that.
    * "activities_and_tickets": the sum of every "cost_estimate" in the itinerary.
    * "food_not_listed": meals the traveler will realistically eat that are NOT already in the itinerary as activities. Never count a restaurant you already listed - that one is in activities_and_tickets.
    * "local_transport": airport transfers, metro, taxi, and any bus or flight BETWEEN the cities of this trip.
  - "estimated_cost_brl" MUST be the exact arithmetic sum of those five values. Add them up - do not estimate the total on its own, and do not leave anything out of the five lines.
${regraOrigem}`;

  const budgetText = (budget.trim() === '')
    ? 'Not specified'
    : `BRL ${budget.trim()} for the WHOLE trip, the round trip from home included`;

  // 5. O prompt.
  return `You are an elite, highly sought-after local travel concierge. Your job is to create a highly specific, actionable, and hyper-personalized multi-destination itinerary.

  TRIP PARAMETERS:
  Destinations and duration: ${destText}.
  Dates: from ${dateOnly(startDate)} to ${dateOnly(endDate)}.
${dateInstruction}
  Total Days: ${totalTripDays} days.
  Travelers: ${travelers ?? 1} people.
  Total Budget: ${budgetText} (Level: ${orDefault(budgetLevel, 'Standard')}).
  Pace: ${orDefault(pace, 'Moderate')}.
  Main interests: ${vibesText}.
  Special requests: ${orDefault(specialRequest, 'None')}.
  ${travelerProfileText}
  ${gapInstruction}

${densityBlock}
  CRITICAL INSTRUCTIONS AGAINST GENERIC CONTENT:
  - NEVER suggest generic categories like "a luxury hotel", "a local cafe", or "a nice seafood restaurant". You MUST provide SPECIFIC, real names of highly-rated establishments (e.g., "Copacabana Palace", "Confeitaria Colombo", "Fogo de Chão").
  - For accommodations: Suggest a SPECIFIC hotel or Airbnb region for each city that fits the user's budget level, and include its estimated cost.
  - For logistics: Don't just say "Visit the Christ the Redeemer". Tell the user HOW: "Buy tickets online in advance via the official Trem do Corcovado website. Take an Uber early in the morning to avoid crowds."
  - Provide specific cost estimates for EVERY single activity, meal, and accommodation in BRL.
  - EVERY "cost_estimate" MUST state explicitly whether the amount is per person or the total for the whole group of ${travelers ?? 1}. Never leave this ambiguous. Write the whole value in ${targetLanguage}, following this exact pattern: ${costExample}.
  - "estimated_cost_per_night" is always the TOTAL nightly rate for the room, never per person, and must carry that marker in ${targetLanguage} too.
  - For EVERY activity and backup, set "booking_required" (a JSON boolean). It is true ONLY when the place must be booked or ticketed BEFORE arriving: a restaurant that takes table reservations and fills up, a timed-entry museum or monument, a guided tour, a show. It is false when people just walk in, even if there is an entry fee paid at the door. The traveler uses it to track what is already booked, so do not mark everything as true.
${custoBlock}
${trasladoBlock}
  - For each city, provide a "city_cultural_summary": A 3-4 sentence engaging overview of the city's unique vibe, historical significance, or fun cultural facts to act as a mini tour guide introduction.
  - For each activity and the accommodation, provide a "maps_search_query": The absolute best, hyper-specific search string to find this exact location on Google Maps (e.g., "Fasano Hotel, Ipanema, Rio de Janeiro, Brazil"). Do NOT provide coordinates, only the best text search string.
  - For the 'unsplash_search_query' field, you MUST ALWAYS provide the city and country name strictly in English (e.g., "Leipzig Germany", "Munich Germany"). This is critical for an image search API.
  - For "country_slug", provide the English name of the country in lowercase, replacing spaces with hyphens (e.g., "united-states", "south-africa", "france").
  - For "city_slug", provide the English name of the city in lowercase, replacing spaces with hyphens (e.g., "new-york", "buenos-aires", "tokyo").

  CRITICAL CONCIERGE RULES (QUICK FACTS & CHECKLIST):
  - You MUST include a "concierge" object at the root of your JSON response.
  - "quick_facts" is an array with ONE ENTRY PER CITY in the itinerary, in the same order as the destinations. A trip through 3 cities has 3 entries, even when all 3 are in the same country. NEVER collapse cities into a single country-level entry.
  - Each entry MUST carry "city_name" (localized) and "city_slug" (English, lowercase, hyphenated) identifying which city it describes, plus "country_name" (localized) and "country_slug".
  - These fields are CITY-SPECIFIC. Resolve them for that exact city, never for the country as a whole:
    * "plug_type": the plug SHAPE only, without the voltage (e.g. "Tipo C/F"). The voltage goes in its own field.
    * "voltage": voltage genuinely varies inside a country. Salvador is 127V and Vitória da Conquista is 220V, both in Brazil. Give the voltage actually used in THAT city, and nothing else (e.g. "230V"). Never write a range like "127V/220V" to cover both.
    * "transport": how a visitor actually gets around in THAT city, in at most 5 words (e.g. "Metrô e bonde", "Só táxi e aplicativo"). Never name a system the city does not have.
    * "weather_avg": use the city's own altitude and coast/inland position for the travel dates. Two cities in one state can differ by 10°C.
  - These fields are national, and repeat identically across cities of the same country: "currency", "language", "emergency_number", "tipping_culture".
  - Keep every value extremely ACCURATE and ULTRA-CONCISE:
    * "tipping_culture": Maximum 4 words.
    * "weather_avg": Maximum 4 words.
    * "transport": Maximum 5 words.
    * "currency", "plug_type", "voltage", "emergency_number", "language": Keep as short direct values.
  - For "checklist.items", generate 4 to 5 highly practical, non-obvious items:
    * "item_title": MUST be very short (1 to 3 words max, e.g., "Adaptador de Tomada").
    * "item_description": MUST be strictly ONE brief sentence (maximum 12 words / 90 characters max). Be ultra-direct
    * "item_category": EXACTLY one of these English values: documents, bookings, packing, money, health. Never translate it.

${backupBlock}
  CRITICAL JSON RULE FOR PERIODS & LANGUAGES:
  The JSON keys MUST always remain exactly as written in English. However, the VALUES inside the JSON MUST BE STRICTLY IN ${targetLanguage}.
  For the "period" key, use ONLY these exact values: ${periodValues}.

  Your response MUST be EXCLUSIVELY a raw JSON object, without markdown formatting or code blocks. Strictly follow this exact SCHEMA:
  
  {
    "trip_title": "Creative, short and engaging name for the trip",
    "estimated_cost_brl": 15000,
    "cost_breakdown": {
      "flights": 6000,
      "accommodation": 4900,
      "activities_and_tickets": 2600,
      "food_not_listed": 1000,
      "local_transport": 500
    },${schemaOrigem}
    "concierge": {
      "quick_facts": [
        {
          "city_name": "City Name, localized (e.g., Quioto) - ONE ENTRY PER CITY",
          "city_slug": "english-hyphenated-city",
          "country_name": "Country Name (e.g., Japan)",
          "country_slug": "english-hyphenated-country",
          "currency": "Currency name and symbol (e.g., Iene ¥)",
          "plug_type": "Plug shape only, no voltage (e.g., Tipo A/B)",
          "voltage": "Voltage of that city only (e.g., 100V)",
          "transport": "How you get around in that city (e.g., Metrô e trem)",
          "emergency_number": "Local emergency number (e.g., 110)",
          "language": "Main local language",
          "weather_avg": "Average weather (e.g., 10°C to 20°C)",
          "tipping_culture": "Local tipping culture (e.g., Not expected)"
        }
      ],
      "checklist": {
        "items": [
          {
            "item_title": "Short Item Name",
            "item_description": "Brief explanation of why this is important for this trip",
            "item_category": "documents | bookings | packing | money | health"
          }
        ]
      }
    },
    "destinations": [
      {
        "city": "City Name",
        "city_slug": "english-hyphenated-city",
        "unsplash_search_query": "City and Country in English",
        "days": 2,
        "city_cultural_summary": "Engaging 3-4 sentence overview of the city's vibe, history, and cultural significance.",
        "arrival_transfer": {
          "from": "Previous city (omit this whole object on the first destination)",
          "mode": "train",
          "duration": "3h30",
          "cost_estimate": "BRL 180",
          "how_to_book": "Company or site, and how far ahead to buy"
        },
        "accommodation": {
          "name": "Specific Hotel/Airbnb Name (e.g., Fasano Hotel)",
          "description": "Brief reason why this specific place fits their vibe and budget.",
          "estimated_cost_per_night": "BRL 800",
          "maps_search_query": "The perfect Google Maps search string for this place, including city and country"
        },
        "itinerary": [
          {
            "day": 1,
            "activities": [
              {
                "place": "Specific Place or Restaurant Name",
                "description": "Deep, immersive description of what to do, see, or eat there. Include specific dishes or highlights.",
                "logistics": "Actionable tips: Best time to go, how to get there, ticket purchase links or advice.",
                "period": "Morning/Afternoon/Evening",
                "cost_estimate": "BRL 150",
                "booking_required": true,
                "maps_search_query": "The perfect Google Maps search string for this place, including city and country"
              }
            ]
          }
        ],
        "backup_activities": [
          {
            "place": "Specific Place or Restaurant Name",
            "description": "Deep, immersive description of what to do, see, or eat there.",
            "logistics": "Actionable tips.",
            "cost_estimate": "BRL 100",
            "booking_required": false,
            "maps_search_query": "The perfect Google Maps search string"
          }
        ]
      }
    ]
  }`;
}

module.exports = { montarPromptDaGeracao, ritmoDe, dietaryToDb, diasEntre, companhiaDoPerfil };
