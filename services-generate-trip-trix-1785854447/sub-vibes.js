// As sub-vibes do roteiro (13/11): o "o quê" dentro de cada vibe.
//
// A vibe continua em `trips.vibe_tags` (inglês, juntas por ', '). A
// sub-vibe é a escolha mais fina dentro dela ("Comida de rua" dentro de
// Gastronomia), e chega em `trips.sub_vibes` como as CHAVES juntas por
// ', ' ('comida_de_rua, achados_locais, estadios'). O texto que o modelo
// lê não mora na row: mora em `trix_subvibes.ai_prompt`, para a Lais e o
// Paulo ajustarem a frase sem build.
//
// A leitura NÃO filtra por `ativa`: roteiro antigo, refeito depois que
// uma sub-vibe saiu do app, continua pedindo o que a pessoa escolheu.
// Chave que não existe na tabela some sem barulho.
//
// O handler resolve as chaves e põe o resultado na própria linha, em
// `sub_vibes_resolvidas`, antes de montar o prompt. Assim a geração, o
// refazer e o acréscimo (que reaproveita o prompt da geração) leem a
// mesma coisa sem mudar a assinatura do `montarPromptDaGeracao`.

'use strict';

// Teto da lista: a coluna é texto livre gravado pelo app, e a URL do
// PostgREST não precisa de 500 chaves num `in`.
const MAX_CHAVES = 40;

/// 'a, b, a,  ' -> ['a', 'b']. Só o formato de chave: minúsculas,
/// dígitos e sublinhado. O resto é descartado antes de ir ao banco.
function chavesDaLinha(texto) {
  if (typeof texto !== 'string') return [];
  const vistas = new Set();
  for (const parte of texto.split(',')) {
    const c = parte.trim().toLowerCase();
    if (/^[a-z0-9_]{1,60}$/.test(c)) vistas.add(c);
    if (vistas.size >= MAX_CHAVES) break;
  }
  return [...vistas];
}

/// 'Wine, Old town' -> ['Wine', 'Old town'].
function vibesDaLinha(texto) {
  if (typeof texto !== 'string') return [];
  return texto.split(',').map((v) => v.trim()).filter(Boolean);
}

/// A frase do banco, numa linha só e sem pontuação no fim: ela entra no
/// meio de uma frase do prompt.
function fraseLimpa(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().replace(/[\s.;,]+$/, '');
}

/// Lê as sub-vibes da linha em `trix_subvibes`. Nunca lança: falha do
/// banco não derruba a geração, que segue só com as vibes (o log diz).
async function resolverSubVibes(supabase, linha) {
  const chaves = chavesDaLinha(linha?.sub_vibes);
  if (chaves.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from('trix_subvibes')
      .select('vibe_tag, chave, ai_prompt, ordem')
      .in('chave', chaves);
    if (error) throw new Error(error.message);
    const lidas = Array.isArray(data) ? data : [];
    const ignoradas = chaves.filter((c) => !lidas.some((s) => s?.chave === c));
    if (ignoradas.length) {
      console.warn(`[Sub-vibes] Trip ${linha?.id}: chave(s) desconhecida(s) ignorada(s): ${ignoradas.join(', ')}.`);
    }
    return lidas;
  } catch (erro) {
    console.error(`[Sub-vibes] Trip ${linha?.id}: leitura falhou, segue sem sub-vibes: ${erro.message}`);
    return [];
  }
}

/// As linhas do prompt que vêm logo depois de "Main interests". Vazio
/// quando não há sub-vibe nem esporte: o texto dos roteiros de antes
/// não muda uma vírgula.
///
/// `resolvidas` são linhas de `trix_subvibes` (vibe_tag, chave,
/// ai_prompt, ordem). Os grupos seguem a ordem das `vibe_tags`; dentro
/// do grupo, a `ordem` da tabela. Sub-vibe cuja vibe não está nas tags
/// (a pessoa desmarcou a vibe e a sub ficou) ainda é escolha dela: entra
/// depois, na ordem em que aparece.
function linhasDasSubVibes(vibeTags, resolvidas) {
  const vibes = vibesDaLinha(vibeTags);
  const subs = (Array.isArray(resolvidas) ? resolvidas : [])
    .filter((s) => s && typeof s.vibe_tag === 'string' && fraseLimpa(s.ai_prompt) !== '');

  const grupos = new Map(); // vibe em minúsculas -> { nome, itens }
  for (const v of vibes) {
    const k = v.toLowerCase();
    if (!grupos.has(k)) grupos.set(k, { nome: v, itens: [] });
  }
  for (const s of subs) {
    const k = s.vibe_tag.trim().toLowerCase();
    if (!grupos.has(k)) grupos.set(k, { nome: s.vibe_tag.trim(), itens: [] });
    const g = grupos.get(k);
    if (!g.itens.some((i) => i.chave === s.chave)) g.itens.push(s);
  }

  const partes = [];
  for (const g of grupos.values()) {
    if (g.itens.length === 0) continue;
    const itens = [...g.itens].sort((a, b) => (Number(a.ordem) || 0) - (Number(b.ordem) || 0));
    partes.push(`${g.nome}: ${itens.map((i) => fraseLimpa(i.ai_prompt)).join('; ')}.`);
  }

  const linhas = [];
  if (partes.length) linhas.push(`Within those interests, specifically: ${partes.join(' ')}`);

  // Esporte sem calendário de eventos. O modelo não sabe a tabela de
  // jogos, e um "Flamengo x Vasco no sábado" inventado é o pior tipo de
  // alucinação: a pessoa compra passagem por ele. Vale com ou sem
  // sub-vibe, sempre que houver esporte no pedido.
  const temEsporte = grupos.has('sports')
    && (vibes.some((v) => v.toLowerCase() === 'sports') || grupos.get('sports').itens.length > 0);
  if (temEsporte) {
    linhas.push('There is no event calendar for this trip: NEVER schedule or promise a specific match, game, show or event on a given date, nor tickets for one. Stadium visits, stadium tours and club museums are fine.');
  }
  return linhas;
}

module.exports = { chavesDaLinha, vibesDaLinha, resolverSubVibes, linhasDasSubVibes, MAX_CHAVES };
