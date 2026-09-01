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
// NOVO SERVIÇO: GERAÇÃO DE BRAINSTORMING (TOPO DE FUNIL)
// =================================================================
exports.generateBrainstorming = async (req, res) => {
  let sessionId = null;

  try {
    if (!verifyWebhookSecret(req)) {
      return res.status(401).json({ error: 'Chamada nao autorizada.' });
    }

    const sessionRecord = req.body.record;

    if (!sessionRecord || !sessionRecord.id) {
      return res.status(400).send("Nenhum registro encontrado");
    }

    const currentStatus = sessionRecord.status;

    // =================================================================
    // A NOSSA TRAVA CONTRA LOOP INFINITO (FAIL-FAST ATUALIZADO)
    // Agora aceitamos 3 status:
    // - generating (fluxo novo)
    // - failed (usuário clicou em tentar novamente após erro)
    // - refused (usuário deu "não gostei" nas 3 opções e quer novas)
    // =================================================================
    if (!['generating', 'failed', 'refused'].includes(currentStatus)) {
      console.log(`[Segurança] Ignorando trigger. Brainstorming ${sessionRecord.id} com status: ${currentStatus}`);
      return res.status(200).json({ success: true, message: "Ignorado para evitar loop" });
    }

    sessionId = sessionRecord.id;
    let finalPrompt = sessionRecord.prompt_payload;

    // =================================================================
    // ENGENHARIA DE PROMPT DINÂMICA (TRATAMENTO DO 'REFUSED')
    // =================================================================
    if (currentStatus === 'refused') {
      const previousSuggestions = sessionRecord.ai_suggestions;
      let rejectedNames = "";

      // Tenta extrair os nomes das sugestões anteriores de forma segura
      if (previousSuggestions && previousSuggestions.destinations && Array.isArray(previousSuggestions.destinations)) {
        rejectedNames = previousSuggestions.destinations.map(d => d.title || d.city || 'Destino Desconhecido').join(', ');
      }

      if (rejectedNames) {
        finalPrompt += `\n\nHIGH PRIORITY: The user rejected the following previously suggested destinations: [${rejectedNames}]. YOU ARE STRICTLY FORBIDDEN FROM SUGGESTING THOSE PLACES AGAIN. Look for completely different routes or profiles that still fit your budget and desired vibe.`;
      } else {
        finalPrompt += `\n\nHIGH PRIORITY: The user rejected the previous suggestions. Be much more creative this time and come up with options that go beyond the obvious.`;
      }
      console.log(`[Regeração] Modificando prompt do Brainstorming ${sessionId} para evitar destinos antigos.`);
    }

    // 1. Chama a API do Gemini Pro
    // CTO Tip: Removi o "thinkingConfig" aqui e baixei os tokens.
    // O Brainstorming é topo de funil, precisamos de velocidade (latência baixa) e JSON pequeno.
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: finalPrompt }] }],
        generationConfig: {
          maxOutputTokens: 4096, // 4k é mais que suficiente para um JSON com 3 cards
        }
      })
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      throw new Error(`Falha na API do Gemini: Status ${geminiResponse.status} - ${errorText}`);
    }

    const geminiData = await geminiResponse.json();

    // Validação de segurança estrutural
    if (!geminiData.candidates || !geminiData.candidates[0].content) {
      throw new Error("Resposta do Gemini em formato inesperado ou vazia.");
    }

    let tokenCount = 0;
    if (geminiData.usageMetadata && geminiData.usageMetadata.totalTokenCount) {
      tokenCount = geminiData.usageMetadata.totalTokenCount;
      console.log(`[Analytics] Brainstorming ${sessionId} usou ${tokenCount} tokens.`);
    }

    // 2. Extração e limpeza do JSON gerado
    const rawText = geminiData.candidates[0].content.parts[0].text;
    const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    // Converte para Objeto (Falha e cai pro catch se o JSON for inválido)
    const brainstormJsonObject = JSON.parse(cleanText);

    // Validação extra para garantir que o Gemini retornou a chave certa
    if (!brainstormJsonObject.destinations || !Array.isArray(brainstormJsonObject.destinations)) {
      throw new Error("O JSON retornado não contém o array 'destinations'.");
    }

    // 3. Sucesso: Atualiza os dados na tabela do Supabase (AQUI USAMOS O NOME DA SUA TABELA)
    const { error: updateError } = await supabase
      .from('brainstorming') // <-- CERTIFIQUE-SE DE CRIAR ESTA TABELA NO SUPABASE
      .update({
        ai_suggestions: brainstormJsonObject,
        status: 'ready',
        tokens_used: tokenCount
      })
      .eq('id', sessionId);

    if (updateError) throw updateError;

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error(`[CRÍTICO] Erro no Brainstorming ${sessionId}:`, error.message);

    // 4. A REDE DE SEGURANÇA: Reverter para failed
    if (sessionId) {
      try {
        await supabase
          .from('brainstorming')
          .update({
            status: 'failed',
            error_log: error.message
          })
          .eq('id', sessionId);

        console.log(`Status do Brainstorming ${sessionId} revertido para 'failed' com sucesso.`);
      } catch (dbError) {
        console.error(`Falha catastrófica ao tentar atualizar o Brainstorming ${sessionId} para failed:`, dbError);
      }
    }

    return res.status(500).json({ error: error.message });
  }
};
