// Registra o gasto de token de uma chamada ao modelo.
//
// =====================================================================
// POR QUE ISTO EXISTE
// =====================================================================
//
// Os cinco handlers já LIAM `usageMetadata.totalTokenCount`. O que
// diferia era o destino: o `generateTrip` gravava em
// `trips.tokens_used`, o `generateBrainstorming` em
// `brainstorming.tokens_used`, e os outros três só faziam
// `console.log`. Ou seja, o número existia em todo lugar e sumia em
// três deles.
//
// O custo por roteiro que circula -- US$ 0,08 -- é do modelo de
// GERAÇÃO e ignora tudo que vem depois: troca de atividade, emenda por
// restrição e destilação da memória. Sem somar isso, qualquer decisão
// de preço parte de um número que se sabe incompleto.
//
// =====================================================================
// SEM DEPENDÊNCIA NENHUMA, E ISSO É DELIBERADO
// =====================================================================
//
// Um `insert` não justifica o SDK do Supabase. O `classify-conflicts` é
// o único serviço que NÃO fala com o banco -- ele tem duas variáveis de
// ambiente e `jsonwebtoken` como única dependência -- e dar o SDK a ele
// só para gravar uma linha desfaria justamente a propriedade que o faz
// barato.
//
// Então este módulo usa `fetch` contra o PostgREST, que é o mesmo
// endereço que o SDK usaria por baixo. Node 20 tem `fetch` global. O
// resultado é um módulo que roda igual nos cinco, sem instalar nada em
// lugar nenhum.
//
// =====================================================================
// NUNCA DERRUBA A REQUISIÇÃO DE QUEM CHAMOU
// =====================================================================
//
// Contabilidade não pode quebrar produto. Se o banco estiver fora, se a
// variável faltar, se o PostgREST recusar -- o usuário não pode perder
// o roteiro por causa disso. Toda falha vira log e a função devolve
// `false`; nenhuma propaga.
//
// Pelo mesmo motivo quem chama NÃO deve dar `await` no caminho do
// usuário: o registro é efeito colateral, não etapa.

const TABELA = 'token_usage';

/// Os cinco tipos que a coluna `kind` aceita. A lista é fechada no
/// banco por `check`, e repetida aqui para o erro aparecer no log do
/// serviço em vez de como 400 opaco do PostgREST.
const TIPOS = new Set([
  'generate_trip',
  'brainstorming',
  'micro_activity',
  'traveler_memory',
  'classify_conflicts',
]);

/**
 * Grava uma linha de gasto. Devolve `true` se gravou.
 *
 * `tripId` e `userId` são NULÁVEIS de propósito, e por razões
 * diferentes:
 *
 *   - `userId` some quando a conta é apagada (a chave é `on delete set
 *     null`, porque a LGPD protege o vínculo com a pessoa e não a
 *     contabilidade).
 *   - `tripId` falta em dois casos legítimos: brainstorming que ainda
 *     não virou roteiro -- 80 dos 88 medidos em 18/09 -- e app antigo,
 *     que ainda não manda `trip_id` no corpo. Gravar com nulo é melhor
 *     que não gravar: o total continua certo, só não sabe de quem é.
 */
async function registrarToken({ kind, tokens, tripId, userId, model }) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !chave) {
    // Alto no log, e só. Um serviço que sobe sem a variável passa a não
    // contar, e silêncio aqui viraria "o número está baixo" meses
    // depois -- que é o sintoma mais caro que este produto já teve.
    console.warn(
      `[Token] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente: ${kind} nao foi contado.`,
    );
    return false;
  }

  if (!TIPOS.has(kind)) {
    console.warn(`[Token] tipo desconhecido "${kind}": nao foi contado.`);
    return false;
  }

  const quantos = Number(tokens);
  if (!Number.isFinite(quantos) || quantos <= 0) {
    // Zero não é gasto, é ausência de medida -- e linha com zero
    // poluiria a média sem acrescentar informação.
    return false;
  }

  const linha = {
    kind,
    tokens: Math.round(quantos),
    trip_id: Number.isFinite(Number(tripId)) && Number(tripId) > 0
      ? Number(tripId)
      : null,
    user_id: userId || null,
    model: model || null,
  };

  try {
    const resposta = await fetch(`${url}/rest/v1/${TABELA}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: chave,
        Authorization: `Bearer ${chave}`,
        // Sem retorno: a linha gravada não interessa a ninguém aqui, e
        // pedir representação é corpo de resposta de graça.
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(linha),
    });

    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      console.warn(
        `[Token] ${kind} nao gravado (${resposta.status}): ${detalhe.slice(0, 200)}`,
      );
      return false;
    }

    console.log(
      `[Token] ${kind}: ${linha.tokens} tokens` +
        `${linha.trip_id ? ` (roteiro ${linha.trip_id})` : ' (sem roteiro)'}`,
    );
    return true;
  } catch (erro) {
    console.warn(`[Token] ${kind} nao gravado: ${erro.message}`);
    return false;
  }
}

module.exports = { registrarToken, TIPOS };
