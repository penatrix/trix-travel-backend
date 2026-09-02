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

const { verificarStatus } = require('./verificar-status');

// =================================================================
// ORÇAMENTO DE TEMPO DO PEDIDO INTEIRO
//
// O app aborta em 60s (trip_details_widget.dart). Tudo o que acontece
// aqui tem que caber embaixo disso, senão quem corta é o cliente e o
// handler nem chega a dizer o motivo.
//
// Antes era simples: uma chamada ao Gemini com teto de 45s, fim. Agora o
// caminho ruim tem QUATRO etapas - Gemini, Google, Gemini, Google - e
// somar os tetos individuais dá 45+8+45+8 = 106s, quase o dobro do que o
// app espera. Teto por etapa não fecha conta; só um orçamento comum
// fecha.
//
// 50s deixa 10s de margem sob os 60s do app. Cada etapa recebe o que
// sobra do orçamento, e a segunda tentativa só começa se ainda couber
// inteira - entregar a sugestão fechada com aviso no log é melhor que
// estourar o prazo e não entregar nada.
// =================================================================
const TETO_TOTAL_MS = 50000;
const TETO_GEMINI_MS = 45000;
const TETO_GOOGLE_MS = 8000;

// Piso para tentar de novo: uma chamada ao Gemini medida gira em torno de
// 20s. Abaixo disto a segunda tentativa provavelmente seria cortada no
// meio, gastando token para não entregar nada.
const MINIMO_PARA_SEGUNDA_MS = 25000;

// =================================================================
// Uma ida ao Gemini: chama, confere, devolve o JSON e a contagem.
//
// Virou função porque agora pode acontecer duas vezes no mesmo pedido.
// Antes estava tudo inline no handler, e duplicar aquilo era pedir para
// as duas cópias divergirem.
// =================================================================
async function pedirSugestao(promptText, tetoMs, rotulo) {
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), tetoMs);
  const inicio = Date.now();

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
          // Repare que generateTrip declara MEDIUM. Aqui a omissão não
          // tinha comentário nenhum: era esquecimento, não escolha.
          thinkingConfig: { thinkingLevel: "LOW" }
        }
      }),
      signal: controlador.signal,
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      throw new Error(`Falha Gemini: ${geminiResponse.status} - ${errorText}`);
    }

    const geminiData = await geminiResponse.json();

    // Latência explícita no log. Sem isto, "está lento" era impressão.
    console.log(`[MicroActivity] Gemini respondeu em ${Date.now() - inicio}ms (${rotulo}).`);

    if (!geminiData.candidates || !geminiData.candidates[0].content) {
      throw new Error(`Resposta vazia do Gemini (${rotulo}).`);
    }

    const rawText = geminiData.candidates[0].content.parts[0].text;
    const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    return {
      sugestao: JSON.parse(cleanText),
      tokens: geminiData.usageMetadata?.totalTokenCount ?? 0,
    };
  } catch (erroDaChamada) {
    if (erroDaChamada.name === 'AbortError') {
      throw new Error(`Gemini nao respondeu em ${Math.round(tetoMs / 1000)}s na troca de atividade (${rotulo}).`);
    }
    throw erroDaChamada;
  } finally {
    // Sempre, inclusive no caminho feliz: um timer pendurado segura a
    // instância viva sem motivo.
    clearTimeout(alarme);
  }
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

    const prazo = Date.now() + TETO_TOTAL_MS;
    const restante = () => prazo - Date.now();
    // Piso de 1s para nenhum alarme disparar no mesmo instante em que é
    // criado, o que produziria um erro de timeout confuso em vez do erro
    // real. O portão do MINIMO_PARA_SEGUNDA_MS é que evita chegar aqui
    // sem tempo.
    const tetoPara = (maximo) => Math.max(1000, Math.min(maximo, restante()));

    let { sugestao, tokens: tokensTotais } = await pedirSugestao(
      promptText,
      tetoPara(TETO_GEMINI_MS),
      'tentativa 1',
    );

    // =============================================================
    // VALIDAÇÃO DE LUGAR FECHADO
    //
    // Toda a proteção contra "o pior bug do produto" vivia só no
    // caminho da geração inicial (validar-lugares.js, no generate-trip).
    // A troca de atividade devolvia o JSON do Gemini direto ao app, sem
    // consultar o Google - ou seja, o buraco ficava exatamente no
    // caminho que o usuário usa quando NÃO gostou da sugestão validada.
    // Ele trocava um lugar verificado por um não verificado, e a tela
    // não distinguia os dois.
    //
    // O desenho aqui é pedir outra por conta própria, uma vez só, em vez
    // de avisar o app: mantém o contrato entre os dois intacto e não
    // exige mudança no Flutter. O custo é uma segunda chamada ao Gemini,
    // e só quando a primeira sugestão vem fechada.
    // =============================================================
    const chaveMaps = process.env.GOOGLE_MAPS_KEY;

    if (!chaveMaps) {
      // Mesma postura do validar-lugares: não derruba a entrega. Mas
      // grita no log, porque serviço recriado sem a chave entrega
      // sugestão não verificada parecendo verificada.
      console.warn(
        '[Places] MicroActivity: GOOGLE_MAPS_KEY ausente. Sugestão entregue SEM verificação de fechamento.',
      );
    } else {
      const veredito = await verificarStatus(
        sugestao.maps_search_query,
        chaveMaps,
        tetoPara(TETO_GOOGLE_MS),
      );
      console.log(
        `[Places] MicroActivity: "${sugestao.place}" -> ${veredito.veredito}` +
        `${veredito.status ? ` (${veredito.status})` : ''}` +
        `${veredito.motivo ? ` (${veredito.motivo})` : ''}.`,
      );

      // Só 'fechado' descarta. 'nao_encontrado' e 'erro' entregam a
      // sugestão: falso positivo aqui custaria uma espera inteira ao
      // usuário para trocar um lugar que talvez estivesse ótimo.
      if (veredito.veredito === 'fechado') {
        if (restante() < MINIMO_PARA_SEGUNDA_MS) {
          console.warn(
            `[Places] MicroActivity: sobraram ${restante()}ms, não dá para pedir outra. ` +
            `Entregando "${sugestao.place}" mesmo fechado.`,
          );
        } else {
          // O veto vai em INGLÊS de propósito, e isso não é o bug de
          // mistura de idiomas: o buildMicroActivityPrompt escreve todas
          // as instruções em inglês e manda traduzir apenas os VALORES
          // de saída ("LANGUAGE: Your output values MUST be exclusively
          // in $targetLanguage"). Instrução nova em inglês é coerente
          // com o resto do prompt.
          const promptComVeto = promptText +
            `\n\n  CLOSED PLACE VETO (added by server-side validation): "${sugestao.place}" ` +
            `is reported as ${veredito.status} on Google Maps. Do NOT suggest it. ` +
            `Suggest a DIFFERENT place that is currently open.`;

          const segunda = await pedirSugestao(
            promptComVeto,
            tetoPara(TETO_GEMINI_MS),
            'tentativa 2, apos fechado',
          );
          tokensTotais += segunda.tokens;

          const veredito2 = await verificarStatus(
            segunda.sugestao.maps_search_query,
            chaveMaps,
            tetoPara(TETO_GOOGLE_MS),
          );
          console.log(
            `[Places] MicroActivity: substituto "${segunda.sugestao.place}" -> ${veredito2.veredito}.`,
          );

          // Duas fechadas seguidas é raro e não vale uma terceira ida:
          // gastaria mais token e estouraria o prazo do app. Entrega a
          // segunda e registra, para o número existir.
          if (veredito2.veredito === 'fechado') {
            console.warn(
              `[Places] MicroActivity: as duas sugestões vieram fechadas. ` +
              `Entregando "${segunda.sugestao.place}".`,
            );
          }

          sugestao = segunda.sugestao;
        }
      }
    }

    console.log(`[Analytics] MicroActivity gerada. Tokens: ${tokensTotais}`);

    return res.status(200).json(sugestao);

  } catch (error) {
    console.error(`[CRÍTICO] Erro na MicroActivity:`, error.message);
    return res.status(500).json({ error: error.message });
  }
};
