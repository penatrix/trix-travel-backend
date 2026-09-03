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


// =================================================================
// Chamada ao Gemini com timeout explícito e uma retentativa.
//
// O fetch do Node não tem timeout padrão: sem AbortController, uma
// conexão pendurada fica pendurada até alguém cortar - e quem cortava
// era o Cloud Run, devolvendo o opaco "fetch failed".
//
// Uma retentativa só, e só em falha de REDE. Erro HTTP (429, 500) já é
// tratado por quem chama, e repetir uma geração cara às cegas é pior do
// que falhar rápido.
//
// O TETO PRECISA CABER DENTRO DO CLOUD RUN, e antes não cabia: eram 8
// minutos por tentativa, duas tentativas, 960s - contra o --timeout=900
// do cloudbuild.yaml deste serviço. Quando o Cloud Run corta, ele mata o
// processo: o 'catch' lá embaixo NÃO roda, a row fica presa em
// 'generating' para sempre e a cota fica cobrada sem estorno. É a
// armadilha "falha de job silenciosa" e a perda de crédito da 242 no
// mesmo ponto - e a retentativa, que existe justamente por causa da 242,
// era o que reabria a janela.
//
// A conta agora fecha com folga:
//
//   2 tentativas x 300s = 600s
//   + validação de lugares (duas passadas ao Google, 8s por consulta,
//     concorrência 5: ~105s no pior caso de um roteiro grande)
//   + escritas no Supabase
//   = ~750s contra o teto de 900s
//
// Se mexer em um dos dois números, refaça a conta. Aumentar este teto
// sem aumentar o --timeout traz o bug de volta exatamente como estava.
// =================================================================
const GEMINI_TIMEOUT_MS = 5 * 60 * 1000;

async function fetchGemini(url, body, rotulo) {
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    try {
      // Mede quanto a geração leva de fato. Não havia número nenhum aqui:
      // o teto de 8 minutos tinha sido escolhido no escuro, e sem medida
      // não dá para saber se 300s é folga ou aperto. Mesmo formato que o
      // generate-micro-activity já usa.
      const inicio = Date.now();
      const resposta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      console.log(
        `[Gemini] ${rotulo}: respondeu em ${Date.now() - inicio}ms (tentativa ${tentativa}).`,
      );
      return resposta;
    } catch (erro) {
      const motivo = erro.name === 'AbortError'
        ? `timeout de ${GEMINI_TIMEOUT_MS / 1000}s`
        : (erro.cause?.code || erro.message);
      console.error(`[Gemini] ${rotulo}: tentativa ${tentativa} falhou (${motivo}).`);
      if (tentativa === 2) {
        throw new Error(`Falha de rede ao chamar o Gemini (${rotulo}): ${motivo}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

exports.generateTrip = async (req, res) => {
  // Declaramos o tripId aqui em cima para o bloco 'catch' ter acesso a ele
  let tripId = null;
  // Idem para o estorno: o catch precisa saber DE QUEM devolver o crédito e
  // se a cota chegou a ser consumida. Sem o flag, uma falha anterior ao
  // consumo (webhook mal formado, status já processado) tentaria estornar
  // algo que nunca foi cobrado.
  let userId = null;
  let cotaConsumida = false;

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
    //
    // O status vem do BANCO, não de req.body.record, e a diferença vale
    // crédito. O payload do webhook é um retrato congelado no instante do
    // gatilho. Ele já protegia contra o AUTO-DISPARO - o UPDATE para
    // 'ready'/'failed' no fim daqui re-dispara o webhook, e aí o retrato
    // chega com o status novo e a chamada morre neste if. Mas não protegia
    // contra REENTREGA da mesma chamada: ali o retrato chega com
    // 'generating' outra vez, por mais que a linha já esteja pronta.
    //
    // E aí a assimetria mordia. consume_trip_quota NÃO é idempotente: ele
    // conta os roteiros do mês excluindo esta trip, então o status dela
    // não muda a conta e o segundo consumo decrementa de novo.
    // refund_trip_quota é idempotente por índice único
    // (entitlements_refunded_trip_id_key): estorna uma vez por roteiro,
    // para sempre. Consumo ilimitado com estorno único vaza crédito -
    // duas falhas seguidas custam um crédito e não entregam roteiro, e um
    // 200 perdido cobra dois créditos por uma viagem só.
    //
    // Relendo, a reentrega vê 'ready' ou 'failed' e sai aqui. E se o
    // processo tiver morrido no meio - o Cloud Run cortando mata o
    // processo sem passar pelo catch - a linha continua em 'generating',
    // e reprocessar é exatamente o que se quer.
    //
    // Custa uma leitura por requisição, antes de qualquer coisa cara.
    //
    // O que ISTO NÃO cobre: a leitura e o consumo não são atômicos, então
    // duas entregas concorrentes da MESMA chamada ainda podem ler
    // 'generating' as duas e consumir duas vezes. A janela deixa de ser
    // sempre e passa a ser só a simultaneidade. Fechar de vez pediria
    // marcar posse numa única escrita condicional (algo como
    // "update ... set status='processing' where id=? and status='generating'
    // returning *"), e isso é um status novo na máquina de estados que o
    // app também lê - mudança maior, decidida à parte.
    // =================================================================
    const { data: tripAtual, error: leituraError } = await supabase
      .from('trips')
      .select('id, user_id, status, prompt_payload, start_date')
      .eq('id', tripRecord.id)
      .maybeSingle();

    if (leituraError) {
      throw new Error(`Falha ao reler a trip ${tripRecord.id}: ${leituraError.message}`);
    }

    // Exclusão é permanente por LGPD: a linha pode ter sumido entre o
    // gatilho e esta leitura. Não é erro, e não há onde gravar 'failed'.
    if (!tripAtual) {
      console.log(`[Segurança] Ignorando trigger. A trip ${tripRecord.id} não existe mais.`);
      return res.status(200).json({ success: true, message: "Trip inexistente" });
    }

    if (tripAtual.status !== 'generating') {
      console.log(`[Segurança] Ignorando trigger. A trip ${tripAtual.id} está com status: ${tripAtual.status}`);
      return res.status(200).json({ success: true, message: "Ignorado para evitar loop" });
    }

    tripId = tripAtual.id;
    userId = tripAtual.user_id;
    const promptText = tripAtual.prompt_payload;

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
      p_user_id: tripAtual.user_id,
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

      console.log(`[Quota] Trip ${tripId} bloqueada: usuário ${tripAtual.user_id} sem cota gratuita nem crédito.`);
      return res.status(200).json({ success: true, message: 'Bloqueado por limite do plano gratuito' });
    }

    // A partir daqui a cota já foi cobrada. Qualquer falha adiante precisa
    // passar pelo estorno no catch - a viagem 242 morreu depois deste ponto
    // e o crédito foi embora com ela.
    cotaConsumida = true;

    // 1. Chama a API do Gemini Pro com Thinking MEDIUM
    const geminiResponse = await fetchGemini(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ role: "user", parts: [{ text: promptText }] }],
        generationConfig: {
          // 16384 era suficiente quando o roteiro saía com ~13 atividades e
          // 4 backups fixos. Hoje um Action-packed de 8 dias pede 40
          // atividades + 8 backups, cada uma com descrição, logística e
          // custo em pt-BR. Estourar o teto não devolve um roteiro menor:
          // devolve um JSON cortado no meio, que quebra no JSON.parse e
          // custa o mesmo. O limite só é cobrado pelo que for gerado de
          // fato, então folga aqui não tem custo por si só.
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingLevel: "MEDIUM" }
        }
      },
      `trip ${tripId}`,
    );

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

    // MAX_TOKENS não chega como erro: chega como resposta 200 com o texto
    // cortado no meio de uma chave. Sem esta checagem, o que aparece no
    // error_log é "Unexpected end of JSON input", que não diz nada sobre a
    // causa - e estouro de MAX_TOKENS já derrubou roteiro longo antes.
    // Melhor falhar dizendo o nome do problema.
    const finishReason = geminiData.candidates[0].finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(
        `Gemini interrompeu a geração (finishReason: ${finishReason}). ` +
        `Se for MAX_TOKENS, o roteiro passou do teto de saída e o JSON veio cortado.`,
      );
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
    // prompt pede backups proporcionais ao tamanho do roteiro.
    //
    // Nunca lança: se o Google estiver fora, o roteiro sai como veio. Roteiro
    // possivelmente desatualizado é ruim, roteiro nenhum é pior.
    // start_date entra porque a checagem de horário precisa saber o dia da
    // semana de cada dia do roteiro: museu fechado na segunda só aparece se
    // soubermos que o dia 3 cai numa segunda. Sem a data, a segunda passada
    // não roda e o resto continua igual.
    const resumoLugares = await validarEConsertarRoteiro(
      tripJsonObject,
      process.env.GOOGLE_MAPS_KEY,
      { dataInicio: tripAtual.start_date },
    );
    console.log(
      `[Places] Trip ${tripId}: ${resumoLugares.verificados} verificados, ` +
      `${resumoLugares.fechados} fechados, ${resumoLugares.trocados} trocados, ` +
      `${resumoLugares.removidos} removidos, ${resumoLugares.nao_encontrados} não encontrados, ` +
      `${resumoLugares.erros} erros.`,
    );
    console.log(
      `[Horários] Trip ${tripId}: ${resumoLugares.horarios_verificados} verificados, ` +
      `${resumoLugares.fora_do_horario} fora do período, ` +
      `${resumoLugares.reordenados} reordenados, ` +
      `${resumoLugares.trocados_por_horario} trocados, ` +
      `${resumoLugares.mantidos_fora_do_horario} com aviso na tela.`,
    );
    resumoLugares.detalhes.forEach((d) => console.log(`[Places] Trip ${tripId}:   ${d}`));

    const tripTitle = tripJsonObject.trip_title || 'Viagem Personalizada';
    // Lido DEPOIS da validação de propósito: se houve troca ou remoção, o
    // total foi reajustado e é esse valor que alimenta o controle de orçamento.
    const budgetActual = tripJsonObject.estimated_cost_brl;

    // 3. Sucesso: Atualiza os dados no Supabase para 'ready'
    //
    // O `.eq('status', 'generating')` é o ponto da coisa, não detalhe.
    //
    // Existe um job de pg_cron rodando de minuto em minuto que marca como
    // 'failed' qualquer linha presa em 'generating' há mais de 3 minutos -
    // e ele passou a ESTORNAR o crédito junto. Ou seja: a partir do
    // momento em que ele desiste de uma geração, o usuário já recebeu o
    // dinheiro de volta.
    //
    // Sem esta condição, uma geração lenta que terminasse depois disso
    // sobrescreveria o 'failed' com 'ready' e a pessoa ficaria com o
    // roteiro E com o crédito: viagem de graça. O caminho de retentativa
    // chega lá por construção - duas tentativas de 5 minutos passam dos 3
    // do job.
    //
    // Com a condição, quem desistiu primeiro decide. A geração atrasada é
    // descartada e a pessoa refaz sem custo, porque o crédito já voltou.
    // O `.select('id')` existe só para saber se pegou: um update que não
    // casa nenhuma linha não é erro no Supabase, volta vazio em silêncio.
    const { data: linhasAtualizadas, error: updateError } = await supabase
      .from('trips')
      .update({
        itinerary_json: tripJsonObject,
        title: tripTitle,
        status: 'ready',
        tokens_used: tokenCount,
        budget_actual: budgetActual
      })
      .eq('id', tripId)
      .eq('status', 'generating')
      .select('id');

    if (updateError) throw updateError;

    if (!linhasAtualizadas || linhasAtualizadas.length === 0) {
      // Não é erro: é o job tendo chegado antes. Nada a estornar aqui, ele
      // já fez. Só não pode passar batido no log, senão fica parecendo
      // geração perdida sem explicação.
      console.log(
        `[Descartado] Trip ${tripId}: geração terminou mas a linha já não estava em 'generating'. ` +
        `Provavelmente o job de roteiros travados desistiu antes e já estornou o crédito.`,
      );
      return res.status(200).json({ success: true, message: 'Resultado descartado: linha já não estava em generating' });
    }

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

    // 5. ESTORNO: a cota é cobrada antes de chamar o Gemini, para não
    // queimar tokens de quem não tem direito. O preço disso é que uma falha
    // adiante deixa o usuário sem roteiro E sem crédito - foi o que
    // aconteceu com a viagem 242.
    //
    // Roda DEPOIS do update para 'failed', e a ordem importa: a função
    // decide se houve cobrança contando os roteiros não-falhos do mês, e
    // exclui esta trip da contagem justamente para não depender do status
    // dela. Se o update acima falhar, o estorno ainda dá o mesmo resultado.
    //
    // Nunca lança: já estamos no catch, e um erro aqui só trocaria a causa
    // real do problema no log por uma acessória.
    if (cotaConsumida && userId && tripId) {
      try {
        const { data: estornou, error: refundError } = await supabase.rpc('refund_trip_quota', {
          p_user_id: userId,
          p_trip_id: tripId,
        });

        if (refundError) {
          console.error(`[Estorno] Trip ${tripId}: falhou - ${refundError.message}`);
        } else if (estornou) {
          console.log(`[Estorno] Trip ${tripId}: crédito devolvido ao usuário ${userId}.`);
        } else {
          // Dois casos legítimos: era o roteiro gratuito do mês (nada foi
          // cobrado) ou esta trip já tinha sido estornada numa retentativa
          // anterior do webhook.
          console.log(`[Estorno] Trip ${tripId}: nada a devolver.`);
        }
      } catch (refundError) {
        console.error(`[Estorno] Trip ${tripId}: erro inesperado -`, refundError);
      }
    }

    // Retorna 500 para o Supabase Webhook saber que a chamada não foi lisa,
    // mas nosso banco já está com o status atualizado corretamente.
    return res.status(500).json({ error: error.message });
  }
};
