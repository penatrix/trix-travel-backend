// A parte pura da classificação: montar o pedido e conferir a resposta.
//
// Separada do index.js de propósito. O que mora aqui é onde estão os erros
// que importam - prompt frouxo e resposta malformada - e é o que dá para
// exercitar sem rede. O index.js fica só com a conversa com o modelo.

// =====================================================================
// O ESCOPO, E O LIMITE DELE
//
// O modelo classifica bem "isto é uma pizzaria, conflita com celíaco".
// Ele NÃO sabe dizer se um restaurante específico tem opção sem glúten -
// isso exigiria conhecer o menu de hoje, e inventar essa resposta é
// exatamente a alucinação que os princípios do projeto proíbem.
//
// Então o contrato é assimétrico e o prompt diz isso com todas as letras:
//   - EXCLUIR o que claramente conflita
//   - NUNCA certificar o que acomoda
//
// Na dúvida, não conflita. Um falso positivo tira do roteiro um lugar que
// servia; um falso negativo mantém um lugar que o usuário vai olhar com
// os próprios olhos, sabendo da restrição dele. O primeiro é pior.
// =====================================================================

/// Monta o prompt. `itens` é [{ id, place, description }].
///
/// As instruções vão em inglês, como no resto do projeto - é a língua em
/// que o modelo recebe ordem. Os NOMES dos lugares vão como estão, porque
/// são nomes próprios.
function montarPrompt(restricao, itens) {
  const lista = itens
    .map((i) => `- id=${i.id} | ${i.place}${i.description ? ` | ${i.description}` : ''}`)
    .join('\n');

  return `You are auditing a travel itinerary against a traveler's dietary restriction.

RESTRICTION: ${restricao}

For each item below, decide whether it CLEARLY conflicts with the restriction.

RULES:
1. EXCLUDE only what clearly conflicts by the nature of the place. A pizzeria, a bakery, a pasta house, a beer hall or a craft-beer tasting clearly conflict with a gluten-free restriction. A steakhouse or a seafood restaurant do not.
2. NEVER assume a place accommodates the restriction. You are not being asked whether a place has safe options - you cannot know that. You are only asked whether it clearly conflicts.
3. WHEN IN DOUBT, DO NOT flag it. A false positive removes a place that was fine; a false negative leaves a place the traveler will look at knowing their own restriction. The first is worse.
4. Non-food activities (museums, parks, hikes, viewpoints, shows) NEVER conflict with a dietary restriction. Do not flag them.
5. Judge the PLACE, not the wording. Do not flag something because the description mentions food in passing.

ITEMS:
${lista}

Your response MUST be EXCLUSIVELY a raw JSON object matching this schema exactly:
{
  "conflicts": [
    { "id": "the id exactly as given", "reason": "max 8 words, in English, naming what conflicts" }
  ]
}
Return an empty array if nothing clearly conflicts. Never include an id that is not in the list above.`;
}

/// Confere a resposta do modelo contra os ids que MANDAMOS.
///
/// Isto não é paranoia: o modelo devolvendo um id que não existe, ou
/// repetindo um, faria o app mexer na atividade errada do roteiro. E o
/// custo de um id inventado é alto - a substituição acontece por posição.
///
/// Nunca lança. Resposta inutilizável vira lista vazia, que significa
/// "nada a fazer" - o caminho seguro.
function conferirResposta(bruto, itens) {
  const validos = new Set(itens.map((i) => String(i.id)));
  const vistos = new Set();
  const conflitos = [];
  const descartados = [];

  const lista = Array.isArray(bruto?.conflicts) ? bruto.conflicts : [];

  for (const c of lista) {
    const id = String(c?.id ?? '').trim();

    if (!validos.has(id)) {
      descartados.push(`${id || '(vazio)'}: id nao estava na lista enviada`);
      continue;
    }
    if (vistos.has(id)) {
      descartados.push(`${id}: repetido`);
      continue;
    }

    vistos.add(id);
    conflitos.push({
      id,
      reason: String(c?.reason ?? '').trim().slice(0, 120),
    });
  }

  return { conflitos, descartados };
}

module.exports = { montarPrompt, conferirResposta };
