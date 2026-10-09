// "Perto de você" (09/10): três destinos curtos a partir da cidade de
// origem, para a Home.
//
// É um modo do mesmo serviço (`modo: 'perto'`), e não um serviço novo:
// a pergunta é da mesma família da sugestão de cidades -- escolha curta
// dentro de um conjunto conhecido, saída pequena --, então vale o mesmo
// Flash e o mesmo teto de tempo. Aprovado pelo Paulo em 09/10 ("gosto
// da sua sugestão do perto de você").
//
// O que volta para cada destino é o que o cartão da Home precisa dizer
// e nada mais: o nome, o texto de busca (que vira o destino da criação),
// o meio e o tempo de viagem, quantos dias cabem e o critério em uma
// linha -- o arquétipo Governante: a Trix sugere e diz por quê.
//
// O tempo de viagem é estimativa do modelo, e a tela diz isso ("cerca
// de 2h de carro"). Nada de coordenada (CLAUDE.md, regra 1).

const QUANTOS = 3;
const MEIOS = ['carro', 'onibus', 'trem', 'aviao'];

function montarPromptPerto({ origin, vibes = [], lang = 'pt' }) {
  const idioma = lang === 'en' ? 'English' : 'Brazilian Portuguese';
  const gostos = vibes.length ? vibes.join(', ') : 'none given';

  return `You suggest short trips that start from the traveler's home city.

HOME CITY: ${origin}
TRAVELER VIBES: ${gostos}

TASK: return exactly ${QUANTOS} destinations for a 2 to 4 day trip starting from the home city.

RULES:
- Real, existing cities or towns only. Never the home city itself. Never invent a place. Never return coordinates.
- Reachable from the home city in at most 5 hours by car, bus or train, or at most 2 hours by plane. Prefer ground transport when it is under 5 hours.
- Three DIFFERENT kinds of trip when possible (for example: beach, mountains, historic town), chosen for the vibes.
- "name" is the short name. "search" is "City, Country" in ${idioma}; for a city in Brazil, put the two-letter state code in the middle: "City, UF, ${lang === 'en' ? 'Brazil' : 'Brasil'}".
- "mode" is one of: "carro", "onibus", "trem", "aviao" -- the realistic way most people go.
- "time" is the usual door-to-door travel time from the home city, as "2h" or "2h30". It is an estimate; be conservative.
- "days" is how many days the trip deserves: 2, 3 or 4.
- "reason" is ONE concrete line in ${idioma}, max 10 words, saying why it fits (what there is to do). No distance (the app shows it), no hype words, no emojis.
- Interpret vibes literally.

Your response MUST be EXCLUSIVELY a raw JSON object matching this schema exactly:
{ "perto": [ { "name": "...", "search": "City, Country", "mode": "carro", "time": "2h30", "days": 3, "reason": "..." } ] }`;
}

/// "2h", "2h30", "45min" -> o mesmo texto, limpo; o resto -> null.
function tempoLimpo(v) {
  const t = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d{1,2}h(\d{2})?$/.test(t)) return t;
  if (/^\d{1,2}min$/.test(t)) return t;
  return null;
}

/// Confere a resposta. Nunca lança; devolve `null` quando nada serve.
///
/// Sai o destino sem nome, sem motivo, com meio fora da lista, com tempo
/// ilegível, repetido, ou que é a própria origem. Os dias ficam entre 2
/// e 4.
function conferirPerto(bruto, { origin }) {
  if (!bruto || typeof bruto !== 'object' || !Array.isArray(bruto.perto)) return null;
  const casa = String(origin ?? '').split(',')[0].trim().toLowerCase();
  const vistos = new Set();
  const descartados = [];
  const perto = [];

  for (const c of bruto.perto) {
    const name = String(c?.name ?? '').trim().slice(0, 80);
    const reason = String(c?.reason ?? '').trim().slice(0, 120);
    const mode = String(c?.mode ?? '').trim().toLowerCase();
    const time = tempoLimpo(c?.time);
    const chave = name.toLowerCase();
    if (!name || !reason || !MEIOS.includes(mode) || !time) {
      descartados.push(`${name || '(sem nome)'}: incompleto`);
      continue;
    }
    if (chave === casa || vistos.has(chave)) {
      descartados.push(`${name}: repetido ou a própria origem`);
      continue;
    }
    vistos.add(chave);
    const d = Math.round(Number(c?.days));
    perto.push({
      name,
      search: String(c?.search ?? '').trim().slice(0, 200) || name,
      mode,
      time,
      days: Number.isFinite(d) ? Math.min(4, Math.max(2, d)) : 3,
      reason,
    });
    if (perto.length === QUANTOS) break;
  }

  if (perto.length === 0) return null;
  return { resposta: { perto }, descartados };
}

module.exports = { montarPromptPerto, conferirPerto, tempoLimpo, QUANTOS, MEIOS };
