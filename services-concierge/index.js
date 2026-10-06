const jwt = require('jsonwebtoken');
const {
  limparEntrada,
  compactarRoteiro,
  montarInstrucoes,
  montarConversa,
  conferirResposta,
  mensagemDoLimite,
  LIMITE_DIARIO,
} = require('./concierge');
// `registra-evento` chega aqui por um passo de cópia no cloudbuild (id
// `copia-registra-evento`) e, no desenvolvimento local, pelo `pretest`.
const { registrarEvento, statusDoErro } = require('./registra-evento');

// O modelo, num lugar só -- ele é DADO na linha de `eventos`.
//
// **Flash com thinking HIGH**, como o plano de lançamento fixou para o
// concierge: a pergunta é curta e aberta ("dá para encaixar a Torre de
// Belém no dia 2?"), e a resposta precisa cruzar dias, períodos e
// trajetos do roteiro inteiro. Pensar ali é o produto; o Flash é o que
// mantém o custo por mensagem baixo. O mesmo id do suggest-cities.
const MODELO_GEMINI = 'gemini-3.6-flash';

// =================================================================
// ORÇAMENTO DE TEMPO E DE SAÍDA
//
// 40s de teto: o thinking HIGH pensa antes de responder, e a pessoa
// está olhando a bússola girar numa conversa -- passar disso é pior
// que dizer que não deu. O Cloud Run tem 60s, MAIOR que este teto,
// para quem corta ser o handler, com log e resposta.
//
// 8192 de saída, e não os 1024 que a resposta usa: **o pensamento
// conta dentro do `maxOutputTokens`**, e com HIGH ele come o teto
// antes de a resposta começar. Foi o que truncou o JSON da memória do
// viajante (CLAUDE.md, "Regras de IA"). A resposta em si é curta por
// instrução (120 palavras).
// =================================================================
const TETO_GEMINI_MS = 40000;
const MAX_TOKENS_DE_SAIDA = 8192;

// O teto da consulta ao banco (roteiro, membro, contagem). Banco lento
// não pode comer o tempo do Gemini.
const TETO_BANCO_MS = 5000;

// =================================================================
// AUTENTICACAO
//
// Só conta de verdade: o concierge é de quem tem roteiro salvo, e a
// sessão anônima não tem roteiro na conta.
// =================================================================
function verificarToken(req) {
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (payload.role !== 'authenticated' || payload.is_anonymous === true) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

// =================================================================
// O BANCO, POR FETCH
//
// Como o `registra-evento`: três leituras não justificam o SDK. A chave
// é a de serviço, então a RLS não filtra -- e é por isso que o acesso
// ao roteiro é conferido AQUI, à mão: dono ou membro, e mais ninguém.
// =================================================================
async function lerDoBanco(caminho, { contar = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente.');

  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_BANCO_MS);
  try {
    const resposta = await fetch(`${url}/rest/v1/${caminho}`, {
      method: 'GET',
      headers: {
        apikey: chave,
        Authorization: `Bearer ${chave}`,
        ...(contar ? { Prefer: 'count=exact', Range: '0-0' } : {}),
      },
      signal: controlador.signal,
    });
    if (!resposta.ok) throw new Error(`Banco respondeu ${resposta.status} em ${caminho.split('?')[0]}.`);
    if (contar) {
      // "0-0/17" -> 17. Sem linha, "*/0".
      const faixa = resposta.headers?.get?.('content-range') ?? '';
      const total = Number(faixa.split('/')[1]);
      return Number.isFinite(total) ? total : 0;
    }
    return await resposta.json();
  } finally {
    clearTimeout(alarme);
  }
}

/** A row do roteiro, se esta conta é dona ou membro. `null` se não. */
async function roteiroDaConta(tripId, userId) {
  const linhas = await lerDoBanco(
    `trips?id=eq.${tripId}&select=user_id,title,itinerary_json,travelers_count,` +
      'start_date,end_date,is_date_set,status',
  );
  const row = Array.isArray(linhas) ? linhas[0] : null;
  if (!row) return null;
  if (row.user_id === userId) return row;

  const membros = await lerDoBanco(
    `trip_members?trip_id=eq.${tripId}&user_id=eq.${userId}&select=id`,
  );
  return Array.isArray(membros) && membros.length > 0 ? row : null;
}

/**
 * Quantas mensagens esta conta mandou nas últimas 24 horas.
 *
 * Janela móvel, e não "desde a meia-noite": meia-noite de onde? A pessoa
 * está viajando. Conta só as que deram certo -- falha nossa não gasta a
 * cota de ninguém.
 *
 * Se a contagem falhar, deixa passar: o limite é contra abuso, e banco
 * fora do ar não pode tirar o concierge de quem está no meio da viagem.
 */
async function mensagensNasUltimas24h(userId) {
  try {
    const desde = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return await lerDoBanco(
      `eventos?tipo=eq.concierge&status=eq.ok&user_id=eq.${userId}` +
        `&ocorrido_em=gte.${encodeURIComponent(desde)}&select=id`,
      { contar: true },
    );
  } catch (erro) {
    console.warn(`[Concierge] Não consegui contar as mensagens: ${erro.message}`);
    return 0;
  }
}

// =================================================================
// SERVIÇO: O CONCIERGE DE UM ROTEIRO
//
// Entrada: { trip_id, mensagem, historico: [{ papel, texto }], lang }
// Saída 200: { resposta }
// Erros: 401 sem conta, 400 pedido vazio, 403 roteiro de outra pessoa,
//        429 limite diário ({ error, mensagem } pronto para a tela),
//        500 falha do modelo.
// =================================================================
exports.conversarComConcierge = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  const usuario = verificarToken(req);
  if (!usuario) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  const entrada = limparEntrada(req.body ?? {});
  if (!entrada) {
    return res.status(400).json({ error: 'trip_id e mensagem são obrigatórios.' });
  }
  const { tripId, mensagem, historico, lang } = entrada;

  const inicio = Date.now();
  let usoDoGemini = null;
  let alarme = null;

  try {
    const row = await roteiroDaConta(tripId, usuario.sub);
    if (!row) {
      return res.status(403).json({ error: 'Roteiro não encontrado para esta conta.' });
    }
    const roteiro = compactarRoteiro(row);
    if (!roteiro) {
      return res.status(409).json({ error: 'O roteiro ainda não tem conteúdo.' });
    }

    const enviadas = await mensagensNasUltimas24h(usuario.sub);
    if (enviadas >= LIMITE_DIARIO) {
      return res.status(429).json({
        error: 'Limite de mensagens atingido.',
        mensagem: mensagemDoLimite(lang),
      });
    }

    console.log(
      `[Concierge] Roteiro ${tripId}, ${historico.length} troca(s) antes, ` +
        `${enviadas + 1}ª mensagem em 24h.`,
    );

    const controlador = new AbortController();
    alarme = setTimeout(() => controlador.abort(), TETO_GEMINI_MS);

    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: montarInstrucoes(roteiro, lang) }] },
          contents: montarConversa(historico, mensagem),
          generationConfig: {
            maxOutputTokens: MAX_TOKENS_DE_SAIDA,
            // Pouca variação: é resposta sobre dado, não ideia nova.
            temperature: 0.3,
            // HIGH, declarado. Omitir não desliga: sem a chave o modelo
            // roda no nível padrão dele (CLAUDE.md, "Regras de IA").
            thinkingConfig: { thinkingLevel: 'HIGH' },
          },
        }),
        signal: controlador.signal,
      },
    );

    if (!resposta.ok) {
      const detalhe = await resposta.text();
      throw new Error(`Falha Gemini: ${resposta.status} - ${detalhe.slice(0, 300)}`);
    }

    const dados = await resposta.json();
    usoDoGemini = dados.usageMetadata ?? null;

    const finishReason = dados.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(`Gemini interrompeu a resposta (finishReason: ${finishReason}).`);
    }
    const partes = dados.candidates?.[0]?.content?.parts ?? [];
    const cru = partes.map((p) => p?.text ?? '').join('');
    const texto = conferirResposta(cru);
    if (!texto) throw new Error('Resposta vazia do Gemini.');

    registrarEvento({
      tipo: 'concierge',
      tripId,
      userId: usuario.sub,
      modelo: MODELO_GEMINI,
      uso: usoDoGemini,
      duracaoMs: Date.now() - inicio,
      meta: { trocas_antes: historico.length, caracteres: texto.length },
    });

    return res.status(200).json({ resposta: texto });
  } catch (erro) {
    const abortou = erro.name === 'AbortError';
    const msg = abortou
      ? `Gemini nao respondeu em ${Math.round(TETO_GEMINI_MS / 1000)}s no concierge.`
      : erro.message;

    registrarEvento({
      tipo: 'concierge',
      status: statusDoErro(erro),
      motivo: msg,
      tripId,
      userId: usuario.sub,
      modelo: MODELO_GEMINI,
      uso: usoDoGemini,
      duracaoMs: Date.now() - inicio,
    });

    console.error(`[CRÍTICO] Erro no concierge: ${msg}`);
    return res.status(500).json({ error: msg });
  } finally {
    if (alarme) clearTimeout(alarme);
  }
};
