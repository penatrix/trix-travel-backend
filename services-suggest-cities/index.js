const jwt = require('jsonwebtoken');
const { montarPrompt, conferirResposta } = require('./sugerir');
const { montarPromptPerto, conferirPerto } = require('./perto');
const { conferirDestaques } = require('./prova');
const {
  normalizarDestino,
  lerOpcoes,
  montarPromptVibes,
  conferirVibes,
  respostaDoCache,
  linhaNovaDoCache,
  lerCache,
  gravarCache,
} = require('./vibes');
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
//
// Desde 21/10 fala com o Google Places, para conferir os lugares que
// provam cada cidade (`prova.js`). Precisa da GOOGLE_MAPS_KEY, a mesma
// do generate-trip; sem ela a sugestão sai sem os lugares.
//
// Desde 13/11 o filtro de vibes (`vibes.js`) lê e grava o seu cache em
// `vibes_do_destino`, também por fetch e com a service_role. Sem as
// variáveis, o filtro funciona sem cache: toda chamada vai ao modelo.

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

// A resposta inteira, com a conferência dos lugares de prova (21/10),
// sai antes disto. As builds do app de antes de 21/10 esperam 15s; a
// conferência fica com o que sobrar do Gemini, até 4s.
const TETO_TOTAL_MS = 14000;

// Tetos da entrada. `days` e `max_cities` vêm do app, mas a URL é
// pública: um `days` absurdo não pode virar um prompt pedindo 500
// cidades.
const MAX_DIAS = 30;
const MAX_CIDADES = 15;
const MAX_VIBES = 10;

// =================================================================
// O FILTRO DE VIBES PELO DESTINO (13/11, `vibes.js`)
//
// Pedido: { modo: 'vibes', destination, lang?, opcoes: [{ chave, nome }] }
// Resposta: sempre 200 com { fora: [chave, ...] } -- as opções que não
// cabem no destino. Falha do modelo, do tempo ou do banco devolve
// { fora: [] }, e o app mostra tudo. Só o destino vazio é 400.
//
// Cache primeiro (`vibes_do_destino`, 90 dias); sem ele, o Flash com
// thinking LOW e teto próprio de 8s: a pessoa está no passo das vibes,
// e a tela já está desenhada com todas as opções enquanto isto responde.
// =================================================================
const TETO_VIBES_MS = 8000;

async function filtrarVibes(corpo, usuario, res) {
  const inicio = Date.now();
  const destination = String(corpo.destination ?? '').trim().slice(0, 200);
  if (!destination) {
    return res.status(400).json({ error: 'destination é obrigatório.' });
  }
  const destino = normalizarDestino(destination);
  const opcoes = lerOpcoes(corpo.opcoes);
  const chaves = opcoes.map((o) => o.chave);
  if (chaves.length === 0) return res.status(200).json({ fora: [] });

  const anterior = await lerCache(destino);
  const doCache = respostaDoCache(anterior, chaves);
  if (doCache) {
    console.log(`[Vibes] "${destino}": cache, ${doCache.length} de ${chaves.length} fora.`);
    return res.status(200).json({ fora: doCache });
  }

  let usoDoGemini = null;
  try {
    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: montarPromptVibes({ destination, opcoes }) }] }],
          generationConfig: {
            // A saída é uma lista de ids curtos, poucas centenas de
            // tokens no pior caso das 80 opções. O resto é folga para o
            // pensamento, que conta dentro deste teto.
            maxOutputTokens: 2048,
            // Geografia, não criatividade: o mesmo destino tem que dar o
            // mesmo filtro.
            temperature: 0,
            responseMimeType: 'application/json',
            // LOW, declarado, como no resto do serviço (CLAUDE.md,
            // "Regras de IA"): omitir não desliga.
            thinkingConfig: { thinkingLevel: 'LOW' },
          },
        }),
        signal: AbortSignal.timeout(TETO_VIBES_MS),
      },
    );
    if (!resposta.ok) {
      const texto = await resposta.text();
      throw new Error(`Falha Gemini: ${resposta.status} - ${texto.slice(0, 300)}`);
    }
    const dados = await resposta.json();
    usoDoGemini = dados.usageMetadata ?? null;
    const finishReason = dados.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(`Gemini interrompeu a resposta (finishReason: ${finishReason}).`);
    }
    const cru = dados.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof cru !== 'string') throw new Error('Resposta vazia do Gemini.');
    const limpo = cru.replace(/```json/g, '').replace(/```/g, '').trim();
    const fora = conferirVibes(JSON.parse(limpo), chaves);

    // Gravar não segura a resposta além do teto do banco, e falhar aqui
    // não muda o que a pessoa recebe.
    await gravarCache(linhaNovaDoCache(destino, anterior, chaves, fora));

    registrarEvento({
      tipo: 'sugestao_cidades',
      userId: usuario?.sub,
      modelo: MODELO_GEMINI,
      uso: usoDoGemini,
      duracaoMs: Date.now() - inicio,
      meta: { modo: 'vibes', opcoes: chaves.length, fora: fora.length },
    });
    console.log(`[Vibes] "${destino}": ${fora.length} de ${chaves.length} fora (${fora.join(', ')}) em ${Date.now() - inicio}ms.`);
    return res.status(200).json({ fora });
  } catch (erro) {
    const abortou = erro.name === 'AbortError' || erro.name === 'TimeoutError';
    const msg = abortou
      ? `Gemini nao respondeu em ${Math.round(TETO_VIBES_MS / 1000)}s no filtro de vibes.`
      : erro.message;
    registrarEvento({
      tipo: 'sugestao_cidades',
      status: statusDoErro(erro),
      motivo: msg,
      userId: usuario?.sub,
      modelo: MODELO_GEMINI,
      uso: usoDoGemini,
      duracaoMs: Date.now() - inicio,
      meta: { modo: 'vibes' },
    });
    console.error(`[Vibes] Filtro falhou, o app mostra tudo: ${msg}`);
    return res.status(200).json({ fora: [] });
  }
}

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

  // O filtro de vibes tem teto e tratamento de erro próprios: falha ali
  // é 200 com a lista vazia, não 500.
  if (req.body?.modo === 'vibes') {
    return await filtrarVibes(req.body, usuario, res);
  }

  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_GEMINI_MS);
  const inicio = Date.now();
  let usoDoGemini = null;

  try {
    const corpo = req.body ?? {};
    // "Perto de você" (09/10, `perto.js`): três viagens curtas a partir da
    // origem, para a Home. Mesmo Flash, mesmo teto; outro pedido.
    const perto = corpo.modo === 'perto';
    const origin = String(corpo.origin ?? '').trim().slice(0, 200);
    if (perto && !origin) {
      return res.status(400).json({ error: 'origin é obrigatório no modo perto.' });
    }
    const destination = String(corpo.destination ?? '').trim().slice(0, 200);
    if (!perto && !destination) {
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
      perto
        ? `[Perto] "${origin}", ${vibes.length} vibe(s).`
        : `[Cidades] "${destination}", ${days} dia(s), até ${maxCities} cidade(s), ${vibes.length} vibe(s).`,
    );
    const textoDoPedido = perto
      ? montarPromptPerto({ origin, vibes, lang })
      : montarPrompt({ destination, days, maxCities, vibes, cities, lang });

    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_GEMINI}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: textoDoPedido }],
          }],
          generationConfig: {
            // Até 15 cidades, cada uma com até 3 lugares de prova (21/10),
            // passa de 2k. O dobro do que cabe é o cinto e suspensório de
            // sempre, porque é aqui que o pensamento comeu o JSON da
            // memória.
            maxOutputTokens: 4096,
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

    if (perto) {
      const conferidoPerto = conferirPerto(JSON.parse(limpo), { origin });
      if (!conferidoPerto) {
        throw new Error('Resposta sem nenhum destino perto utilizável.');
      }
      if (conferidoPerto.descartados.length) {
        console.warn(`[Perto] Descartados: ${conferidoPerto.descartados.join(' | ')}`);
      }
      registrarEvento({
        tipo: 'sugestao_cidades',
        userId: usuario?.sub,
        modelo: MODELO_GEMINI,
        uso: usoDoGemini,
        duracaoMs: Date.now() - inicio,
        meta: { modo: 'perto', destinos: conferidoPerto.resposta.perto.length },
      });
      console.log(
        `[Perto] ${conferidoPerto.resposta.perto.map((c) => `${c.name} (${c.mode} ${c.time})`).join(', ')}` +
        ` em ${Date.now() - inicio}ms.`,
      );
      return res.status(200).json(conferidoPerto.resposta);
    }

    const conferido = conferirResposta(JSON.parse(limpo), { maxCities, vibes });
    if (!conferido) {
      throw new Error('Resposta sem nenhuma cidade utilizável.');
    }
    const { resposta: sugestao, descartados } = conferido;
    if (descartados.length) {
      console.warn(`[Cidades] Descartados: ${descartados.join(' | ')}`);
    }
    // O Gemini já respondeu: o alarme dele não pode cortar o Places.
    clearTimeout(alarme);
    const { consultas, recusados } = await conferirDestaques(
      sugestao,
      process.env.GOOGLE_MAPS_KEY,
      { prazoMs: TETO_TOTAL_MS - (Date.now() - inicio) },
    );
    if (!process.env.GOOGLE_MAPS_KEY) {
      console.warn('[Cidades] GOOGLE_MAPS_KEY ausente: a sugestão sai sem os lugares de prova.');
    }

    registrarEvento({
      tipo: 'sugestao_cidades',
      userId: usuario?.sub,
      modelo: MODELO_GEMINI,
      uso: usoDoGemini,
      chamadasPlaces: consultas,
      duracaoMs: Date.now() - inicio,
      meta: {
        destaques_recusados: recusados,
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
