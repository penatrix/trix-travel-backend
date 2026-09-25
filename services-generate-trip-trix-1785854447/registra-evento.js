// Registra um evento do backend: o que aconteceu, quanto custou e se deu
// certo.
//
// =====================================================================
// POR QUE ISTO SUBSTITUIU O `registra-token`
// =====================================================================
//
// A primeira versão gravava uma linha por chamada ao modelo, com um
// número só: `tokens`. Ela resolveu o problema de então -- o gasto de
// três serviços sumia em `console.log` -- e criou dois outros, que o
// levantamento do BP de 21/09 expôs:
//
//   1. **Entrada e saída custam diferente, e muito.** A fatura do
//      Google entre junho e setembro mostra a saída custando SEIS vezes
//      a entrada (Pro: R$ 70,44 contra R$ 11,74 por milhão), e a fatia
//      de entrada subindo de 17% para 27% do gasto. Um total somado
//      não responde "quanto custou", porque o mesmo total tem preços
//      diferentes conforme a proporção.
//
//   2. **Só o sucesso era contado.** Chamada que estourou timeout ou
//      voltou erro não gravava linha nenhuma -- mas gasta token na
//      entrada do mesmo jeito, e é justamente o caso que a gente
//      precisa ver. As nove primeiras falhas da história do produto só
//      apareceram por resgate manual do Cloud Logging, em 21/09.
//
// A tabela `eventos` responde as duas, e mais uma que a `token_usage`
// não tinha como responder: **chamada do Google Places**, que em
// setembro passou a custar quase o mesmo que o Gemini (R$ 25,67 contra
// R$ 26,57).
//
// =====================================================================
// O `trip_id` NÃO TEM CHAVE ESTRANGEIRA, E ISSO É DE PROPÓSITO
// =====================================================================
//
// Era `on delete set null` na `token_usage`: roteiro apagado levava
// junto o vínculo, e o custo virava linha órfã. O resgate de 21/09
// achou NOVE roteiros gerados que não existem mais -- 17% das gerações
// da janela. Custo real, pago, invisível para qualquer contagem feita
// pela tabela `trips`.
//
// A exclusão é permanente por LGPD e continua sendo: o que fica é o
// número, não o roteiro. `user_id` esse sim é `on delete set null`,
// porque o que a lei protege é o vínculo com a pessoa, não a
// contabilidade.
//
// =====================================================================
// SEM DEPENDÊNCIA NENHUMA, E ISSO TAMBÉM É DELIBERADO
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
// resultado é um módulo que roda igual nos seis, sem instalar nada em
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

const TABELA = 'eventos';

/// Os tipos que o BACKEND grava. A coluna aceita mais -- `roteiro_aberto`,
/// `checklist_marcado` e os outros vêm do app, pela RPC
/// `registrar_evento_do_app` -- e essa separação é o ponto: aqui só entra
/// o que custa dinheiro numa API externa.
///
/// A lista é fechada no banco por `check`, e repetida aqui para o erro
/// aparecer no log do serviço em vez de como 400 opaco do PostgREST.
const TIPOS = new Set([
  'geracao_roteiro',
  'brainstorming',
  'troca_atividade',
  'emenda_restricao',
  'memoria_viajante',
  'busca_lugares',
  // O Flash do passo 3 do wizard (25/09). O `check` da coluna no banco
  // precisa aceitar este valor, senão a linha volta 400 e o módulo só
  // avisa no log -- ver o services-suggest-cities/cloudbuild.yaml.
  'sugestao_cidades',
]);

const STATUS = new Set(['ok', 'erro', 'timeout']);

/**
 * Lê o `usageMetadata` do Gemini e separa entrada de saída.
 *
 * A separação mora AQUI, e não nos seis pontos de chamada, porque ela
 * tem uma sutileza que não sobreviveria a seis cópias: **o pensamento
 * conta como saída**. O `thoughtsTokenCount` é cobrado na tarifa de
 * saída, que é a cara, e fica fora do `candidatesTokenCount`. Somar só
 * candidates subestimaria justamente a linha que mais pesa na fatura --
 * e o erro só apareceria como "a conta do Google não bate", meses
 * depois.
 *
 * Devolve `null` em cada campo que não veio. Null é "não medido"; zero
 * seria "medido zero", e a diferença importa porque a média de token
 * por roteiro ignora null e engoliria zero. É a mesma distinção do
 * `flights` que sai 0 no `cost_breakdown` sem cidade de origem: valor
 * presente, informação ausente.
 */
function lerUso(uso) {
  const numero = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };

  if (!uso || typeof uso !== 'object') {
    return { entrada: null, saida: null, total: null };
  }

  const entrada = numero(uso.promptTokenCount);
  const candidatos = numero(uso.candidatesTokenCount);
  const pensamento = numero(uso.thoughtsTokenCount);
  const total = numero(uso.totalTokenCount);

  let saida = null;
  if (candidatos != null || pensamento != null) {
    saida = (candidatos ?? 0) + (pensamento ?? 0);
  } else if (total != null && entrada != null) {
    // Resposta antiga ou parcial: o que sobra do total depois da entrada
    // é saída. Pior que o número explícito, melhor que nulo.
    saida = Math.max(0, total - entrada);
  }

  return {
    entrada,
    saida,
    total: total ?? (entrada != null || saida != null
      ? (entrada ?? 0) + (saida ?? 0)
      : null),
  };
}

/**
 * Classifica um erro em `timeout` ou `erro`.
 *
 * Timeout merece coluna própria porque a resposta é diferente: erro
 * pede conserto de código, timeout pede folga no teto ou prompt menor.
 * Confundir os dois é o que faz "está lento" e "está quebrado" virarem
 * a mesma linha na planilha.
 */
function statusDoErro(erro) {
  const nome = erro?.name ?? '';
  const texto = String(erro?.message ?? erro ?? '');
  if (nome === 'AbortError') return 'timeout';
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT|abort/i.test(texto)) return 'timeout';
  return 'erro';
}

/**
 * Grava uma linha de evento. Devolve `true` se gravou.
 *
 * `tripId` e `userId` são NULÁVEIS de propósito, e por razões
 * diferentes:
 *
 *   - `userId` some quando a conta é apagada (a chave é `on delete set
 *     null`, porque a LGPD protege o vínculo com a pessoa e não a
 *     contabilidade).
 *   - `tripId` falta em dois casos legítimos: brainstorming que ainda
 *     não virou roteiro, e app antigo, que ainda não manda `trip_id` no
 *     corpo. Gravar com nulo é melhor que não gravar: o total continua
 *     certo, só não sabe de quem é.
 *
 * `uso` é o `usageMetadata` CRU da resposta do Gemini, não três números
 * já separados -- ver `lerUso`.
 */
async function registrarEvento({
  tipo,
  status = 'ok',
  motivo = null,
  tripId = null,
  userId = null,
  modelo = null,
  uso = null,
  chamadasPlaces = null,
  duracaoMs = null,
  meta = null,
}) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !chave) {
    // Alto no log, e só. Um serviço que sobe sem a variável passa a não
    // contar, e silêncio aqui viraria "o número está baixo" meses
    // depois -- que é o sintoma mais caro que este produto já teve.
    console.warn(
      `[Evento] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente: ${tipo} nao foi registrado.`,
    );
    return false;
  }

  if (!TIPOS.has(tipo)) {
    console.warn(`[Evento] tipo desconhecido "${tipo}": nao foi registrado.`);
    return false;
  }

  if (!STATUS.has(status)) {
    console.warn(`[Evento] status desconhecido "${status}": nao foi registrado.`);
    return false;
  }

  const tokens = lerUso(uso);
  const inteiroNaoNegativo = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  };

  const linha = {
    tipo,
    status,
    // O motivo é o que transforma uma linha de erro em diagnóstico. Vai
    // truncado porque `error.message` de JSON quebrado carrega o texto
    // inteiro do modelo, e isso não é motivo, é despejo.
    motivo: motivo ? String(motivo).slice(0, 500) : null,
    trip_id: Number.isFinite(Number(tripId)) && Number(tripId) > 0
      ? Number(tripId)
      : null,
    user_id: userId || null,
    modelo: modelo || null,
    tokens_entrada: tokens.entrada,
    tokens_saida: tokens.saida,
    tokens_total: tokens.total,
    chamadas_places: inteiroNaoNegativo(chamadasPlaces),
    duracao_ms: inteiroNaoNegativo(duracaoMs),
    origem: 'backend',
    meta: meta && typeof meta === 'object' ? meta : null,
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
        `[Evento] ${tipo} nao registrado (${resposta.status}): ${detalhe.slice(0, 200)}`,
      );
      return false;
    }

    const partes = [`[Evento] ${tipo}/${status}`];
    if (linha.tokens_total != null) {
      partes.push(
        `${linha.tokens_total} tokens (${linha.tokens_entrada ?? '?'} entrada / ` +
          `${linha.tokens_saida ?? '?'} saida)`,
      );
    }
    if (linha.chamadas_places != null) {
      partes.push(`${linha.chamadas_places} chamadas Places`);
    }
    if (linha.duracao_ms != null) partes.push(`${linha.duracao_ms}ms`);
    partes.push(linha.trip_id ? `roteiro ${linha.trip_id}` : 'sem roteiro');
    console.log(partes.join(' · '));
    return true;
  } catch (erro) {
    console.warn(`[Evento] ${tipo} nao registrado: ${erro.message}`);
    return false;
  }
}

/**
 * Um contador de chamadas ao Google Places, por requisição.
 *
 * Existe como OBJETO, e não como variável de módulo, porque o Cloud Run
 * serve requisições concorrentes na mesma instância: um contador global
 * misturaria o roteiro de um usuário com a troca de atividade de outro,
 * e o erro apareceria como "as chamadas de Places não batem com a
 * fatura" -- sem pista de onde veio.
 *
 * `consultarLugar` e `consultarHorarios` recebem este objeto como
 * último argumento, opcional. Quem não passa continua funcionando: era
 * o contrato antes, e serviço que não conta não pode quebrar por isso.
 */
function contadorDePlaces() {
  return { chamadas: 0 };
}

module.exports = {
  registrarEvento,
  contadorDePlaces,
  statusDoErro,
  lerUso,
  TIPOS,
  STATUS,
};
