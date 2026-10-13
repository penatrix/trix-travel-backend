// O refazer que só acrescenta (13/10, decisão do Paulo).
//
// O refazer de 09/10 gera o roteiro inteiro de novo. Para pôr 2 dias num
// roteiro de 10, isso levou 149s no teste de 13/10: o modelo reescreve os
// 10 dias e o Google confere 78 lugares, para mudar 2. E o roteiro novo
// perde as marcas de Reservado e do checklist.
//
// Quando o pedido só ACRESCENTA, não há o que reescrever:
//
//   - sem nota (uma nota vale para o roteiro todo);
//   - a mesma origem;
//   - cada cidade de hoje, na mesma ordem, com os mesmos dias ou mais;
//   - cidades novas só no fim (é onde a folha do app as põe).
//
// Aí o modelo escreve só os dias e as cidades que faltam, sabendo o que
// já existe, e os dias de hoje ficam como estão -- reservas e checklist
// junto. Trocar, remover, encurtar ou mudar a origem continua refazendo
// tudo, porque a viagem muda como um todo.
//
// **Nada se repete, garantido pelo código e não só pedido ao modelo.** O
// prompt lista cada lugar que já está no roteiro; depois da resposta,
// `semRepeticao` troca por um backup novo, ou tira, o que repetir assim
// mesmo. Lugar repetido é o tipo de erro que a pessoa vê na hora.
//
// Puro, sem rede: é o que o teste exercita.

const MARCA_DO_SCHEMA =
  '  Your response MUST be EXCLUSIVELY a raw JSON object, without markdown formatting or code blocks. Strictly follow this exact SCHEMA:';

/// "Castelo de São Jorge, Lisboa" -> "castelodesaojorgelisboa".
function chave(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/// "Lisboa, Portugal" e "Lisboa" são a mesma cidade.
function mesmaCidade(doPedido, doRoteiro) {
  const a = chave(String(doPedido ?? '').split(',')[0]);
  const b = chave(String(doRoteiro ?? '').split(',')[0]);
  return a !== '' && a === b;
}

function comoMapa(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const o = JSON.parse(v);
      return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}

/// O que acrescentar, ou `null` quando o pedido não é só acréscimo.
///
/// Devolve `{ pecas, diasAntes }`, uma peça por coisa a escrever, na
/// ordem do roteiro final:
///   { tipo: 'estender', indice, cidade, diasHoje, diasNovos, primeiroDia }
///   { tipo: 'nova', destination, dias, primeiroDia, vemDe }
/// `primeiroDia` é o número do dia no roteiro final, contado de 1.
function planoDoAcrescimo(roteiroAtual, origemAtual, pedido) {
  if (!pedido || (pedido.nota ?? '') !== '') return null;
  if (chave(pedido.origem) !== chave(origemAtual)) return null;

  const roteiro = comoMapa(roteiroAtual);
  const destinos = Array.isArray(roteiro?.destinations) ? roteiro.destinations : [];
  if (destinos.length === 0) return null;
  const cidades = pedido.cidades ?? [];
  if (cidades.length < destinos.length) return null;

  const hoje = destinos.map((d) => ({
    cidade: String(d?.city ?? ''),
    dias: Array.isArray(d?.itinerary) ? d.itinerary.length : 0,
  }));
  if (hoje.some((h) => h.dias < 1)) return null;

  const pecas = [];
  let dia = 1;
  for (let i = 0; i < hoje.length; i++) {
    const pedida = cidades[i];
    if (!mesmaCidade(pedida.destination, hoje[i].cidade)) return null;
    if (pedida.days < hoje[i].dias) return null;
    const novos = pedida.days - hoje[i].dias;
    if (novos > 0) {
      pecas.push({
        tipo: 'estender',
        indice: i,
        cidade: hoje[i].cidade,
        diasHoje: hoje[i].dias,
        diasNovos: novos,
        primeiroDia: dia + hoje[i].dias,
      });
    }
    dia += pedida.days;
  }
  for (let i = hoje.length; i < cidades.length; i++) {
    pecas.push({
      tipo: 'nova',
      destination: cidades[i].destination,
      dias: cidades[i].days,
      primeiroDia: dia,
      vemDe: i === hoje.length
        ? hoje[hoje.length - 1].cidade
        : cidades[i - 1].destination.split(',')[0].trim(),
    });
    dia += cidades[i].days;
  }
  if (pecas.length === 0) return null;
  return { pecas, diasAntes: hoje.reduce((s, h) => s + h.dias, 0) };
}

/// Os lugares que já estão no roteiro: atividades, backups e hospedagens.
function lugaresDoRoteiro(roteiroAtual) {
  const roteiro = comoMapa(roteiroAtual);
  const lugares = [];
  for (const d of roteiro?.destinations ?? []) {
    const cidade = String(d?.city ?? '');
    const add = (o) => {
      const nome = String(o?.place ?? o?.name ?? '').trim();
      if (nome) lugares.push({ nome, cidade, busca: String(o?.maps_search_query ?? '') });
    };
    if (d?.accommodation) add(d.accommodation);
    for (const dia of d?.itinerary ?? []) for (const a of dia?.activities ?? []) add(a);
    for (const b of d?.backup_activities ?? []) add(b);
  }
  return lugares;
}

/// O prompt do acréscimo.
///
/// É o prompt da geração inteira até o schema -- perfil, vibes, ritmo,
/// orçamento, regras de custo e de reserva valem iguais --, e no lugar
/// do schema entra o que já existe, o que nunca repetir e o que escrever.
function montarPromptDoAcrescimo(promptDaGeracao, plano, roteiroAtual, { pt, travelers }) {
  const i = promptDaGeracao.indexOf(MARCA_DO_SCHEMA);
  if (i < 0) throw new Error('Prompt da geração sem a marca do schema.');
  const base = promptDaGeracao.slice(0, i);

  const roteiro = comoMapa(roteiroAtual);
  let dia = 1;
  const existe = (roteiro?.destinations ?? []).map((d) => {
    const n = (d?.itinerary ?? []).length;
    const linha = `  - ${d?.city}: ${n === 1 ? `day ${dia}` : `days ${dia} to ${dia + n - 1}`} (in the current numbering)`;
    dia += n;
    return linha;
  });

  const lugares = lugaresDoRoteiro(roteiro).map(
    (l) => `  - ${l.nome} (${l.cidade})`,
  );

  const pedidos = plano.pecas.map((p, k) => {
    if (p.tipo === 'estender') {
      const ultimo = p.primeiroDia + p.diasNovos - 1;
      const dias = p.diasNovos === 1 ? `day ${p.primeiroDia}` : `days ${p.primeiroDia} to ${ultimo}`;
      return `  ${k + 1}. ${p.cidade}: ${p.diasNovos} NEW day(s), numbered ${dias}, continuing the stay that already has ${p.diasHoje} day(s) there. The traveler keeps the same accommodation: do not write one. Write this piece as { "city", "itinerary", "backup_activities" }.`;
    }
    const ultimo = p.primeiroDia + p.dias - 1;
    return `  ${k + 1}. ${p.destination}: a NEW city, ${p.dias} day(s), numbered days ${p.primeiroDia} to ${ultimo}, arriving from ${p.vemDe}. Write the FULL destination object: city, city_slug, unsplash_search_query, days, city_cultural_summary, arrival_transfer (from ${p.vemDe}), accommodation, itinerary and backup_activities.`;
  });

  const custo = pt ? '"BRL 150 por pessoa" ou "BRL 300 no total"' : '"BRL 150 per person" or "BRL 300 total"';

  return `${base}  ===== THIS IS AN EXTENSION OF AN ITINERARY THAT ALREADY EXISTS =====
  Everything above describes the WHOLE trip after the change. Most of it is already written, and the traveler is keeping it exactly as it is, bookings included. You write ONLY the missing pieces listed below. Where this section disagrees with anything above, THIS SECTION WINS.

  WHAT ALREADY EXISTS (fixed; do not rewrite, do not repeat):
${existe.join('\n')}

  PLACES ALREADY IN THE ITINERARY. NEVER suggest any of them again: not as an activity, not as a backup, not under another name or spelling:
${lugares.join('\n')}

  WHAT YOU MUST WRITE, in this order:
${pedidos.join('\n')}

  The pace rule above holds for EACH new day: the same number of activities per day, not fewer, not more. Backups: for each piece, 30% of its NEW activities rounded up, minimum 4 for a new city and minimum 2 for an extended one, none of them repeating a place above or another new place.
  Do not write trip_title, cost_breakdown, estimated_cost_brl, origin_transfer or the checklist: they already exist.

  Your response MUST be EXCLUSIVELY a raw JSON object, without markdown formatting or code blocks, with this exact SCHEMA:

  {
    "added_cost": {
      "accommodation": 800,
      "activities_and_tickets": 400,
      "food_not_listed": 300,
      "local_transport": 120
    },
    "quick_facts": [
      { "city_name": "...", "city_slug": "...", "country_name": "...", "country_slug": "...", "currency": "...", "plug_type": "...", "voltage": "...", "transport": "...", "emergency_number": "...", "language": "...", "weather_avg": "...", "tipping_culture": "..." }
    ],
    "pieces": [
      {
        "city": "City Name",
        "itinerary": [
          {
            "day": ${plano.pecas[0].primeiroDia},
            "activities": [
              {
                "place": "Specific Place or Restaurant Name",
                "description": "Deep, immersive description of what to do, see, or eat there.",
                "logistics": "Actionable tips: best time to go, how to get there, tickets.",
                "period": "Morning/Afternoon/Evening",
                "cost_estimate": ${custo},
                "booking_required": false,
                "maps_search_query": "The perfect Google Maps search string, including city and country"
              }
            ]
          }
        ],
        "backup_activities": [
          { "place": "...", "description": "...", "logistics": "...", "cost_estimate": "...", "booking_required": false, "maps_search_query": "..." }
        ]
      }
    ]
  }

  - "pieces" has EXACTLY ${plano.pecas.length} entr${plano.pecas.length === 1 ? 'y' : 'ies'}, one per item of the list above, in the same order.
  - "added_cost" is ONLY what you are adding, for the whole group of ${travelers ?? 1}, integers in BRL. "accommodation" covers the extra nights (the extended cities keep their current accommodation and its nightly price). "local_transport" includes the arrival transfer of a new city.
  - "quick_facts" has one entry per NEW city only, with the same city-specific rules as above; it is an empty array when no city is new.`;
}

function copiaFunda(o) {
  return JSON.parse(JSON.stringify(o));
}

/// Tira das peças o que repete o roteiro de hoje, ou outra peça.
///
/// Atividade repetida vira um backup novo da mesma peça, no mesmo
/// período; sem backup que sirva, ela sai. Backup repetido sai. Devolve
/// quantas foram trocadas e quantas saíram.
function semRepeticao(pecas, roteiroAtual) {
  const vistos = new Set();
  const marcar = (o) => {
    for (const k of [chave(o?.place ?? o?.name), chave(o?.maps_search_query)]) {
      if (k) vistos.add(k);
    }
  };
  const repete = (o) =>
    [chave(o?.place), chave(o?.maps_search_query)].some((k) => k && vistos.has(k));

  for (const l of lugaresDoRoteiro(roteiroAtual)) {
    marcar({ place: l.nome, maps_search_query: l.busca });
  }

  let trocadas = 0;
  let removidas = 0;
  for (const peca of pecas) {
    if (peca?.accommodation) marcar(peca.accommodation);
    const reservas = (Array.isArray(peca?.backup_activities) ? peca.backup_activities : [])
      .filter((b) => !repete(b));
    for (const dia of Array.isArray(peca?.itinerary) ? peca.itinerary : []) {
      const saida = [];
      for (const a of Array.isArray(dia?.activities) ? dia.activities : []) {
        if (!repete(a)) {
          marcar(a);
          saida.push(a);
          continue;
        }
        let k = reservas.findIndex((b) => !repete(b));
        if (k >= 0) {
          const [b] = reservas.splice(k, 1);
          marcar(b);
          saida.push({ ...b, period: a.period });
          trocadas++;
        } else {
          removidas++;
        }
      }
      dia.activities = saida;
    }
    const backups = [];
    for (const b of reservas) {
      if (repete(b)) continue;
      marcar(b);
      backups.push(b);
    }
    peca.backup_activities = backups;
  }
  return { trocadas, removidas };
}

/// O roteiro das peças, com os dias já no número final: é o que a
/// validação de lugares confere, sem passar pelo roteiro de hoje.
function roteiroDasPecas(pecas, plano) {
  return {
    destinations: pecas.map((peca, k) => {
      const p = plano.pecas[k];
      (peca.itinerary ?? []).forEach((dia, j) => {
        dia.day = p.primeiroDia + j;
      });
      return peca;
    }),
  };
}

function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/// O roteiro de hoje com as peças, e os dias numerados de 1 até o fim.
function aplicarAcrescimo(roteiroAtual, plano, resposta) {
  const pecas = resposta?.pieces;
  if (!Array.isArray(pecas) || pecas.length !== plano.pecas.length) {
    throw new Error(
      `Acréscimo veio com ${Array.isArray(pecas) ? pecas.length : 0} peça(s); eram ${plano.pecas.length}.`,
    );
  }
  const roteiro = copiaFunda(comoMapa(roteiroAtual));

  plano.pecas.forEach((p, k) => {
    const peca = pecas[k];
    const dias = Array.isArray(peca?.itinerary) ? peca.itinerary : [];
    if (p.tipo === 'estender') {
      const destino = roteiro.destinations[p.indice];
      destino.itinerary = [...(destino.itinerary ?? []), ...dias];
      destino.days = destino.itinerary.length;
      destino.backup_activities = [
        ...(destino.backup_activities ?? []),
        ...(Array.isArray(peca?.backup_activities) ? peca.backup_activities : []),
      ];
    } else {
      roteiro.destinations.push({ ...peca, days: dias.length });
    }
  });

  let n = 1;
  for (const d of roteiro.destinations) {
    for (const dia of d.itinerary ?? []) dia.day = n++;
  }

  const custo = resposta?.added_cost ?? {};
  const linhas = ['accommodation', 'activities_and_tickets', 'food_not_listed', 'local_transport'];
  let somado = 0;
  if (roteiro.cost_breakdown && typeof roteiro.cost_breakdown === 'object') {
    for (const l of linhas) {
      const v = numero(custo[l]);
      roteiro.cost_breakdown[l] = numero(roteiro.cost_breakdown[l]) + v;
      somado += v;
    }
  } else {
    somado = linhas.reduce((s, l) => s + numero(custo[l]), 0);
  }
  if (somado > 0) {
    roteiro.estimated_cost_brl = numero(roteiro.estimated_cost_brl) + somado;
  }

  const fatos = Array.isArray(resposta?.quick_facts) ? resposta.quick_facts : [];
  if (fatos.length > 0) {
    roteiro.concierge = roteiro.concierge ?? {};
    roteiro.concierge.quick_facts = [
      ...(Array.isArray(roteiro.concierge.quick_facts) ? roteiro.concierge.quick_facts : []),
      ...fatos,
    ];
  }
  return roteiro;
}

module.exports = {
  MARCA_DO_SCHEMA,
  chave,
  planoDoAcrescimo,
  lugaresDoRoteiro,
  montarPromptDoAcrescimo,
  semRepeticao,
  roteiroDasPecas,
  aplicarAcrescimo,
};
