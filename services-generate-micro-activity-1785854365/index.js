const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
// Chega aqui por um passo de cópia no cloudbuild (id `copia-validacao`) e,
// no desenvolvimento local, pelo `pretest` do package.json.
const { escolherCandidato } = require('./escolher-candidato');

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
// ORÇAMENTO DE TEMPO DO PEDIDO INTEIRO
//
// O app aborta em 65s (trip_details_widget.dart). Tudo o que acontece
// aqui tem que caber embaixo disso, senão quem corta é o cliente e o
// handler nem chega a dizer o motivo.
//
// A conta, no pior caso:
//
//   50s  Gemini (uma ida; 14,2s e ~18s medidos em 03/09)
// +  8s  Google (o teto de dentro do validar-lugares; os candidatos são
//        verificados em PARALELO, então são 8s no total, não por candidato)
// = 58s  contra 65s do app e 90s do Cloud Run
//
// Por que 50 e não 40. O teto foi 45s até 02/09, escolhido contra
// comportamento observado; virou 40s quando este orçamento foi
// simplificado, porque 40 + 8 = 48 fechava redondo contra os 60s que o
// app esperava então. Isso era estética, não medição - e em 03/09 uma de
// três trocas estourou os 40s, com a repetição imediata voltando em ~18s.
// O Gemini Pro tem variância larga (a geração de roteiro já mediu 70,5s
// numa chamada), então o teto tem que cobrir a cauda, não a mediana.
//
// Se `nao respondeu em 50s` voltar a aparecer no log, o próximo passo NÃO
// é aumentar de novo: é aceitar que existe cauda longa e decidir o que
// mostrar a quem caiu nela. A essa altura o usuário já esperou demais de
// qualquer forma.
//
// Vale registrar o que ESTE desenho evitou. Numa versão anterior, quando
// a sugestão vinha fechada o handler pedia OUTRA ao Gemini: o caminho
// ruim tinha quatro etapas - Gemini, Google, Gemini, Google - e somar os
// tetos dava 45+8+45+8 = 106s, quase o dobro do que o app espera. Pedir
// os candidatos JUNTOS eliminou a segunda ida, e com ela a aritmética
// que não fechava. Some-se a isso que o orçamento deixou de precisar ser
// repartido entre etapas: com uma ida só, o teto do Gemini é o teto.
// =================================================================
const TETO_GEMINI_MS = 50000;

// =================================================================
// Uma ida ao Gemini: chama, confere, devolve o JSON e a contagem.
//
// É UMA ida por pedido. Ficou como função separada porque o handler já
// tem trabalho suficiente, e porque isola o que é conversa com o modelo
// do que é decisão sobre o resultado.
// =================================================================
async function pedirSugestao(promptText, tetoMs) {
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
    console.log(`[MicroActivity] Gemini respondeu em ${Date.now() - inicio}ms.`);

    if (!geminiData.candidates || !geminiData.candidates[0].content) {
      throw new Error('Resposta vazia do Gemini.');
    }

    const rawText = geminiData.candidates[0].content.parts[0].text;
    const cleanText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

    return {
      sugestao: JSON.parse(cleanText),
      tokens: geminiData.usageMetadata?.totalTokenCount ?? 0,
    };
  } catch (erroDaChamada) {
    if (erroDaChamada.name === 'AbortError') {
      throw new Error(`Gemini nao respondeu em ${Math.round(tetoMs / 1000)}s na troca de atividade.`);
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
    // `period` é OPCIONAL de propósito. Ele só existe no corpo depois que
    // o app novo subir, e o backend precisa continuar servindo o app
    // antigo enquanto isso - sem ele a checagem de horário simplesmente
    // não roda, e a de fechamento continua valendo.
    const { promptText, period: periodo } = req.body;

    if (!promptText) {
      return res.status(400).json({ error: 'O promptText é obrigatório.' });
    }

    console.log(`[MicroActivity] Iniciando requisição para o Gemini...`);

    const { sugestao: bruto, tokens } = await pedirSugestao(promptText, TETO_GEMINI_MS);

    // =============================================================
    // OS CANDIDATOS
    //
    // O prompt novo pede uma lista ranqueada de 3. Mas o prompt vive no
    // CLIENTE, e mudança de prompt do cliente só vale depois de o app
    // recarregar - e os dois sobem separados. Então este handler aceita
    // as DUAS formas: a lista nova e o objeto único do app antigo,
    // tratado como lista de um. Sem isso, subir o backend antes do app
    // quebraria a troca de atividade para todo mundo.
    // =============================================================
    const candidatos = Array.isArray(bruto?.suggestions)
      ? bruto.suggestions
      : Array.isArray(bruto)
        ? bruto
        : [bruto];

    console.log(
      `[MicroActivity] ${candidatos.length} candidato(s); periodo: ${periodo || '(nao informado)'}.`,
    );

    // =============================================================
    // A ESCOLHA
    //
    // Verifica todos em paralelo - status e horário - e fica com o
    // melhor. É isto que torna a troca rápida: os candidatos já vieram
    // na mesma resposta, então descartar um fechado não custa outra ida
    // ao Gemini, só a checagem que já estava acontecendo mesmo.
    // =============================================================
    const escolha = await escolherCandidato(
      candidatos,
      periodo,
      process.env.GOOGLE_MAPS_KEY,
    );

    escolha.vereditos.forEach((v, i) => {
      const marca = i === escolha.indiceEscolhido ? '=>' : '  ';
      console.log(
        `[Places] MicroActivity ${marca} [${i}] "${v.candidato?.place}": status=${v.status}` +
        `${v.googleStatus ? ` (${v.googleStatus})` : ''}` +
        `, horario=${v.horario === null ? 'sem dado' : v.horario}` +
        `${v.motivo ? ` (${v.motivo})` : ''}`,
      );
    });

    // Degradado é o que precisa gritar: significa que nenhum candidato
    // passou limpo. É também o número que dirá se três estão bastando.
    if (escolha.degradado) {
      console.warn(`[Places] MicroActivity: ${escolha.motivo}.`);
    } else {
      console.log(`[Places] MicroActivity: ${escolha.motivo}.`);
    }

    console.log(`[Analytics] MicroActivity gerada. Tokens: ${tokens}`);

    // Devolve UM objeto, exatamente como sempre devolveu. O app não muda
    // para receber - só o prompt muda, para produzir três.
    return res.status(200).json(escolha.escolhido);

  } catch (error) {
    console.error(`[CRÍTICO] Erro na MicroActivity:`, error.message);
    return res.status(500).json({ error: error.message });
  }
};
