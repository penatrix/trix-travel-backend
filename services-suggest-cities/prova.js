// A prova de cada cidade: um lugar de verdade por vibe (21/10).
//
// No passo das cidades, quem não conhece Tampere não tem como saber se
// ela combina com "gastronomia" e "vida noturna" sem sair do app -- e
// quem sai talvez não volte (teste com um designer, 17/10). O texto
// genérico da cidade não convence. Um lugar com nome convence: "Vida
// noturna · Vastavirta, bar de rock no centro".
//
// **Nome de lugar só chega à tela conferido no Google** (decisão do
// Paulo, 21/10; CLAUDE.md, "lugares fechados são o pior bug do
// produto"). O modelo propõe; o Places (Text Search, API nova, só id,
// nome e status na máscara) confirma que existe e não está fechado. O
// que não passa sai, sem substituto: uma cidade com uma prova é melhor
// do que uma com três, sendo uma inventada.
//
// Sem a GOOGLE_MAPS_KEY no serviço, nenhum destaque sai. Nunca se mostra
// lugar sem conferir.
//
// Custo: até 3 destaques por cidade do roteiro, as extras não têm. Com
// o teto de 15 cidades seriam 45 consultas; o normal é de 3 a 9.

const URL_TEXT_SEARCH = 'https://places.googleapis.com/v1/places:searchText';
const CAMPOS = 'places.id,places.displayName,places.businessStatus';
const FECHADO = new Set(['CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY']);

/// Por consulta, no máximo. As consultas vão juntas, então isto é quase
/// o teto da conferência inteira. Quem chama passa um prazo menor quando
/// o Gemini demorou: o app espera 15 s (nas builds de antes de 21/10) e
/// a resposta inteira tem que chegar antes.
const TETO_POR_CONSULTA_MS = 4000;

/// Menos que isto pela frente, nem consulta: a sugestão sai sem os
/// lugares, que é melhor do que não sair.
const MINIMO_PARA_CONFERIR_MS = 1000;

const MAX_DESTAQUES = 3;

/// Limpa os destaques que o modelo devolveu para uma cidade. Só vale a
/// vibe que a pessoa escolheu, escrita como ela veio; uma vibe por
/// destaque; nome, busca e linha obrigatórios. Pura.
function limparDestaques(brutos, vibes) {
  const permitidas = new Map(vibes.map((v) => [v.toLowerCase(), v]));
  const usadas = new Set();
  const saida = [];
  for (const d of Array.isArray(brutos) ? brutos : []) {
    const vibe = permitidas.get(String(d?.vibe ?? '').trim().toLowerCase());
    const place = String(d?.place ?? '').trim().slice(0, 80);
    const line = String(d?.line ?? '').trim().slice(0, 90);
    const search = String(d?.search ?? '').trim().slice(0, 160);
    if (!vibe || !place || !line || !search) continue;
    if (usadas.has(vibe.toLowerCase())) continue;
    usadas.add(vibe.toLowerCase());
    saida.push({ vibe, place, line, search });
    if (saida.length === MAX_DESTAQUES) break;
  }
  return saida;
}

/// O veredito do Places para um lugar. Pura, para o teste.
///
///   - sem resultado: não existe (ou a busca não acha) -> sai;
///   - fechado, temporária ou permanentemente -> sai;
///   - sem status: praça, mirante, praia -> fica, como na geração.
function lugarConfere(dados) {
  const primeiro = dados?.places?.[0];
  if (!primeiro) return false;
  return !FECHADO.has(primeiro.businessStatus);
}

async function consultar(busca, apiKey, fetcher, prazoMs) {
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), prazoMs);
  try {
    const resposta = await fetcher(URL_TEXT_SEARCH, {
      method: 'POST',
      signal: controlador.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': CAMPOS,
      },
      body: JSON.stringify({ textQuery: busca, pageSize: 1 }),
    });
    if (!resposta.ok) return false;
    return lugarConfere(await resposta.json());
  } catch {
    // Erro de rede ou prazo: sem conferência, sem nome na tela.
    return false;
  } finally {
    clearTimeout(alarme);
  }
}

/// Confere os destaques de todas as cidades do roteiro, em paralelo, e
/// devolve a sugestão só com os que passaram, mais o número de consultas
/// (vai para a linha de custo). Nunca lança.
async function conferirDestaques(sugestao, apiKey, {
  fetcher = fetch,
  prazoMs = TETO_POR_CONSULTA_MS,
} = {}) {
  const cidades = sugestao.itinerary;
  const prazo = Math.min(TETO_POR_CONSULTA_MS, prazoMs);
  if (!apiKey || prazo < MINIMO_PARA_CONFERIR_MS) {
    for (const c of cidades) c.highlights = [];
    return { sugestao, consultas: 0, recusados: 0 };
  }
  let consultas = 0;
  let recusados = 0;
  await Promise.all(cidades.map(async (cidade) => {
    const destaques = cidade.highlights ?? [];
    const vereditos = await Promise.all(destaques.map((d) => {
      consultas += 1;
      return consultar(d.search, apiKey, fetcher, prazo);
    }));
    cidade.highlights = destaques.filter((_, i) => vereditos[i]);
    recusados += destaques.length - cidade.highlights.length;
  }));
  return { sugestao, consultas, recusados };
}

module.exports = {
  limparDestaques,
  lugarConfere,
  conferirDestaques,
  MAX_DESTAQUES,
  TETO_POR_CONSULTA_MS,
};
