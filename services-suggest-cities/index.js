const jwt = require('jsonwebtoken');
const { montarPrompt, conferirResposta } = require('./sugerir');
// `registra-evento` chega aqui por um passo de cópia no cloudbuild (id
// `copia-registra-evento`) e, no desenvolvimento local, pelo `pretest`.
const { registrarEvento, statusDoErro } = require('./registra-evento');

// O modelo desta chamada, num lugar só -- ele é DADO na linha de
// `eventos`, e Pro e Flash custam diferente.
//
// **Flash, decisão do Paulo em 25/09.** É o segundo Flash do produto,
// depois da destilação da memória, e pelo mesmo motivo: escolha curta
// dentro de um conjunto conhecido (cidades de um país), com saída
// pequena. O mesmo id do update-memory, para os dois andarem juntos.
const MODELO_GEMINI = 'gemini-3.6-flash';

// Este serviço NÃO fala com o Supabase para trabalhar -- como o
// classify-conflicts, recebe o pedido, pergunta ao modelo e devolve. O
// único contato com o banco é o `registra-evento`, por fetch, sem SDK.

// =================================================================
// AUTENTICACAO: chamadas vindas do app (usuario logado, real ou anonimo)
//
// Obrigatório: o passo 3 roda com sessão (a Home cria a anônima ao
// buscar o destino), e sem token qualquer um gastaria Gemini pela URL.
// =================================================================
function verifySupabaseAuth(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (payload.role !== 'authenticated') return null;
    return payload;
  } catch (err) {
    return null;
  }
}

// =================================================================
// ORÇAMENTO DE TEMPO
//
// 12s de teto contra os 15s que o app espera. A pessoa está olhando a
// agulha girar no passo 3, e o app tem saída para a falha: segue com o
// destino como veio. Falhar rápido aqui custa pouco; pendurar custa a
// tela.
// =================================================================
const TETO_GEMINI_MS = 12000;

// Tetos da entrada. `days` e `max_cities` vêm do app, mas a URL é
// pública: um `days` absurdo não pode virar um prompt pedindo 500
// cidades.
const MAX_DIAS = 30;
const MAX_CIDADES = 15;
const MAX_VIBES = 10;

// =================================================================
// SERVIÇO: SUGERE CIDADES PARA O PASSO 3 DO WIZARD
// =================================================================
exports.suggestCities = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  const usuario = verifySupabaseAuth(req);
  if (!usuario) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_GEMINI_MS);
  const inicio = Date.now();
  let usoDoGemini = null;

  try {
    const corpo = req.body ?? {};
    const destination = String(corpo.destination ?? '').trim().slice(0, 200);
    if (!destination) {
      return res.status(400).json({ error: 'destination é obrigatório.' });
    }
    const days = Math.min(MAX_DIAS, Math.max(1, Math.round(Number(corpo.days)) || 1));
    const maxCities = Math.min(
      MAX_CIDADES,
      Math.max(1, Math.round(Number(corpo.max_cities)) || 1),
    );
    const vibes = (Array.isArray(corpo.vibes) ? corpo.vibes : [])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .slice(0, MAX_VIBES);
    const cities = (Array.isArray(corpo.cities) ? corpo.cities : [])
      .map((c) => String(c ?? '').trim())
      .filter(Boolean)
      .slice(0, MAX_CIDADES);
    const lang = corpo.lang === 'en' ? 'en' : 'pt';

    console.log(
      `[Cidades] "${destination}", ${days} dia(s), até ${maxCities} cidade(s), ${vibes.length} vibe(s).`,
    );

    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: montarPrompt({ destination, days, maxCities, vibes, cities, lang }) }],
          }],
          generationConfig: {
            // A saída cabe folgada em 1k: até 15 cidades com uma linha
            // cada. O dobro é o cinto e suspensório de sempre, porque é
            // aqui que o pensamento comeu o JSON da memória.
            maxOutputTokens: 2048,
            // Um pouco de variação é bem-vinda -- a mesma Itália não
            // precisa sugerir sempre as mesmas extras --, mas pouca:
            // o roteiro tem que ser o óbvio bom, não o exótico.
            temperature: 0.3,
            responseMimeType: 'application/json',
            // LOW, declarado. Omitir não desliga: sem a chave o modelo
            // roda no nível padrão e gasta pensamento que a resposta não
            // usa (CLAUDE.md, "Regras de IA").
            thinkingConfig: { thinkingLevel: 'LOW' },
          },
        }),
        signal: controlador.signal,
      },
    );

    if (!resposta.ok) {
      const texto = await resposta.text();
      throw new Error(`Falha Gemini: ${resposta.status} - ${texto}`);
    }

    const dados = await resposta.json();
    usoDoGemini = dados.usageMetadata ?? null;

    // Truncamento tem que se identificar, senão o erro vira "aspas na
    // coluna 812" e manda procurar defeito no prompt.
    const finishReason = dados.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(`Gemini interrompeu a resposta (finishReason: ${finishReason}).`);
    }
    if (!dados.candidates || !dados.candidates[0]?.content) {
      throw new Error('Resposta vazia do Gemini.');
    }

    const cru = dados.candidates[0].content.parts[0].text;
    const limpo = cru.replace(/```json/g, '').replace(/```/g, '').trim();
    const conferido = conferirResposta(JSON.parse(limpo), { maxCities });
    if (!conferido) {
      throw new Error('Resposta sem nenhuma cidade utilizável.');
    }
    const { resposta: sugestao, descartados } = conferido;
    if (descartados.length) {
      console.warn(`[Cidades] Descartados: ${descartados.join(' | ')}`);
    }

    registrarEvento({
      tipo: 'sugestao_cidades',
      userId: usuario?.sub,
      modelo: MODELO_GEMINI,
      uso: usoDoGemini,
      duracaoMs: Date.now() - inicio,
      meta: {
        kind: sugestao.kind,
        dias: days,
        roteiro: sugestao.itinerary.length,
        extras: sugestao.extras.length,
      },
    });

    console.log(
      `[Cidades] ${sugestao.kind}: ${sugestao.itinerary.map((c) => c.name).join(', ')}` +
      ` + ${sugestao.extras.length} extra(s) em ${Date.now() - inicio}ms.`,
    );

    return res.status(200).json(sugestao);
  } catch (erro) {
    const abortou = erro.name === 'AbortError';
    const msg = abortou
      ? `Gemini nao respondeu em ${Math.round(TETO_GEMINI_MS / 1000)}s na sugestao de cidades.`
      : erro.message;

    registrarEvento({
      tipo: 'sugestao_cidades',
      status: statusDoErro(erro),
      motivo: msg,
      userId: usuario?.sub,
      modelo: MODELO_GEMINI,
      uso: usoDoGemini,
      duracaoMs: Date.now() - inicio,
    });

    console.error(`[CRÍTICO] Erro na sugestão de cidades: ${msg}`);
    return res.status(500).json({ error: msg });
  } finally {
    clearTimeout(alarme);
  }
};
