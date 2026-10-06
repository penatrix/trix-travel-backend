// O prompt da troca de atividade, montado aqui e não no app.
//
// Até 28/09 ele era montado pelo `buildMicroActivityPrompt`, no
// `custom_functions.dart` do app, e chegava pronto no `promptText`. Dois
// problemas com isso, e o primeiro é o que motivou a mudança:
//
// 1. **O template ia no bundle.** O `main.dart.js` que o Vercel serve em
//    claro carregava as regras do prompt inteiras -- engenharia de prompt
//    é o que a Trix tem de seu, e estava a um "ver código-fonte" de
//    distância. Decisão do Paulo, 28/09: esconder, com prioridade.
// 2. **O handler aceitava qualquer texto.** Quem tivesse um JWT (e sessão
//    anônima dá um) mandava o prompt que quisesse para o Gemini Pro, na
//    nossa conta. Com os parâmetros, o que o cliente escolhe é a cidade,
//    o período e o pedido -- não a instrução.
//
// O texto abaixo é o do Dart, palavra por palavra, inclusive o recuo de
// dois espaços e a quebra final: a regressão (`prompt-da-troca.test.js`)
// compara contra o prompt que o app montava, para os mesmos parâmetros.
// Melhorar o prompt é outra mudança, e fica mais fácil de medir sozinha.

// Tetos de tamanho. O app manda o que tem; estes números só existem para
// que um corpo forjado não vire um prompt de 1 MB cobrado por token.
//
// `evitar` é o maior campo legítimo: todos os lugares da cidade no roteiro
// mais os recusados da sessão. Um roteiro de 30 dias numa cidade só tem
// ~150 atividades, então 300 cobre com folga.
const MAX_EVITAR = 300;
const MAX_NOME = 150;
const MAX_PEDIDO = 500;
const MAX_CAMPO = 120;

function texto(valor, teto) {
  if (valor === null || valor === undefined) return '';
  return String(valor).trim().slice(0, teto);
}

// A lista do que não sugerir, como o prompt a escreve: nomes separados
// por vírgula. Aceita lista ou texto já juntado -- o `montarBlacklist` do
// app junta com ', ', e é mais simples o app mandar o que já tem.
function listaDeEvitar(evitar) {
  const itens = Array.isArray(evitar)
    ? evitar
    : typeof evitar === 'string'
      ? evitar.split(',')
      : [];
  return itens
    .map((i) => texto(i, MAX_NOME))
    .filter((i) => i.length > 0)
    .slice(0, MAX_EVITAR)
    .join(', ');
}

// Os parâmetros do corpo, conferidos. Devolve `null` quando falta o que o
// prompt não sabe montar sem: a cidade e o período.
function lerParametros(corpo) {
  const c = corpo || {};
  const cidade = texto(c.cidade, MAX_CAMPO);
  const periodo = texto(c.period, MAX_CAMPO);
  if (!cidade || !periodo) return null;
  return {
    cidade,
    periodo,
    custoAtual: texto(c.custo_atual, MAX_CAMPO),
    evitar: listaDeEvitar(c.evitar),
    pedido: texto(c.pedido, MAX_PEDIDO),
    idioma: c.idioma === 'pt' ? 'pt' : 'en',
  };
}

function montarPromptDaTroca({ cidade, periodo, custoAtual, evitar, pedido, idioma }) {
  const targetLanguage = idioma === 'pt' ? 'PORTUGUESE (pt-BR)' : 'ENGLISH';

  // O mesmo exemplo do prompt de geração, e não por acaso: sem ele a
  // atividade nascia "BRL 50 por pessoa" e, depois de trocada, virava
  // "BRL 50" -- o mesmo campo dizendo coisas diferentes sobre quem paga.
  const costExample = idioma === 'pt'
    ? '"BRL 150 por pessoa" ou "BRL 300 no total"'
    : '"BRL 150 per person" or "BRL 300 total"';

  const requestInstruction = pedido
    ? `USER REQUEST: The user specifically asked for: "${pedido}". Prioritize this request above all else.`
    : 'USER REQUEST: Surprise the user with a highly-rated, somewhat hidden gem or a unique local experience.';

  // Pede TRÊS, não uma: o handler verifica as três no Google e fica com a
  // melhor, então descartar uma fechada não custa outra ida ao modelo.
  // Três, e não cinco, porque cada uma vira duas consultas ao Google.
  return `  You are an elite travel concierge. Suggest THREE distinct, highly-rated, logical travel activities in **${cidade}** for the **${periodo}**.
  All of them must fit a **${custoAtual}** budget.

  ${requestInstruction}

  CRITICAL RULES:
  1. BLACKLIST: Do NOT suggest any of these places, as the user is already visiting them or rejected them: **${evitar ? evitar : 'None'}**.
  2. LANGUAGE: Your output values MUST be exclusively in ${targetLanguage}.
  3. COST FORMAT: The "cost_estimate" MUST be a single, flat number preceded by "BRL ", and MUST state explicitly whether the amount is per person or the total, written in ${targetLanguage}, following this exact pattern: ${costExample}. NEVER use ranges. NEVER use other currencies like JPY, USD, or EUR.
  4. LENGTH: Keep "description" to a maximum of 2 short sentences. Keep "logistics" extremely brief and actionable.
  5. RANKING: Order the array by how strongly you recommend it. The first item is your best pick; the other two are fallbacks, used only if the first one turns out to be closed or unavailable at that time of day.
  6. DISTINCT: The three must be different places. Do NOT repeat the same venue with different wording.
  7. OPENING HOURS: Every suggestion must be a place that is plausibly open during the **${periodo}**. Do not suggest a lunch-only restaurant for an evening slot, or a nightclub for a morning slot.

  Your response MUST be EXCLUSIVELY a raw JSON object matching this schema exactly (do NOT include the "period" key in your response):
  {
    "suggestions": [
      {
        "place": "Specific Place Name",
        "description": "Engaging, extremely concise description (max 2 short sentences).",
        "logistics": "Actionable, brief tips (how to get there/booking info).",
        "cost_estimate": "BRL [Single Number] + per person or total marker, in ${targetLanguage}",
        "booking_required": "JSON boolean: true ONLY if the place must be booked or ticketed before arriving (table reservation, timed entry, tour, show); false for walk-in",
        "maps_search_query": "Google Maps search string including city and country"
      }
    ]
  }
  The "suggestions" array MUST contain exactly 3 items, ranked best first.
  `;
}

module.exports = {
  montarPromptDaTroca,
  lerParametros,
  listaDeEvitar,
  MAX_EVITAR,
  MAX_PEDIDO,
};
