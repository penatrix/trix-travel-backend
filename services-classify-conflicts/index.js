const jwt = require('jsonwebtoken');
const { montarPrompt, conferirResposta } = require('./classificar');
// `validar-lugares` chega aqui por um passo de cópia no cloudbuild (id
// `copia-validacao`) e, no desenvolvimento local, pelo `pretest`. É o mesmo
// arquivo que o generate-trip e o generate-micro-activity usam.
const { avaliarDisponibilidades } = require('./disponibilidade');

// Este serviço NÃO fala com o Supabase, e é o primeiro que não fala.
//
// Ele recebe a lista do app, pergunta ao modelo, devolve o veredito. Não
// lê nem grava nada. Por isso não repete o preâmbulo de cliente do
// Supabase que as outras cinco pastas carregam - o que é, de passagem, uma
// demonstração de que boa parte daquelas 126 linhas duplicadas é
// dispensável por serviço, não só extraível.

// =================================================================
// AUTENTICACAO: chamadas vindas do app (usuario logado, real ou anonimo)
// Valida o JWT do Supabase enviado pelo app no header Authorization.
//
// Aqui o token é OBRIGATÓRIO: só se emenda roteiro que já existe, e
// roteiro que existe pertence a alguém logado.
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
// Uma ida ao modelo, e só. A saída é curta - uma lista de ids - então a
// latência é quase toda raciocínio.
//
// 30s de teto contra os 45s que o app espera nesta chamada. Menos folga
// que na troca de atividade porque aqui o usuário está numa tela de
// revisão que ele mesmo pediu, não olhando spinner no meio do roteiro; e
// porque falhar rápido aqui custa pouco - ele tenta de novo sem ter
// perdido nada.
// =================================================================
const TETO_GEMINI_MS = 30000;

// Teto de itens por chamada.
//
// Um roteiro de 15 dias com 3 atividades por dia mais backups passa de
// 50 itens, e o prompt cresce com a lista. Cortar aqui é o que impede
// esta chamada de virar o problema de MAX_TOKENS que já limita a duração
// dos roteiros - a diferença é que aqui a saída é curta, então o teto
// protege a ENTRADA.
const MAX_ITENS = 80;

// Teto de itens VALIDADOS no Google por chamada.
//
// Separado do MAX_ITENS porque protege outra coisa: aquele protege o
// tamanho do prompt, este protege a conta do Google. O app manda
// `maps_search_query` só para os backups (as atividades já foram validadas
// na geração), e backups são ~2 por destino — então 20 é folgado.
const MAX_VALIDACOES = 20;

// =================================================================
// SERVIÇO: CLASSIFICA CONFLITO DE RESTRIÇÃO
//
// Recebe atividades e backups, devolve quais conflitam com a restrição.
//
// Deliberadamente burro sobre a estrutura do roteiro: trabalha com uma
// lista de { id, place, description } e devolve ids. Quem sabe onde cada
// id mora no itinerary_json é o app, que é quem vai reescrevê-lo. Mesmo
// desenho do generate-micro-activity, e pelo mesmo motivo: o serviço não
// precisa entender o formato para fazer o trabalho dele.
// =================================================================
exports.classifyConflicts = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (!verifySupabaseAuth(req)) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_GEMINI_MS);
  const inicio = Date.now();

  try {
    const { restriction, items } = req.body ?? {};

    if (!restriction || !String(restriction).trim()) {
      return res.status(400).json({ error: 'restriction é obrigatório.' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items precisa ser uma lista não vazia.' });
    }
    if (items.length > MAX_ITENS) {
      return res.status(400).json({
        error: `items excede o limite de ${MAX_ITENS} por chamada.`,
      });
    }

    // Itens sem id ou sem nome não têm como ser classificados nem
    // devolvidos. Sair aqui é melhor que mandar lixo ao modelo e pagar
    // token por isso.
    const itens = items
      .map((i) => ({
        id: String(i?.id ?? '').trim(),
        place: String(i?.place ?? '').trim(),
        description: String(i?.description ?? '').trim(),
        // Opcionais, e é a presença deles que pede validação no Google. O
        // app manda só para os backups: as atividades já foram validadas na
        // geração do roteiro, e revalidar tudo dobraria a conta sem
        // responder nada novo.
        maps_search_query: String(i?.maps_search_query ?? '').trim(),
        period: String(i?.period ?? '').trim(),
      }))
      .filter((i) => i.id && i.place);

    if (itens.length === 0) {
      return res.status(400).json({ error: 'nenhum item com id e place utilizáveis.' });
    }

    const paraValidar = itens
      .filter((i) => i.maps_search_query)
      .slice(0, MAX_VALIDACOES);

    console.log(
      `[Conflitos] Classificando ${itens.length} item(ns) contra "${restriction}"` +
      `${paraValidar.length ? `; validando ${paraValidar.length} no Google` : ''}.`,
    );

    // As duas perguntas em PARALELO, porque são independentes: o Gemini
    // decide se o lugar conflita com o pedido, o Google decide se ele está
    // aberto. Sequencial somaria os dois tempos sem motivo — mesma razão
    // pela qual a escolha de candidato na troca de atividade é paralela.
    const [resposta, disponibilidade] = await Promise.all([
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: montarPrompt(restriction, itens) }] }],
            generationConfig: {
              maxOutputTokens: 2048,
              // Determinismo importa: a mesma lista com a mesma restrição
              // deve dar o mesmo veredito. Classificação não é lugar para
              // criatividade.
              temperature: 0.1,
              // Pro, e não Flash, apesar de ser classificação curta.
              //
              // O CLAUDE.md reserva o Flash para um lugar só - a destilação
              // da memória - e essa regra fica intacta. A escolha aqui é de
              // consequência: errar significa um celíaco MANTER um jantar
              // com glúten. É UMA chamada por emenda, não uma por
              // atividade, então a diferença de custo é irrelevante e a de
              // risco não é.
              //
              // LOW porque a tarefa é reconhecer categoria de lugar, não
              // raciocinar longo. E declarado explicitamente porque omitir
              // não desliga: sem a chave, o modelo roda no nível padrão
              // dele e gasta pensamento que a resposta não usa.
              thinkingConfig: { thinkingLevel: 'LOW' },
            },
          }),
          signal: controlador.signal,
        },
      ),
      avaliarDisponibilidades(paraValidar, process.env.GOOGLE_MAPS_KEY),
    ]);

    if (!resposta.ok) {
      const texto = await resposta.text();
      throw new Error(`Falha Gemini: ${resposta.status} - ${texto}`);
    }

    const dados = await resposta.json();

    console.log(`[Conflitos] Gemini respondeu em ${Date.now() - inicio}ms.`);

    // Truncamento tem que se identificar. Sem isto, resposta cortada chega
    // no JSON.parse e o erro fala de aspas e coluna, mandando quem
    // investiga procurar defeito no prompt em vez de no teto de tokens.
    const finishReason = dados.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      throw new Error(
        `Gemini interrompeu a resposta (finishReason: ${finishReason}). Classificação incompleta.`,
      );
    }

    if (!dados.candidates || !dados.candidates[0]?.content) {
      throw new Error('Resposta vazia do Gemini.');
    }

    const cru = dados.candidates[0].content.parts[0].text;
    const limpo = cru.replace(/```json/g, '').replace(/```/g, '').trim();

    const { conflitos, descartados } = conferirResposta(JSON.parse(limpo), itens);

    // Id inventado ou repetido é sintoma, não ruído: se aparecer com
    // frequência, o prompt está frouxo. E como a substituição no app
    // acontece por posição, um id errado mexeria na atividade errada -
    // por isso ele é descartado aqui e registrado.
    if (descartados.length) {
      console.warn(`[Conflitos] Descartados: ${descartados.join(' | ')}`);
    }

    const tokens = dados.usageMetadata?.totalTokenCount ?? 0;
    console.log(
      `[Conflitos] ${conflitos.length} de ${itens.length} conflitam. Tokens: ${tokens}`,
    );
    conflitos.forEach((c) => console.log(`[Conflitos]   ${c.id}: ${c.reason}`));

    // O veredito do Google, item por item. Backup fechado ou fora do
    // período aparece aqui, e é o que impede a emenda de trocar um problema
    // por outro — antes ela escolhia backup só por não conflitar.
    disponibilidade.forEach((d) =>
      console.log(
        `[Disponibilidade] ${d.id}: status=${d.status}` +
        `${d.google_status ? ` (${d.google_status})` : ''}` +
        `, horario=${d.hours_ok === null ? 'sem dado' : d.hours_ok}` +
        `${d.motivo ? ` (${d.motivo})` : ''}`,
      ),
    );

    return res.status(200).json({
      conflicts: conflitos,
      availability: disponibilidade,
      tokens,
    });
  } catch (erro) {
    if (erro.name === 'AbortError') {
      const msg = `Gemini nao respondeu em ${Math.round(TETO_GEMINI_MS / 1000)}s na classificacao de conflitos.`;
      console.error(`[CRÍTICO] ${msg}`);
      return res.status(500).json({ error: msg });
    }
    console.error(`[CRÍTICO] Erro na classificação de conflitos:`, erro.message);
    return res.status(500).json({ error: erro.message });
  } finally {
    // Sempre, inclusive no caminho feliz: um timer pendurado segura a
    // instância viva sem motivo.
    clearTimeout(alarme);
  }
};
