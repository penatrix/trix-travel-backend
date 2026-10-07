const jwt = require('jsonwebtoken');
const {
  limparEntrada,
  lerRoteiro,
  achatarDias,
  dataDoDia,
  lugaresDoRoteiro,
  marcarLugares,
  desmarcarLugares,
  aplicarChecagem,
  aplicarTrocaDaIa,
  marcarAviso,
  pedidoParaIa,
  lugaresParaEvitar,
  ajustarCusto,
  ordenarMudancas,
  MARCA,
} = require('./checagem');
const {
  codigoDoPais,
  feriadosNoPeriodo,
  montarPerguntaDeFeriados,
  lerRespostaDeFeriados,
} = require('./feriados');
// Os quatro abaixo chegam por cópia, no cloudbuild e no `pretest`: o
// `validar-lugares` e o `registra-evento` da pasta do generate-trip, e
// o prompt e a escolha da troca da pasta do micro-activity. A troca pelo
// Pro aqui é a MESMA troca da tela, com o dia da semana a mais.
const {
  consultarLugar,
  consultarHorarios,
  guardarHorarios,
  guardarTipos,
  emLotes,
  CAMPO_HORARIOS,
} = require('./validar-lugares');
const { montarPromptDaTroca, listaDeEvitar } = require('./prompt-da-troca');
const { escolherCandidato } = require('./escolher-candidato');
const { registrarEvento, contadorDePlaces, statusDoErro } = require('./registra-evento');

// Os modelos, num lugar só -- eles são DADO na linha de `eventos`.
//
// Flash para os feriados: é leitura de calendário e de tipo de lugar,
// com resposta curta. Pro para a troca, porque é a troca de atividade de
// sempre (decisão de qualidade, CLAUDE.md).
const MODELO_FERIADOS = 'gemini-3.6-flash';
const MODELO_TROCA = 'gemini-3.1-pro-preview';

// =================================================================
// ORÇAMENTO DE TEMPO
//
// O app espera 110 s, e o Cloud Run tem 120 s (cloudbuild), MAIOR, para
// quem corta ser o handler, com log e resposta.
//
//   Google + Flash, em paralelo ........ até ~25 s
//   Pro, as trocas em paralelo ......... até 50 s, e só começa se a
//                                        primeira fase acabou antes de 45 s
//   = pior caso ~95 s
//
// Na prática, roteiro gerado depois de 06/10 já tem o horário guardado
// e a primeira fase é só o Flash.
// =================================================================
const TETO_FERIADOS_MS = 25000;
const TETO_TROCA_MS = 50000;
const INICIA_TROCA_ATE_MS = 45000;
const TETO_BANCO_MS = 5000;
const TETO_NAGER_MS = 5000;
const CONCORRENCIA_GOOGLE = 10;

// =================================================================
// AUTENTICACAO
//
// Qualquer sessão com conta, inclusive a anônima do soft onboarding: o
// que decide é ser dono do roteiro, conferido logo abaixo.
// =================================================================
function verificarToken(req) {
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    });
    return payload.role === 'authenticated' ? payload : null;
  } catch (err) {
    return null;
  }
}

// =================================================================
// O BANCO, POR FETCH (como o concierge)
//
// A chave é a de serviço, então a RLS não filtra: o dono é conferido
// AQUI, à mão. Só o dono muda a data (decisão do Paulo, 06/10).
// =================================================================
async function lerRoteiroDoBanco(tripId) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) throw new Error('SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausente.');
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_BANCO_MS);
  try {
    const resposta = await fetch(
      `${url}/rest/v1/trips?id=eq.${tripId}&select=user_id,status,itinerary_json`,
      {
        headers: { apikey: chave, Authorization: `Bearer ${chave}` },
        signal: controlador.signal,
      },
    );
    if (!resposta.ok) throw new Error(`Banco respondeu ${resposta.status} em trips.`);
    const linhas = await resposta.json();
    return Array.isArray(linhas) ? linhas[0] ?? null : null;
  } finally {
    clearTimeout(alarme);
  }
}

// =================================================================
// O HORÁRIO DE CADA LUGAR
//
// O que já está guardado na atividade não vai ao Google. O que falta
// (roteiro de antes de 06/10, ou lugar sem horário cadastrado) vai uma
// vez, e fica guardado para a próxima mudança de data.
// =================================================================
async function completarHorarios(roteiro, apiKey, contador) {
  if (!apiKey) return;
  const faltam = lugaresDoRoteiro(roteiro)
    .map((l) => l.obj)
    .filter((obj) => !obj[CAMPO_HORARIOS] && (obj.place_id || obj.maps_search_query));
  await emLotes(faltam, CONCORRENCIA_GOOGLE, async (obj) => {
    if (!obj.place_id) {
      const lugar = await consultarLugar(String(obj.maps_search_query), apiKey, contador);
      if (!lugar.placeId) return;
      obj.place_id = lugar.placeId;
      // De graça na mesma busca: roteiro antigo ganha o tipo do lugar.
      guardarTipos(obj, lugar.tipos);
    }
    guardarHorarios(obj, await consultarHorarios(obj.place_id, apiKey, contador));
  });
}

// =================================================================
// OS FERIADOS
// =================================================================

// A Nager não muda o calendário de um ano no meio do dia: a instância
// guarda o que já buscou. Por país e ano; e a lista de países.
const memoriaDaNager = new Map();

async function daNager(caminho) {
  if (memoriaDaNager.has(caminho)) return memoriaDaNager.get(caminho);
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_NAGER_MS);
  try {
    const resposta = await fetch(`https://date.nager.at/api/v3/${caminho}`, {
      signal: controlador.signal,
    });
    // 404 é "país sem calendário na Nager": vira lista vazia, e fica
    // guardado como tal.
    if (resposta.status === 404) {
      memoriaDaNager.set(caminho, []);
      return [];
    }
    if (!resposta.ok) throw new Error(`Nager respondeu ${resposta.status}.`);
    const dados = await resposta.json();
    memoriaDaNager.set(caminho, dados);
    return dados;
  } finally {
    clearTimeout(alarme);
  }
}

/// Os feriados oficiais do período, de todos os países do roteiro.
/// `null` quando a Nager não respondeu: a checagem segue, sem eles.
async function feriadosOficiais(roteiro, inicio, fim) {
  try {
    const disponiveis = await daNager('AvailableCountries');
    const paises = new Set(
      roteiro.destinations.map((d) => codigoDoPais(d, disponiveis)).filter(Boolean),
    );
    const anos = new Set([inicio.slice(0, 4), fim.slice(0, 4)]);
    const listas = await Promise.all(
      [...paises].flatMap((p) => [...anos].map((a) => daNager(`PublicHolidays/${a}/${p}`))),
    );
    return { paises, feriados: feriadosNoPeriodo(listas.flat(), inicio, fim) };
  } catch (erro) {
    console.warn(`[Datas] Nager fora: ${erro.message}`);
    return null;
  }
}

/// A pergunta ao Flash, e a resposta conferida. Nunca lança: sem
/// resposta, `conferidos` é false e ninguém fecha por feriado.
async function conferirFeriados(roteiro, dataInicio, idioma) {
  const dias = achatarDias(roteiro);
  const inicio = dataDoDia(dataInicio, 1);
  const fim = dataDoDia(dataInicio, dias.length);

  const oficiais = await feriadosOficiais(roteiro, inicio, fim);

  // O que vai na pergunta, e o mapa para conferir a resposta.
  const porCidade = new Map();
  const datasDaCidade = new Map();
  const lugares = new Map();
  for (const { destino, dia, numero } of dias) {
    const cidade = String(destino.city ?? '').trim() || '(sem nome)';
    if (!porCidade.has(cidade)) {
      porCidade.set(cidade, {
        cidade,
        pais: null,
        dias: [],
        backups: (destino.backup_activities ?? [])
          .filter((b) => b?.[MARCA])
          .map((b) => ({ id: b[MARCA], lugar: b.place })),
      });
      datasDaCidade.set(cidade, new Set());
      for (const b of destino.backup_activities ?? []) {
        if (b?.[MARCA]) lugares.set(b[MARCA], { cidade, data: null });
      }
    }
    const data = dataDoDia(dataInicio, numero);
    datasDaCidade.get(cidade).add(data);
    const atividades = (dia.activities ?? []).filter((a) => a?.[MARCA]);
    for (const a of atividades) lugares.set(a[MARCA], { cidade, data });
    porCidade.get(cidade).dias.push({
      data,
      atividades: atividades.map((a) => ({ id: a[MARCA], lugar: a.place, periodo: a.period })),
    });
  }

  const pergunta = montarPerguntaDeFeriados({
    cidades: [...porCidade.values()],
    feriados: oficiais?.feriados ?? [],
    idioma,
  });

  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_FERIADOS_MS);
  let uso = null;
  try {
    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_FERIADOS}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: pergunta }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
            // O pensamento conta dentro do teto: 4096 deixa folga para
            // o LOW e para a resposta, que é curta.
            maxOutputTokens: 4096,
            // LOW, declarado: omitir não desliga (CLAUDE.md).
            thinkingConfig: { thinkingLevel: 'LOW' },
          },
        }),
        signal: controlador.signal,
      },
    );
    if (!resposta.ok) throw new Error(`Flash respondeu ${resposta.status}.`);
    const dados = await resposta.json();
    uso = dados.usageMetadata ?? null;
    if (dados.candidates?.[0]?.finishReason !== 'STOP') {
      throw new Error(`Flash interrompeu (${dados.candidates?.[0]?.finishReason}).`);
    }
    const texto = (dados.candidates[0].content?.parts ?? []).map((p) => p?.text ?? '').join('');
    const lido = lerRespostaDeFeriados(texto, { datasDaCidade, lugares });
    if (!lido) throw new Error('Resposta do Flash não é o JSON pedido.');
    return { ...lido, conferidos: oficiais !== null, uso, paises: oficiais?.paises?.size ?? 0 };
  } catch (erro) {
    const msg = erro.name === 'AbortError'
      ? `Flash não respondeu em ${TETO_FERIADOS_MS / 1000}s.`
      : erro.message;
    console.warn(`[Datas] Feriados não conferidos: ${msg}`);
    return { feriados: [], fechados: new Map(), conferidos: false, uso, erro: msg };
  } finally {
    clearTimeout(alarme);
  }
}

// =================================================================
// A TROCA PELO PRO
//
// O prompt e a escolha são os da troca da tela (cópia do
// micro-activity). A diferença está no pedido, que diz por que o lugar
// sai e quando o substituto precisa abrir, e no `diaDaSemana`, que faz
// o Google conferir AQUELE dia em vez de "algum dia".
// =================================================================
async function trocarPeloPro(pendente, { evitar, idioma, tetoMs, tripId, userId }) {
  const comecou = Date.now();
  // Contador próprio: as trocas correm em paralelo, e cada uma grava a
  // SUA linha de `troca_atividade`. Somar na linha da checagem contaria
  // a mesma chamada duas vezes.
  const contador = contadorDePlaces();
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), tetoMs);
  let uso = null;
  try {
    const prompt = montarPromptDaTroca({
      cidade: pendente.cidade,
      periodo: pendente.periodo,
      custoAtual: String(pendente.atividade.cost_estimate ?? ''),
      evitar,
      pedido: pedidoParaIa(pendente, idioma),
      idioma,
    });
    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_TROCA}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 4096,
            // LOW, como na troca da tela: é recuperação, não raciocínio.
            thinkingConfig: { thinkingLevel: 'LOW' },
          },
        }),
        signal: controlador.signal,
      },
    );
    if (!resposta.ok) throw new Error(`Pro respondeu ${resposta.status}.`);
    const dados = await resposta.json();
    uso = dados.usageMetadata ?? null;
    const texto = dados.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const bruto = JSON.parse(texto.replace(/```json/g, '').replace(/```/g, '').trim());
    const candidatos = Array.isArray(bruto?.suggestions) ? bruto.suggestions : [];
    if (!candidatos.length) throw new Error('Pro não devolveu candidatos.');

    const escolha = await escolherCandidato(
      candidatos,
      pendente.periodo,
      process.env.GOOGLE_MAPS_KEY,
      contador,
      { diaDaSemana: pendente.diaDaSemana },
    );

    registrarEvento({
      tipo: 'troca_atividade',
      tripId,
      userId,
      modelo: MODELO_TROCA,
      uso,
      chamadasPlaces: contador.chamadas,
      duracaoMs: Date.now() - comecou,
      meta: { origem: 'checagem_de_datas', degradado: !!escolha.degradado, motivo: pendente.motivo },
    });

    // Degradado é "nenhum candidato abre naquele dia" (ou todos
    // fechados): trocar um problema por outro não é conserto.
    return escolha.degradado ? null : escolha.escolhido;
  } catch (erro) {
    const msg = erro.name === 'AbortError'
      ? `Pro não respondeu em ${Math.round(tetoMs / 1000)}s.`
      : erro.message;
    registrarEvento({
      tipo: 'troca_atividade',
      status: statusDoErro(erro),
      motivo: msg,
      tripId,
      userId,
      modelo: MODELO_TROCA,
      uso,
      chamadasPlaces: contador.chamadas,
      duracaoMs: Date.now() - comecou,
      meta: { origem: 'checagem_de_datas' },
    });
    console.warn(`[Datas] Troca pelo Pro falhou para ${pendente.lugar}: ${msg}`);
    return null;
  } finally {
    clearTimeout(alarme);
  }
}

// =================================================================
// SERVIÇO: A CHECAGEM DE DATAS DE UM ROTEIRO
//
// Entrada: { trip_id, data_inicio: "AAAA-MM-DD", idioma }
// Saída 200: {
//   itinerary_json            -- o roteiro conferido e consertado
//   itinerary_json_sem_trocas -- o mesmo roteiro sem nada trocado, só com
//                                o aviso de horário: é o "Desfazer"
//   mudancas: [{ tipo, dia, data, cidade, lugar, periodo, motivo,
//                feriado, lugar_novo?, periodo_novo?, parceira? }]
//   feriados: [{ data, cidade, nome }]
//   feriados_conferidos: bool
// }
//
// NÃO grava nada: quem grava é o app, junto com as datas, num update
// só. É isso que deixa o "Desfazer" simples, e que impede roteiro com
// data nova e atividades velhas se a pessoa sair no meio.
//
// Erros: 401 sem conta, 400 pedido inválido, 403 roteiro de outra
// pessoa, 404 roteiro inexistente, 409 roteiro sem conteúdo.
// =================================================================
exports.checarDatas = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  const usuario = verificarToken(req);
  if (!usuario) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  const entrada = limparEntrada(req.body ?? {});
  if (!entrada) {
    return res.status(400).json({ error: 'trip_id e data_inicio (AAAA-MM-DD) são obrigatórios.' });
  }
  const { tripId, dataInicio, idioma } = entrada;

  const comecou = Date.now();
  const contador = contadorDePlaces();
  let usoDoFlash = null;

  try {
    const row = await lerRoteiroDoBanco(tripId);
    if (!row) return res.status(404).json({ error: 'Roteiro não encontrado.' });
    if (row.user_id !== usuario.sub) {
      return res.status(403).json({ error: 'Só quem criou o roteiro muda a data.' });
    }
    const roteiro = lerRoteiro(row.itinerary_json);
    if (!roteiro) return res.status(409).json({ error: 'O roteiro ainda não tem conteúdo.' });

    marcarLugares(roteiro);

    // ---- 1. Horário e feriados, ao mesmo tempo ----
    const [, feriados] = await Promise.all([
      completarHorarios(roteiro, process.env.GOOGLE_MAPS_KEY, contador),
      conferirFeriados(roteiro, dataInicio, idioma),
    ]);
    usoDoFlash = feriados.uso;
    const feriadoDe = (obj, data) => feriados.fechados.get(`${obj?.[MARCA]}|${data}`) ?? null;

    // ---- 2. As duas versões: consertada, e só com os avisos ----
    const consertado = structuredClone(roteiro);
    const semTrocas = structuredClone(roteiro);
    const checagem = aplicarChecagem(consertado, { dataInicio, feriadoDe });
    aplicarChecagem(semTrocas, { dataInicio, feriadoDe, consertar: false });

    const mudancas = [...checagem.mudancas];
    let deltaCusto = checagem.deltaCusto;

    // ---- 3. O Pro, para o que o banco não resolveu ----
    const decorrido = Date.now() - comecou;
    const podeTrocar = checagem.pendentes.length > 0 && decorrido < INICIA_TROCA_ATE_MS;
    const evitar = listaDeEvitar(lugaresParaEvitar(consertado));
    const novas = podeTrocar
      ? await Promise.all(checagem.pendentes.map((p) =>
          trocarPeloPro(p, {
            evitar,
            idioma,
            tetoMs: TETO_TROCA_MS,
            tripId,
            userId: usuario.sub,
          })))
      : checagem.pendentes.map(() => null);

    checagem.pendentes.forEach((p, i) => {
      const trocou = novas[i] ? aplicarTrocaDaIa(p, novas[i]) : null;
      if (trocou) {
        mudancas.push(trocou.mudanca);
        deltaCusto += trocou.deltaCusto;
      } else {
        mudancas.push(marcarAviso(p));
      }
    });

    ajustarCusto(consertado, deltaCusto);
    desmarcarLugares(consertado);
    desmarcarLugares(semTrocas);

    const contagem = (tipo) => mudancas.filter((m) => m.tipo === tipo).length;
    console.log(
      `[Datas] Roteiro ${tripId}, chegada ${dataInicio}: ` +
        `${contagem('reordenado')} reordenada(s), ${contagem('backup')} por backup, ` +
        `${contagem('ia')} pelo Pro, ${contagem('aviso')} com aviso; ` +
        `${feriados.feriados.length} feriado(s); ${contador.chamadas} chamada(s) ao Google.`,
    );

    registrarEvento({
      tipo: 'checagem_de_datas',
      tripId,
      userId: usuario.sub,
      modelo: MODELO_FERIADOS,
      uso: usoDoFlash,
      chamadasPlaces: contador.chamadas,
      duracaoMs: Date.now() - comecou,
      meta: {
        reordenadas: contagem('reordenado'),
        backups: contagem('backup'),
        pelo_pro: contagem('ia'),
        avisos: contagem('aviso'),
        feriados: feriados.feriados.length,
        feriados_conferidos: feriados.conferidos,
      },
    });

    return res.status(200).json({
      itinerary_json: consertado,
      itinerary_json_sem_trocas: semTrocas,
      mudancas: ordenarMudancas(mudancas),
      feriados: feriados.feriados,
      feriados_conferidos: feriados.conferidos,
    });
  } catch (erro) {
    registrarEvento({
      tipo: 'checagem_de_datas',
      status: statusDoErro(erro),
      motivo: erro.message,
      tripId,
      userId: usuario.sub,
      modelo: MODELO_FERIADOS,
      uso: usoDoFlash,
      chamadasPlaces: contador.chamadas,
      duracaoMs: Date.now() - comecou,
    });
    console.error(`[CRÍTICO] Erro na checagem de datas: ${erro.message}`);
    return res.status(500).json({ error: erro.message });
  }
};
