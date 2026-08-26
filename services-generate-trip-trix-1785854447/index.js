const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const { validarEConsertarRoteiro } = require('./validar-lugares');

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

exports.generateTrip = async (req, res) => {
  // Declaramos o tripId aqui em cima para o bloco 'catch' ter acesso a ele
  let tripId = null;

  try {
    if (!verifyWebhookSecret(req)) {
      return res.status(401).json({ error: 'Chamada nao autorizada.' });
    }

    const tripRecord = req.body.record;

    if (!tripRecord || !tripRecord.id) {
      return res.status(400).send("Nenhum registro encontrado");
    }

    // =================================================================
    // A NOSSA TRAVA CONTRA LOOP INFINITO (FAIL-FAST)
    // Se o status não for 'generating', não fazemos nada.
    // =================================================================
    if (tripRecord.status !== 'generating') {
      console.log(`[Segurança] Ignorando trigger. A trip ${tripRecord.id} está com status: ${tripRecord.status}`);
      return res.status(200).json({ success: true, message: "Ignorado para evitar loop" });
    }

    tripId = tripRecord.id;
    const promptText = tripRecord.prompt_payload;

    // =================================================================
    // P1.2: TRAVA DO PLANO GRATUITO
    // Checa ANTES de chamar o Gemini (evita gastar tokens à toa). O app já
    // faz essa mesma checagem no cliente antes de criar a linha - isso
    // aqui é a trava de verdade, servidor nunca confia só no cliente.
    // exclude_trip_id evita que a própria linha sendo processada conte
    // contra a cota dela mesma.
    //
    // consume_trip_quota, e não can_generate_trip: a segunda tinha nome de
    // pergunta mas consumia o crédito, e era chamada duas vezes por roteiro
    // - uma pelo app antes de criar a linha, outra aqui. A segunda nunca
    // achava o crédito que a primeira tinha acabado de gastar, então o
    // crédito ia embora e o roteiro morria com QUOTA_EXCEEDED (MGM-06).
    // Agora a pergunta é só leitura, que é o que o app usa, e o consumo
    // mora só aqui - concedido apenas ao service_role.
    // =================================================================
    const { data: canGenerate, error: entitlementError } = await supabase.rpc('consume_trip_quota', {
      p_user_id: tripRecord.user_id,
      p_exclude_trip_id: tripId,
    });

    if (entitlementError) {
      throw new Error(`Falha ao checar direito de geração: ${entitlementError.message}`);
    }

    if (!canGenerate) {
      await supabase
        .from('trips')
        .update({
          status: 'failed',
          error_log: 'QUOTA_EXCEEDED: Limite gratuito mensal atingido.',
        })
        .eq('id', tripId);

      console.log(`[Quota] Trip ${tripId} bloqueada: usuário ${tripRecord.user_id} sem cota gratuita nem crédito.`);
      return res.status(200).json({ success: true, message: 'Bloqueado por limite do plano gratuito' });
    }

    // 1. Chama a API do Gemini Pro com Thinking MEDIUM
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: {
          maxOutputTokens: 16384,
          thinkingConfig: { thinkingLevel: "MEDIUM" }
        }
      })
    });

    // Fail-fast: Verifica se a API do Gemini rejeitou a requisição (ex: Timeout ou Rate Limit)
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
      console.log(`[Analytics] Trip ${tripId} usou ${tokenCount} tokens.`);
    }

    // 2. Extração e limpeza do JSON gerado
    const rawText = geminiData.candidates[0].content.parts[0].text;
    const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    // Se o Gemini alucinou e gerou um JSON inválido, o código quebra nesta linha e vai direto pro catch
    const tripJsonObject = JSON.parse(cleanText);

    // 2.5. Validação de status dos lugares, ANTES de virar 'ready'.
    //
    // O Gemini escreve a partir do treinamento: não tem como saber que um
    // restaurante fechou. Quem sabe é o Google, e nós já pedimos ao modelo a
    // string exata de busca. Lugar fechado é trocado em silêncio por um do
    // banco de backup_activities daquela cidade - que é para isso que o
    // prompt pede 4 por destino.
    //
    // Nunca lança: se o Google estiver fora, o roteiro sai como veio. Roteiro
    // possivelmente desatualizado é ruim, roteiro nenhum é pior.
    const resumoLugares = await validarEConsertarRoteiro(
      tripJsonObject,
      process.env.GOOGLE_MAPS_KEY,
    );
    console.log(
      `[Places] Trip ${tripId}: ${resumoLugares.verificados} verificados, ` +
      `${resumoLugares.fechados} fechados, ${resumoLugares.trocados} trocados, ` +
      `${resumoLugares.removidos} removidos, ${resumoLugares.nao_encontrados} não encontrados, ` +
      `${resumoLugares.erros} erros.`,
    );
    resumoLugares.detalhes.forEach((d) => console.log(`[Places] Trip ${tripId}:   ${d}`));

    const tripTitle = tripJsonObject.trip_title || 'Viagem Personalizada';
    // Lido DEPOIS da validação de propósito: se houve troca ou remoção, o
    // total foi reajustado e é esse valor que alimenta o controle de orçamento.
    const budgetActual = tripJsonObject.estimated_cost_brl;

    // 3. Sucesso: Atualiza os dados no Supabase para 'ready'
    const { error: updateError } = await supabase
      .from('trips')
      .update({
        itinerary_json: tripJsonObject,
        title: tripTitle,
        status: 'ready',
        tokens_used: tokenCount,
        budget_actual: budgetActual
      })
      .eq('id', tripId);

    if (updateError) throw updateError;

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error(`[CRÍTICO] Erro na Trip ${tripId}:`, error.message);

    // 4. A REDE DE SEGURANÇA: Se temos um tripId, avisamos o app que falhou
    if (tripId) {
      try {
        await supabase
          .from('trips')
          .update({
            status: 'failed',
            error_log: error.message
            // Opcional: Se você criar uma coluna 'error_detail' no Supabase,
            // pode salvar error.message lá para ajudar a debugar depois.
          })
          .eq('id', tripId);

        console.log(`Status da trip ${tripId} revertido para 'failed' com sucesso.`);
      } catch (dbError) {
        console.error(`Falha catastrófica ao tentar atualizar a trip ${tripId} para failed:`, dbError);
      }
    }

    // Retorna 500 para o Supabase Webhook saber que a chamada não foi lisa,
    // mas nosso banco já está com o status atualizado corretamente.
    return res.status(500).json({ error: error.message });
  }
};

// =================================================================
// NOVO SERVIÇO: PROXY DO GOOGLE PLACES (Busca de Cidades)
// =================================================================
exports.searchPlaces = async (req, res) => {
  // 1. A MÁGICA DO CORS: Isso avisa ao navegador Web que ele pode confiar nesta API
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Responde rápido se for apenas a verificação de segurança do navegador (Preflight)
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  // Usado tambem no funil pre-cadastro (antes de existir sessao) -- por isso
  // o token e opcional aqui, mas quando vier, precisa ser valido.
  //
  // Atencao ao header VAZIO: o app monta 'Authorization: Bearer <token>'
  // sempre, e deslogado o token e string vazia. O header chegava como
  // 'Bearer ' (truthy), caia no 401 e a busca de destino do onboarding
  // pre-cadastro devolvia zero resultados. So rejeitamos quando existe um
  // token de fato e ele nao confere.
  const bearerToken = (req.headers.authorization || '')
    .replace(/^Bearer\s*/i, '')
    .trim();
  if (bearerToken && !verifySupabaseAuth(req)) {
    return res.status(401).json({ error: 'Token de autenticação inválido.' });
  }

  // 2. Pega o que o FlutterFlow enviou na URL
  const input = req.query.input;
  const lang = req.query.lang || 'pt-BR';

  if (!input) {
    return res.status(400).json({ error: 'O parâmetro input é obrigatório' });
  }

  // 3. Monta a URL do Google usando a chave que já está nas suas variáveis
  const apiKey = process.env.GOOGLE_MAPS_KEY;
  const googleUrl = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=(cities)&language=${lang}&key=${apiKey}`;

  // 4. Chama o Google e devolve para o FlutterFlow
  try {
    const response = await fetch(googleUrl);
    const data = await response.json();

    if (data.status === 'OK') {
      return res.status(200).json(data.predictions);
    } else {
      return res.status(200).json([]); // Retorna lista vazia se não achar nada
    }
  } catch (error) {
    console.error('Erro ao chamar o Google Places:', error);
    return res.status(500).json({ error: 'Erro interno no servidor' });
  }
};


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

    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: {
          maxOutputTokens: 4096,
        }
      })
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      throw new Error(`Falha Gemini: ${geminiResponse.status} - ${errorText}`);
    }

    const geminiData = await geminiResponse.json();

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


// =================================================================
// NOVO SERVIÇO: MEMÓRIA DO VIAJANTE (DESTILAÇÃO EM BACKGROUND)
// =================================================================
exports.updateTravelerMemory = async (req, res) => {
  // 1. A MÁGICA DO CORS: Permite chamadas diretas do FlutterFlow Web/App
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  const authPayload = verifySupabaseAuth(req);
  if (!authPayload) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  try {
    const { user_id, action_type, old_activity, new_activity } = req.body;

    if (!user_id || !action_type || !old_activity) {
      return res.status(400).json({ error: 'Faltam parâmetros obrigatórios (user_id, action_type, old_activity).' });
    }

    // So pode mexer na propria memoria -- mesmo com a service role key,
    // ninguem deve conseguir sobrescrever o travel_dna de outra pessoa.
    if (authPayload.sub !== user_id) {
      return res.status(403).json({ error: 'Não é possível atualizar a memória de outro usuário.' });
    }

    console.log(`[TravelerMemory] Processando ação '${action_type}' para o usuário ${user_id}...`);

    // =================================================================
    // ENGENHARIA DE PROMPT (EM INGLÊS, MAS SAÍDA EM PT-BR)
    // =================================================================
    let promptContext = `You are a travel behavior analyst. Return ONLY a valid JSON object with two string arrays: 'likes' and 'dislikes'. Keep tags very short (max 3 words). Do not explain or add markdown outside the JSON.\n\n`;

    if (action_type === 'replace') {
      promptContext += `The user replaced the activity '${old_activity}' with '${new_activity}'. Extract what they dislike about the old activity, and what they like about the new one.`;
    } else if (action_type === 'delete') {
      promptContext += `The user deleted the activity '${old_activity}'. Extract what they likely dislike based on this activity. The 'likes' array must be completely empty.`;
    } else {
      return res.status(400).json({ error: 'action_type inválido. Use replace ou delete.' });
    }

    // 2. Chamada super rápida e barata ao Gemini
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: promptContext }] }],
        generationConfig: {
          maxOutputTokens: 1024, // Consumo minúsculo
          temperature: 0.2 // Baixa criatividade, queremos precisão e obediência ao JSON
        }
      })
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      throw new Error(`Falha na API do Gemini: Status ${geminiResponse.status} - ${errorText}`);
    }

    const geminiData = await geminiResponse.json();

    if (!geminiData.candidates || !geminiData.candidates[0].content) {
      throw new Error("Resposta do Gemini em formato inesperado ou vazia.");
    }

    let tokenCount = 0;
    if (geminiData.usageMetadata && geminiData.usageMetadata.totalTokenCount) {
      tokenCount = geminiData.usageMetadata.totalTokenCount;
    }

    // 3. Extração e limpeza do JSON gerado
    const rawText = geminiData.candidates[0].content.parts[0].text;
    const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    // Converte para Objeto (Falha e cai pro catch se o JSON for inválido)
    const newTags = JSON.parse(cleanText);

    // Garante que a estrutura exista mesmo se o Gemini alucinar
    const incomingLikes = Array.isArray(newTags.likes) ? newTags.likes : [];
    const incomingDislikes = Array.isArray(newTags.dislikes) ? newTags.dislikes : [];

    // =================================================================
    // O MERGE INTELIGENTE NO SUPABASE
    // =================================================================

    // Busca o DNA atual
    const { data: userData, error: fetchError } = await supabase
      .from('users') // <-- Confirme se sua tabela é 'users' ou 'profiles'
      .select('travel_dna')
      .eq('id', user_id)
      .single();

    if (fetchError) throw new Error(`Erro ao buscar usuário no Supabase: ${fetchError.message}`);

    // Prepara o DNA atual (cria o esqueleto base se vier vazio/null por algum motivo)
    let currentDna = userData.travel_dna || {
      likes: [], dislikes: [], dietary: [], pacing: "", budget_level: "", travel_style: []
    };

    // Função auxiliar para normalizar e juntar arrays sem duplicatas
    const mergeAndClean = (arr1, arr2) => {
      const combined = [...(arr1 || []), ...(arr2 || [])];
      // Tudo minúsculo e sem espaços extras para evitar "Museu" e " museu"
      const normalized = combined.map(tag => tag.toLowerCase().trim());
      // Remove duplicatas
      const unique = [...new Set(normalized)];
      // Limite máximo de 15 tags para não estourar tokens no futuro
      return unique.slice(-15);
    };

    currentDna.likes = mergeAndClean(currentDna.likes, incomingLikes);
    currentDna.dislikes = mergeAndClean(currentDna.dislikes, incomingDislikes);

    // Salva o DNA atualizado no banco
    const { error: updateError } = await supabase
      .from('users')
      .update({ travel_dna: currentDna })
      .eq('id', user_id);

    if (updateError) throw new Error(`Erro ao atualizar Supabase: ${updateError.message}`);

    console.log(`[TravelerMemory] Memória atualizada com sucesso para ${user_id}. Tokens usados: ${tokenCount}`);

    return res.status(200).json({
      success: true,
      message: 'Memória atualizada e mesclada com sucesso',
      updated_dna: currentDna
    });

  } catch (error) {
    console.error(`[CRÍTICO] Erro em updateTravelerMemory:`, error.message);
    return res.status(500).json({ error: error.message });
  }
};
