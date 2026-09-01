const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// CTO Tip: Inicializar clientes externos FORA da função principal.
// O Cloud Run mantém isso em memória em execuções contínuas,
// economizando centenas de milissegundos por requisição.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// =================================================================
// AUTENTICACAO: chamadas vindas do app (usuario logado, real ou anonimo)
// Valida o JWT do Supabase enviado pelo app no header Authorization.
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
    return payload; // payload.sub = id do usuario (auth.uid())
  } catch (err) {
    return null;
  }
}

// =================================================================
// AUTENTICACAO: chamadas vindas do Webhook do Supabase (servidor-a-servidor)
// Confere um segredo compartilhado enviado como header pelo proprio Webhook,
// configurado em Database > Webhooks > HTTP Headers no painel do Supabase.
// =================================================================
function verifyWebhookSecret(req) {
  const provided = req.headers['x-webhook-secret'];
  const expected = process.env.SUPABASE_WEBHOOK_SECRET;
  return !!expected && provided === expected;
}

// =================================================================
// NOVO SERVIÇO: GERAÇÃO DE MICRO ATIVIDADE (SÍNCRONA E BURRA)
// =================================================================
exports.generateMicroActivity = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  // So chamado de dentro do app, com uma viagem ja salva -- sempre ha sessao.
  if (!verifySupabaseAuth(req)) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  try {
    // Agora o Cloud Run não pensa, só recebe o prompt pronto do FlutterFlow
    const { promptText } = req.body;

    if (!promptText) {
      return res.status(400).json({ error: 'O promptText é obrigatório.' });
    }

    console.log(`[MicroActivity] Iniciando requisição para o Gemini...`);

    const inicio = Date.now();

    // TETO DE ESPERA
    //
    // Não havia nenhum. Sem timeout, uma chamada lenta fica pendurada até o
    // timeout do próprio Cloud Run, que é de minutos - e do outro lado o app
    // segura um spinner modal esse tempo todo. Medido em 01/09: uma troca
    // levou quase 4 minutos, com o usuário olhando para um círculo girando.
    //
    // 45s é folgado para uma sugestão única e ainda assim falha cedo o
    // bastante para a pessoa poder tentar de novo em vez de desistir.
    const controlador = new AbortController();
    const alarme = setTimeout(() => controlador.abort(), 45000);

    let geminiData;
    try {
      const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            maxOutputTokens: 4096,
            // Sugerir UM lugar numa cidade é tarefa de recuperação, não de
            // raciocínio longo. Sem esta linha o modelo rodava no nível de
            // thinking padrão dele - ausente não é desligado - e gastava
            // ~2k tokens para devolver um JSON de cinco campos cuja saída
            // não passa de ~150. O resto era pensamento.
            //
            // Repare que generateTrip declara MEDIUM e o brainstorming
            // omite de propósito, com comentário. Aqui a omissão não tinha
            // comentário nenhum: era esquecimento, não escolha.
            //
            // É mudança de qualidade percebida, e o CLAUDE.md manda medir.
            // Está indo com o Paulo comparando as sugestões antes e depois.
            thinkingConfig: { thinkingLevel: "LOW" }
          }
        }),
        signal: controlador.signal,
      });

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();
        throw new Error(`Falha Gemini: ${geminiResponse.status} - ${errorText}`);
      }

      geminiData = await geminiResponse.json();
    } catch (erroDaChamada) {
      if (erroDaChamada.name === 'AbortError') {
        throw new Error('Gemini nao respondeu em 45s na troca de atividade.');
      }
      throw erroDaChamada;
    } finally {
      // Sempre, inclusive no caminho feliz: um timer pendurado segura a
      // instância viva sem motivo.
      clearTimeout(alarme);
    }

    // Latência explícita no log. Sem isto, "está lento" era impressão, e
    // comparar antes e depois de mexer no thinking exigia cronometrar na
    // mão pelo carimbo de hora de duas linhas diferentes.
    console.log(`[MicroActivity] Gemini respondeu em ${Date.now() - inicio}ms.`);

    if (!geminiData.candidates || !geminiData.candidates[0].content) {
      throw new Error("Resposta vazia do Gemini.");
    }

    const rawText = geminiData.candidates[0].content.parts[0].text;
    const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    const jsonObject = JSON.parse(cleanText);

    let tokenCount = 0;
    if (geminiData.usageMetadata && geminiData.usageMetadata.totalTokenCount) {
      tokenCount = geminiData.usageMetadata.totalTokenCount;
      console.log(`[Analytics] MicroActivity gerada. Tokens: ${tokenCount}`);
    }

    return res.status(200).json(jsonObject);

  } catch (error) {
    console.error(`[CRÍTICO] Erro na MicroActivity:`, error.message);
    return res.status(500).json({ error: error.message });
  }
};
