// O filtro de vibes pelo destino (13/11): `modo: 'vibes'`.
//
// O app mostra as vibes e as sub-vibes no passo das vibes, ANTES das
// cidades, e já sabe o destino. Praia em Belo Horizonte, neve em
// Teresina e vinícola onde não há nenhuma a duas horas são opções que só
// fazem a pessoa escolher o que o roteiro não vai entregar. Este modo
// pergunta ao Flash quais opções CLARAMENTE não cabem no destino, e o
// app as esconde.
//
// É um modo do mesmo serviço, como o `perto`: pergunta curta, saída
// pequena, o mesmo Flash. Na dúvida a opção fica -- esconder o que cabia
// é pior que mostrar o que não cabe, porque a pessoa nem fica sabendo.
//
// A resposta é por destino e não por pessoa, então fica guardada no
// banco, em `vibes_do_destino`, por 90 dias: o segundo "Belo Horizonte"
// não chama o modelo. O destino é a chave depois de normalizado
// (minúsculas, espaços colapsados).
//
// Toda falha devolve `{ fora: [] }` com 200: o app mostra tudo quando o
// filtro não responde, que é o comportamento de antes deste modo.

'use strict';

const MAX_OPCOES = 80;
const MAX_DESTINO = 200;
const VALIDADE_DO_CACHE_DIAS = 90;
const TABELA = 'vibes_do_destino';

/// '  Belo   Horizonte ' -> 'belo horizonte'.
function normalizarDestino(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, MAX_DESTINO);
}

/// As opções do pedido: `{ chave, nome }`, as duas texto curto numa
/// linha. Malformada sai, chave repetida entra uma vez, e no máximo 80.
function lerOpcoes(bruto) {
  if (!Array.isArray(bruto)) return [];
  const vistas = new Set();
  const opcoes = [];
  for (const o of bruto) {
    if (!o || typeof o !== 'object') continue;
    if (typeof o.chave !== 'string' || typeof o.nome !== 'string') continue;
    const chave = o.chave.replace(/\s+/g, ' ').trim();
    const nome = o.nome.replace(/\s+/g, ' ').trim();
    if (!chave || chave.length > 60 || !nome || nome.length > 120) continue;
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    opcoes.push({ chave, nome });
    if (opcoes.length === MAX_OPCOES) break;
  }
  return opcoes;
}

function montarPromptVibes({ destination, opcoes }) {
  const lista = opcoes.map((o) => `- ${o.chave}: ${o.nome}`).join('\n');
  return `You check which trip interests make no sense at a destination.

DESTINATION: ${destination}

OPTIONS (id: what it means):
${lista}

TASK: return the ids of the options that CLEARLY cannot be done at or near this destination, within about 2 hours by road from it.

RULES:
- Be conservative. When unsure, or when the option is possible even if it is not what the place is known for, KEEP it (do not return it).
- Judge the whole destination: if it is a country or a region, an option is out only if it is impossible across all of it.
- Examples of options that are out: sea beach options in a landlocked city with no sea beach within about 2 hours (Belo Horizonte); snow or ski in a tropical city (Teresina); winery visits where there is no winery within about 2 hours.
- City-level options (restaurants, bars, museums, markets, neighborhoods, parks, spas) are almost never out in a real city.
- Use only ids from the list above, exactly as written. Never invent an id.

Your response MUST be EXCLUSIVELY a raw JSON object matching this schema exactly:
{ "fora": ["id", "..."] }`;
}

/// A resposta do modelo -> só as chaves pedidas, na ordem do pedido.
/// Nunca lança: resposta fora do formato vale como "nada fora".
function conferirVibes(bruto, chavesPedidas) {
  const lista = bruto && typeof bruto === 'object' && Array.isArray(bruto.fora) ? bruto.fora : [];
  const vindas = new Set(
    lista.filter((c) => typeof c === 'string').map((c) => c.trim().toLowerCase()),
  );
  return chavesPedidas.filter((c) => vindas.has(c.toLowerCase()));
}

/// A linha do cache serve? Serve quando é mais nova que 90 dias e já
/// avaliou TODAS as chaves pedidas. Devolve o `fora` dela restrito ao
/// pedido, ou `null` quando é preciso perguntar ao modelo.
function respostaDoCache(linha, chavesPedidas, agora = Date.now()) {
  if (!linha || typeof linha !== 'object') return null;
  const criado = Date.parse(linha.criado_em);
  if (!Number.isFinite(criado)) return null;
  if (agora - criado >= VALIDADE_DO_CACHE_DIAS * 86400000) return null;
  const avaliadas = new Set(Array.isArray(linha.avaliadas) ? linha.avaliadas : []);
  if (!chavesPedidas.every((c) => avaliadas.has(c))) return null;
  const fora = new Set(Array.isArray(linha.fora) ? linha.fora : []);
  return chavesPedidas.filter((c) => fora.has(c));
}

/// A linha nova do cache. Linha anterior ainda válida: as avaliadas se
/// somam, e o `fora` das chaves que não foram reavaliadas agora fica
/// (senão a união das avaliadas mentiria sobre elas). Linha vencida ou
/// ausente: começa do zero.
function linhaNovaDoCache(destino, anterior, chavesPedidas, fora, agora = Date.now()) {
  const criado = Date.parse(anterior?.criado_em);
  const valida = anterior && Number.isFinite(criado)
    && agora - criado < VALIDADE_DO_CACHE_DIAS * 86400000;
  const pedidas = new Set(chavesPedidas);
  const avaliadasAntes = valida && Array.isArray(anterior.avaliadas) ? anterior.avaliadas : [];
  const foraAntes = valida && Array.isArray(anterior.fora)
    ? anterior.fora.filter((c) => !pedidas.has(c))
    : [];
  return {
    destino,
    fora: [...new Set([...foraAntes, ...fora])],
    avaliadas: [...new Set([...avaliadasAntes, ...chavesPedidas])],
    criado_em: new Date(agora).toISOString(),
  };
}

// =================================================================
// O BANCO, por fetch no PostgREST e com service_role, como o
// `registra-evento`: este serviço não tem o SDK do Supabase, e uma
// leitura e um upsert não o justificam.
// =================================================================
const TETO_BANCO_MS = 3000;

function cabecalhos(chave, extra = {}) {
  return {
    'Content-Type': 'application/json',
    apikey: chave,
    Authorization: `Bearer ${chave}`,
    ...extra,
  };
}

/// A linha do destino, ou `null` (sem linha ou banco fora; o log diz).
async function lerCache(destino) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    console.warn('[Vibes] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente: sem cache.');
    return null;
  }
  try {
    const resposta = await fetch(
      `${url}/rest/v1/${TABELA}?destino=eq.${encodeURIComponent(destino)}&select=destino,fora,avaliadas,criado_em&limit=1`,
      { headers: cabecalhos(chave), signal: AbortSignal.timeout(TETO_BANCO_MS) },
    );
    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      throw new Error(`${resposta.status} ${detalhe.slice(0, 200)}`);
    }
    const linhas = await resposta.json();
    return Array.isArray(linhas) && linhas.length ? linhas[0] : null;
  } catch (erro) {
    console.warn(`[Vibes] Leitura do cache falhou: ${erro.message}`);
    return null;
  }
}

/// Grava a linha. Nunca lança: o `fora` já está pronto para a pessoa, e
/// cache que não gravou só custa a próxima chamada ao modelo.
async function gravarCache(linha) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) return false;
  try {
    const resposta = await fetch(`${url}/rest/v1/${TABELA}?on_conflict=destino`, {
      method: 'POST',
      headers: cabecalhos(chave, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(linha),
      signal: AbortSignal.timeout(TETO_BANCO_MS),
    });
    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      throw new Error(`${resposta.status} ${detalhe.slice(0, 200)}`);
    }
    return true;
  } catch (erro) {
    console.warn(`[Vibes] Gravação do cache falhou: ${erro.message}`);
    return false;
  }
}

module.exports = {
  normalizarDestino,
  lerOpcoes,
  montarPromptVibes,
  conferirVibes,
  respostaDoCache,
  linhaNovaDoCache,
  lerCache,
  gravarCache,
  MAX_OPCOES,
  VALIDADE_DO_CACHE_DIAS,
};
