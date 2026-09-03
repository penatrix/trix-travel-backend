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
// MEMÓRIA DO VIAJANTE: PESO EM VEZ DE DUAS LISTAS QUE SÓ CRESCEM
// =================================================================
//
// O travel_dna guardava `likes` e `dislikes` como duas listas que só
// cresciam, e nada nunca olhava uma contra a outra. A conta de teste
// terminou com "art museums" e "local history" nas DUAS - e o prompt do
// roteiro manda interpretar as tags literalmente, então o modelo recebia
// ordens opostas e fugia do assunto inteiro. Nos roteiros 240-242, de
// Roma, os três saíram quase só com cafés veganos e nenhuma atração
// clássica.
//
// A causa não é acúmulo lento entre vários usos: está no prompt de
// `replace`, que pede numa tacada "o que ele NÃO gosta na atividade
// antiga e o que gosta na nova". Trocar um museu por outro museu produz
// "museums" nos dois arrays da MESMA resposta.
//
// Agora cada tag tem um peso inteiro: +1 por sinal de gosto, -1 por
// sinal de rejeição. `likes` e `dislikes` continuam existindo no
// travel_dna, mas passam a ser DERIVADOS do peso - por isso o app não
// precisa mudar nada. Tag com peso 0 (mesma quantidade de sinal dos dois
// lados) não entra em lista nenhuma, que é a leitura honesta de "não
// sabemos".
//
// Nenhuma migração de banco: `pesosAtuais` semeia os pesos a partir das
// listas antigas na primeira escrita depois deste deploy, e uma tag que
// estava nas duas cancela sozinha.

// Um por lista, como era antes. O prompt do roteiro imprime as duas.
const LIMITE_POR_LISTA = 15;
// Teto do mapa de pesos. Maior que 2x o limite de lista de propósito: uma
// tag pode cair de "likes" e continuar valendo como histórico se voltar.
const LIMITE_PESOS = 40;

const normalizarTags = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .filter((t) => typeof t === 'string')
    .map((t) => t.toLowerCase().trim())
    .filter((t) => t.length > 0);

/// Pesos de onde partir. Já existindo `tag_weights`, é ele. Senão, semeia
/// pelas listas antigas: +1 por like, -1 por dislike. Tag que estava nas
/// duas soma zero e desaparece das duas - a contradição já gravada se
/// resolve na primeira escrita, sem script de migração.
function pesosAtuais(dna) {
  const guardados = dna && dna.tag_weights;
  if (guardados && typeof guardados === 'object' && !Array.isArray(guardados)) {
    const pesos = {};
    for (const [tag, valor] of Object.entries(guardados)) {
      const limpo = String(tag).toLowerCase().trim();
      if (limpo && Number.isFinite(Number(valor))) pesos[limpo] = Number(valor);
    }
    return pesos;
  }

  const pesos = {};
  for (const tag of normalizarTags(dna && dna.likes)) {
    pesos[tag] = (pesos[tag] ?? 0) + 1;
  }
  for (const tag of normalizarTags(dna && dna.dislikes)) {
    pesos[tag] = (pesos[tag] ?? 0) - 1;
  }
  return pesos;
}

/// Deriva as duas listas a partir dos pesos.
///
/// A poda é por |peso|, não por recência: o corte tira o sinal mais fraco,
/// não o mais antigo. Uma preferência confirmada cinco vezes sobrevive a
/// uma tag que apareceu uma vez semana passada.
function derivarListas(pesos) {
  const ativos = Object.entries(pesos)
    .filter(([, p]) => Number.isFinite(p) && p !== 0)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, LIMITE_PESOS);

  return {
    tag_weights: Object.fromEntries(ativos),
    likes: ativos.filter(([, p]) => p > 0).map(([t]) => t).slice(0, LIMITE_POR_LISTA),
    dislikes: ativos.filter(([, p]) => p < 0).map(([t]) => t).slice(0, LIMITE_POR_LISTA),
  };
}

// Exportado só para teste. Não é entrypoint de função: o deploy aponta
// para um nome específico, os demais exports são ignorados.
exports._memoria = { normalizarTags, pesosAtuais, derivarListas };


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
          maxOutputTokens: 2048,
          temperature: 0.2, // Baixa criatividade, queremos precisão e obediência ao JSON
          // Destilar uma troca em duas listas de tags curtas é
          // classificação, não raciocínio. Sem esta linha o modelo rodava
          // no nível de thinking padrão e o pensamento COMIA o orçamento
          // de saída: o JSON vinha cortado no meio e o handler quebrava
          // com "Unterminated string in JSON at position 116".
          //
          // A dobra do maxOutputTokens é cinto e suspensório. O consumo
          // real de tags é minúsculo; o que estourava não era a resposta.
          thinkingConfig: { thinkingLevel: "LOW" }
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

    // Truncamento tem que se identificar. Sem isto, resposta cortada
    // chegava no JSON.parse e o erro no log falava de aspas e coluna, que
    // manda quem investiga procurar defeito no prompt em vez de no teto
    // de tokens.
    const finishReason = geminiData.candidates[0].finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(`Gemini interrompeu a resposta (finishReason: ${finishReason}). Resposta incompleta, memória não atualizada.`);
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
    // O MERGE POR PESO
    // =================================================================

    // Busca o DNA atual
    const { data: userData, error: fetchError } = await supabase
      .from('users') // <-- Confirme se sua tabela é 'users' ou 'profiles'
      .select('travel_dna')
      .eq('id', user_id)
      .single();

    if (fetchError) throw new Error(`Erro ao buscar usuário no Supabase: ${fetchError.message}`);

    // O DNA atual serve para UMA coisa: ler os pesos de onde partir. Não é
    // mais mutado nem regravado - quem grava é `merge_travel_dna`, mais
    // abaixo, e só as chaves que esta função possui.
    //
    // `pesosAtuais` aceita as duas formas: `tag_weights`, quando existe, ou
    // as listas `likes`/`dislikes` das contas anteriores à migração de
    // peso. O esqueleto vazio cobre DNA nulo, que é conta nova.
    const dnaAtual = userData.travel_dna || { likes: [], dislikes: [] };

    const pesos = pesosAtuais(dnaAtual);
    const antes = { ...pesos };

    // +1 por sinal de gosto, -1 por sinal de rejeição. Quando a MESMA tag
    // vem nos dois arrays da mesma resposta - que é o caso de trocar um
    // museu por outro museu - os dois se cancelam e ela não entra em lista
    // nenhuma. Antes ela entrava nas duas.
    for (const tag of normalizarTags(incomingLikes)) {
      pesos[tag] = (pesos[tag] ?? 0) + 1;
    }
    for (const tag of normalizarTags(incomingDislikes)) {
      pesos[tag] = (pesos[tag] ?? 0) - 1;
    }

    const derivado = derivarListas(pesos);

    // =================================================================
    // GRAVA SÓ O QUE ESTA FUNÇÃO POSSUI
    //
    // Antes isto era `update({ travel_dna: currentDna })`: um
    // read-modify-write do objeto INTEIRO, sem controle de concorrência.
    //
    // O problema não era o que ele escrevia, era o que ele levava junto.
    // `travel_dna` também guarda `dietary`, a restrição alimentar - dado
    // sensível de saúde, que o usuário afirma ativamente na tela de perfil
    // e que por LGPD nunca pode ser inferida. A destilação não a
    // PREENCHIA, mas podia APAGÁ-LA: se o usuário salvasse a restrição
    // dentro da janela entre a leitura acima e a gravação aqui, esta
    // gravação punha a cópia velha por cima. Silenciosamente.
    //
    // A tela de perfil já estava endurecida contra isso - relê o DNA
    // fresco antes de gravar e preserva as outras chaves por spread. Este
    // lado não estava, e é o que roda a cada troca de atividade.
    //
    // `merge_travel_dna` faz o merge no SERVIDOR, com o operador `||` de
    // jsonb: as chaves do patch sobrescrevem, todas as outras ficam, numa
    // instrução só. Não há mais janela, e a função RECUSA um patch que
    // contenha `dietary` - então inferência não pode tocar dado declarado
    // por construção, não por vigilância de quem editar isto depois.
    //
    // O que fica de fora, e é de menor consequência: dois swaps
    // simultâneos ainda podem perder um incremento de peso um do outro,
    // porque o +1/-1 é calculado aqui e não no banco. É sinal de gosto,
    // não de saúde, e é anterior a esta mudança.
    // =================================================================
    const patch = {
      tag_weights: derivado.tag_weights,
      likes: derivado.likes,
      dislikes: derivado.dislikes,
    };

    const { data: dnaGravado, error: updateError } = await supabase.rpc(
      'merge_travel_dna',
      { p_user_id: user_id, p_patch: patch },
    );

    if (updateError) throw new Error(`Erro ao atualizar Supabase: ${updateError.message}`);

    // Log do que mudou de peso, para conseguir auditar a memória depois sem
    // precisar diffar o JSON inteiro na mão.
    const mudancas = Object.keys(derivado.tag_weights)
      .filter((t) => derivado.tag_weights[t] !== antes[t])
      .map((t) => `${t}: ${antes[t] ?? 0} -> ${derivado.tag_weights[t]}`);
    const zeradas = Object.keys(antes).filter(
      (t) => antes[t] !== 0 && !(t in derivado.tag_weights),
    );
    if (mudancas.length) console.log(`[TravelerMemory] ${user_id} pesos: ${mudancas.join(' | ')}`);
    if (zeradas.length) console.log(`[TravelerMemory] ${user_id} neutralizadas: ${zeradas.join(', ')}`);

    console.log(`[TravelerMemory] Memória atualizada com sucesso para ${user_id}. Tokens usados: ${tokenCount}`);

    return res.status(200).json({
      success: true,
      message: 'Memória atualizada e mesclada com sucesso',
      // O que o BANCO tem depois do merge, não o que este processo montou.
      // São coisas diferentes agora: o patch não carrega as chaves
      // declaradas, e é a função que decide o resultado.
      updated_dna: dnaGravado
    });

  } catch (error) {
    console.error(`[CRÍTICO] Erro em updateTravelerMemory:`, error.message);
    return res.status(500).json({ error: error.message });
  }
};
