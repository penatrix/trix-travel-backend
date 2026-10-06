// Os feriados de um roteiro: o calendário oficial e a leitura do Flash.
//
// =====================================================================
// DUAS FONTES, E POR QUÊ
// =====================================================================
//
// **A Nager.Date** (date.nager.at, grátis e sem chave) dá os feriados
// nacionais e os regionais de cada país, com data certa. É calendário,
// não opinião, e não custa token.
//
// **O Flash** faz o que o calendário não faz:
//   - diz se o feriado regional vale naquela CIDADE (a Nager diz
//     "BR-RJ", o roteiro diz "Paraty");
//   - acrescenta o municipal que ele conhece com certeza (o dia do
//     padroeiro, que não está na Nager);
//   - e, principalmente, diz QUAIS lugares do roteiro fecham naquele
//     dia. O horário do Google é semanal e não sabe de feriado.
//
// Tudo o que vem do Flash é conferido aqui contra o que foi perguntado:
// id que não existe, data fora do roteiro ou feriado em cidade que não
// está nele são descartados. O modelo nunca escreve no roteiro; ele só
// responde à pergunta.
// =====================================================================

const { dataValida } = require('./checagem');

/// País escrito no fim do `maps_search_query` ("…, Lisboa, Portugal")
/// para o código ISO que a Nager usa. Os nomes em inglês da Nager vêm
/// da própria API (`/AvailableCountries`); esta tabela cobre o que ela
/// não casa: o nome em português, quando o modelo escreveu em pt, e as
/// variantes em inglês que aparecem nas buscas.
const APELIDOS = {
  brasil: 'BR', brazil: 'BR',
  portugal: 'PT',
  espanha: 'ES', spain: 'ES',
  franca: 'FR', france: 'FR',
  italia: 'IT', italy: 'IT',
  alemanha: 'DE', germany: 'DE',
  austria: 'AT',
  suica: 'CH', switzerland: 'CH',
  holanda: 'NL', 'paises baixos': 'NL', netherlands: 'NL', 'the netherlands': 'NL',
  belgica: 'BE', belgium: 'BE',
  'reino unido': 'GB', inglaterra: 'GB', escocia: 'GB', 'pais de gales': 'GB',
  uk: 'GB', 'united kingdom': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  irlanda: 'IE', ireland: 'IE',
  grecia: 'GR', greece: 'GR',
  croacia: 'HR', croatia: 'HR',
  'republica tcheca': 'CZ', tchequia: 'CZ', 'czech republic': 'CZ', czechia: 'CZ',
  hungria: 'HU', hungary: 'HU',
  polonia: 'PL', poland: 'PL',
  dinamarca: 'DK', denmark: 'DK',
  suecia: 'SE', sweden: 'SE',
  noruega: 'NO', norway: 'NO',
  finlandia: 'FI', finland: 'FI',
  islandia: 'IS', iceland: 'IS',
  turquia: 'TR', turkey: 'TR', turkiye: 'TR',
  marrocos: 'MA', morocco: 'MA',
  egito: 'EG', egypt: 'EG',
  'estados unidos': 'US', eua: 'US', usa: 'US', 'united states': 'US',
  'united states of america': 'US',
  canada: 'CA',
  mexico: 'MX',
  argentina: 'AR',
  chile: 'CL',
  uruguai: 'UY', uruguay: 'UY',
  paraguai: 'PY', paraguay: 'PY',
  peru: 'PE',
  colombia: 'CO',
  bolivia: 'BO',
  equador: 'EC', ecuador: 'EC',
  japao: 'JP', japan: 'JP',
  'coreia do sul': 'KR', 'south korea': 'KR', korea: 'KR',
  china: 'CN',
  australia: 'AU',
  'nova zelandia': 'NZ', 'new zealand': 'NZ',
  'africa do sul': 'ZA', 'south africa': 'ZA',
};

/// Minúsculas, sem acento e sem espaço sobrando.
function normalizarNome(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/// O último trecho do texto de busca, que é onde o país fica.
function paisDaBusca(busca) {
  const partes = String(busca ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return partes.length >= 2 ? partes[partes.length - 1] : null;
}

/// O código ISO do país de um destino: o país mais citado nas buscas
/// das atividades dele. `disponiveis` é a lista da Nager
/// (`[{ countryCode, name }]`), ou vazia se ela não respondeu.
function codigoDoPais(destino, disponiveis = []) {
  const porNome = new Map(
    (Array.isArray(disponiveis) ? disponiveis : [])
      .filter((p) => p?.countryCode && p?.name)
      .map((p) => [normalizarNome(p.name), p.countryCode]),
  );
  const votos = new Map();
  const buscas = [];
  for (const dia of destino?.itinerary ?? []) {
    for (const a of dia?.activities ?? []) buscas.push(a?.maps_search_query);
  }
  buscas.push(destino?.accommodation?.maps_search_query);
  for (const busca of buscas) {
    const nome = normalizarNome(paisDaBusca(busca));
    if (!nome) continue;
    const codigo = APELIDOS[nome] ?? porNome.get(nome);
    if (codigo) votos.set(codigo, (votos.get(codigo) ?? 0) + 1);
  }
  let melhor = null;
  for (const [codigo, n] of votos) {
    if (!melhor || n > votos.get(melhor)) melhor = codigo;
  }
  return melhor;
}

/// Os feriados da Nager que caem entre `inicio` e `fim` e que são dia
/// de folga ("Public"). Observância e feriado bancário não fecham museu.
function feriadosNoPeriodo(lista, inicio, fim) {
  return (Array.isArray(lista) ? lista : [])
    .filter((f) => {
      const data = dataValida(f?.date);
      if (!data || data < inicio || data > fim) return false;
      const tipos = Array.isArray(f.types) ? f.types : [];
      return tipos.length === 0 || tipos.includes('Public');
    })
    .map((f) => ({
      data: f.date,
      pais: f.countryCode ?? null,
      nome: f.localName || f.name,
      nomeEmIngles: f.name ?? null,
      regioes: Array.isArray(f.counties) && f.counties.length ? f.counties : null,
    }));
}

const DIAS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A pergunta ao Flash.
 *
 * `cidades`: [{ cidade, pais, dias: [{ data, atividades: [{ id, lugar, periodo }] }],
 *               backups: [{ id, lugar }] }]
 * `feriados`: a saída de `feriadosNoPeriodo`, de todos os países.
 *
 * Em inglês, como os outros prompts: o modelo segue regra melhor assim.
 * Os nomes dos feriados voltam no idioma da pessoa.
 */
function montarPerguntaDeFeriados({ cidades, feriados, idioma = 'pt' }) {
  const linhasDeFeriado = feriados.length
    ? feriados.map((f) =>
        `- ${f.data} ${f.pais ?? ''}: ${f.nomeEmIngles ?? f.nome}` +
        `${f.nome && f.nome !== f.nomeEmIngles ? ` (${f.nome})` : ''}, ` +
        `${f.regioes ? `only in ${f.regioes.join(', ')}` : 'nationwide'}`,
      ).join('\n')
    : '- (the official calendar returned none)';

  const linhasDoRoteiro = cidades.map((c) => {
    const dias = c.dias.map((d) => {
      const atividades = d.atividades.length
        ? d.atividades.map((a) => `${a.id} ${a.lugar} (${a.periodo ?? '-'})`).join('; ')
        : '(no activities)';
      return `  ${d.data} (${DIAS_EN[new Date(`${d.data}T12:00:00Z`).getUTCDay()]}): ${atividades}`;
    }).join('\n');
    const backups = c.backups.length
      ? `  Backup places: ${c.backups.map((b) => `${b.id} ${b.lugar}`).join('; ')}`
      : '  Backup places: (none)';
    return `${c.cidade}${c.pais ? `, ${c.pais}` : ''}\n${dias}\n${backups}`;
  }).join('\n\n');

  const idiomaDosNomes = idioma === 'pt' ? 'Brazilian Portuguese' : 'English';

  return `You check a travel itinerary against public holidays. The traveler has just fixed the dates below.

OFFICIAL PUBLIC HOLIDAYS IN THE PERIOD (from a holiday calendar; "only in" lists ISO subdivisions):
${linhasDeFeriado}

ITINERARY (id, place, period), city by city:
${linhasDoRoteiro}

TASKS
1. Decide which holidays apply to each city ON THE DATES IT IS VISITED. Nationwide holidays always apply. A regional one applies only if the city is inside one of the listed subdivisions. Also add municipal or local holidays of these exact cities that you are CERTAIN fall on those dates (for example the city's patron saint day). Never add observances that are not days off.
2. For each applicable holiday, list which places will be CLOSED that day or will not run as planned because of the holiday: the activities scheduled in that city on that date, and that city's backup places. Only list a place when you are confident. Museums, monuments, public buildings, markets and many shops close on major holidays; beaches, parks, viewpoints, streets and outdoor areas do not close. When unsure, leave it out.

Answer ONLY with JSON, no prose:
{"holidays":[{"date":"YYYY-MM-DD","city":"<city exactly as written above>","name":"<holiday name in ${idiomaDosNomes}>"}],"closed":[{"id":"<id>","date":"YYYY-MM-DD"}]}
Use empty arrays when nothing applies.`;
}

/**
 * Lê a resposta do Flash, descartando o que não foi perguntado.
 *
 * `perguntado`: { cidades: Set<string>, datasDaCidade: Map<cidade, Set<data>>,
 *                 lugares: Map<id, { cidade, data|null }> } -- `data` null
 *                 para backup, que pode cair em qualquer dia da cidade.
 *
 * @returns {{ feriados: {data, cidade, nome}[], fechados: Map<string, string> }}
 *          `fechados` vai de "id|data" ao nome do feriado.
 */
function lerRespostaDeFeriados(texto, perguntado) {
  let dados;
  try {
    const limpo = String(texto ?? '').replace(/```json/g, '').replace(/```/g, '').trim();
    dados = JSON.parse(limpo);
  } catch (_) {
    return null;
  }
  if (!dados || typeof dados !== 'object') return null;

  const feriados = [];
  const nomeDoFeriado = new Map(); // "cidade|data" -> nome
  for (const f of Array.isArray(dados.holidays) ? dados.holidays : []) {
    const data = dataValida(f?.date);
    const cidade = typeof f?.city === 'string' ? f.city.trim() : '';
    const nome = typeof f?.name === 'string' ? f.name.trim().slice(0, 80) : '';
    if (!data || !cidade || !nome) continue;
    if (!perguntado.datasDaCidade.get(cidade)?.has(data)) continue;
    const chave = `${cidade}|${data}`;
    if (nomeDoFeriado.has(chave)) continue;
    nomeDoFeriado.set(chave, nome);
    feriados.push({ data, cidade, nome });
  }

  const fechados = new Map();
  for (const c of Array.isArray(dados.closed) ? dados.closed : []) {
    const id = typeof c?.id === 'string' ? c.id.trim() : '';
    const data = dataValida(c?.date);
    const lugar = perguntado.lugares.get(id);
    if (!lugar || !data) continue;
    // A atividade só pode fechar no dia em que está no roteiro.
    if (lugar.data && lugar.data !== data) continue;
    // E só por um feriado que vale naquela cidade, naquele dia.
    const nome = nomeDoFeriado.get(`${lugar.cidade}|${data}`);
    if (!nome) continue;
    fechados.set(`${id}|${data}`, nome);
  }

  feriados.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
  return { feriados, fechados };
}

module.exports = {
  normalizarNome,
  paisDaBusca,
  codigoDoPais,
  feriadosNoPeriodo,
  montarPerguntaDeFeriados,
  lerRespostaDeFeriados,
  APELIDOS,
};
