// Recebe os candidatos que o Gemini devolveu e escolhe o melhor
// verificado, sem gastar outra ida ao modelo.
//
// =====================================================================
// A IDEIA
// =====================================================================
//
// Antes: uma sugestão, e se ela viesse fechada o handler pedia OUTRA ao
// Gemini - mais ~20s de espera para o usuário, no pior momento possível
// (ele já estava esperando).
//
// Agora: o prompt pede TRÊS candidatos numa tacada. Gerar três sugestões
// curtas custa quase o mesmo tempo que gerar uma, porque o tempo está no
// raciocínio e não na escrita. Então a checagem no Google escolhe entre
// eles, e o caminho ruim deixa de custar uma segunda geração.
//
// As consultas ao Google vão TODAS em paralelo: três candidatos × duas
// consultas (status e horário) são seis chamadas, mas o relógio conta
// duas idas, não seis.
//
// =====================================================================
// DE ONDE VEM A VALIDAÇÃO
// =====================================================================
//
// Do `./validar-lugares`, que é o mesmo arquivo usado pelo generate-trip
// e chega aqui por um passo de cópia no cloudbuild (e pelo `pretest`, no
// desenvolvimento local). Não é duplicação: a lógica de janela de
// horário é onde mora o risco de falso positivo, e ter duas cópias dela
// seria pedir para divergirem.
// =====================================================================

const {
  consultarLugar,
  consultarHorarios,
  abreNaJanela,
  abreNoPeriodoEmAlgumDia,
  compactarHorarios,
  normalizarPeriodo,
  guardarTipos,
  JANELAS,
} = require('./validar-lugares');

// =====================================================================
// A CHECAGEM DE HORÁRIO VIVE NO MÓDULO COMPARTILHADO
//
// `abreNoPeriodoEmAlgumDia` era definida aqui. Mudou para o
// `validar-lugares`, que é o arquivo que este serviço já recebe por cópia
// de build — porque a emenda de roteiro passou a precisar da mesma
// checagem para validar backup, e a lógica de janela é onde mora o risco
// de falso positivo. Duas cópias dela seria pedir para divergirem.
//
// O que ela responde: "abre neste período em ALGUM dia?". Não precisa de
// data, e é isso que a torna útil aqui — este serviço recebe o período, não
// o dia. O que ela não pega é "fecha às segundas".
// =====================================================================

/// Avalia um candidato. NUNCA lança: qualquer falha vira veredito de
/// "não deu para verificar", e a escolha lida com isso.
///
/// Não recebe teto de tempo: `consultarLugar` e `consultarHorarios` já
/// têm o deles (8s cada, dentro do validar-lugares), e como todos os
/// candidatos são avaliados em PARALELO o pior caso do relógio são esses
/// mesmos ~8s - folgado dentro do orçamento de 50s do pedido. Enfiar o
/// prazo aqui exigiria mexer na assinatura daquelas duas, que o
/// generate-trip também usa, sem ganho nenhum.
///
/// `diaDaSemana` (0 = domingo) é opcional. A troca da tela não manda --
/// ela só tem o período, e a pergunta é "abre neste turno em algum
/// dia". A checagem de datas manda, porque ali o dia é conhecido e o
/// substituto precisa abrir NAQUELE dia: trocar um museu fechado na
/// segunda por outro fechado na segunda não conserta nada.
async function avaliarCandidato(candidato, janela, apiKey, contador = null, diaDaSemana = null) {
  const busca = candidato?.maps_search_query;

  if (!apiKey || !busca || !String(busca).trim()) {
    return { candidato, status: 'erro', horario: null, motivo: 'sem chave ou sem busca' };
  }

  const lugar = await consultarLugar(String(busca), apiKey, contador);

  // Sem place_id não há como pedir horário. Vale para fechado, não
  // encontrado e erro.
  if (lugar.veredito !== 'aberto' || !lugar.placeId) {
    return {
      candidato,
      status: lugar.veredito,
      horario: null,
      googleStatus: lugar.status,
      motivo: lugar.motivo,
    };
  }

  // Só chega aqui quem passou no status. Sem janela (período que o app
  // não mandou, ou período que não reconhecemos) o horário fica sem
  // veredito, e o candidato continua elegível.
  const periodos = janela
    ? await consultarHorarios(lugar.placeId, apiKey, contador)
    : null;
  const horario = !janela
    ? null
    : Number.isInteger(diaDaSemana)
      ? abreNaJanela(periodos, diaDaSemana, janela)
      : abreNoPeriodoEmAlgumDia(periodos, janela);

  return {
    candidato,
    status: 'aberto',
    horario,
    nomeGoogle: lugar.nomeGoogle,
    // Vão para a atividade escolhida: o `place_id` deixa o link do Maps
    // exato, e o horário guardado poupa a checagem de datas de voltar
    // ao Google.
    placeId: lugar.placeId,
    horarios: compactarHorarios(periodos),
    // O tipo do lugar escolhe a imagem de categoria no app.
    tipos: lugar.tipos,
  };
}

// =====================================================================
// A ORDENAÇÃO
//
// Menor é melhor. A ordem em que o modelo devolveu desempata, porque ele
// já entrega ranqueado por qualidade - o primeiro é a aposta dele.
//
// Escala pensada para que verificação NUNCA piore a escolha: um
// candidato que passou vale mais que um que não deu para verificar, e um
// que não deu para verificar vale muito mais que um fechado.
// =====================================================================
function penalidade(v) {
  if (v.status === 'fechado') return 100;   // último recurso
  if (v.horario === false) return 10;       // aberto, mas não neste período
  if (v.status !== 'aberto') return 1;      // não deu para verificar
  return 0;                                 // verificado e compatível
}

/**
 * Escolhe entre os candidatos e devolve { escolhido, vereditos, motivo }.
 * `escolhido` é sempre um candidato - entregar algo é melhor que não
 * entregar nada, e o `motivo` diz em que condição ele foi escolhido para
 * o log contar a verdade.
 */
async function escolherCandidato(
  candidatos,
  periodoBruto,
  apiKey,
  contador = null,
  { diaDaSemana = null } = {},
) {
  const lista = (Array.isArray(candidatos) ? candidatos : [candidatos]).filter(Boolean);

  if (lista.length === 0) {
    throw new Error('Nenhum candidato para escolher.');
  }

  const chave = normalizarPeriodo(periodoBruto);
  const janela = chave ? JANELAS[chave] : null;

  // Tudo em paralelo: é isto que faz a verificação custar ~1 ida em vez
  // de uma por candidato.
  const vereditos = await Promise.all(
    lista.map((c) => avaliarCandidato(c, janela, apiKey, contador, diaDaSemana)),
  );

  let melhor = 0;
  for (let i = 1; i < vereditos.length; i += 1) {
    if (penalidade(vereditos[i]) < penalidade(vereditos[melhor])) melhor = i;
  }

  const v = vereditos[melhor];
  const motivo =
    penalidade(v) === 0
      ? (v.horario === true ? 'verificado: aberto e compatível com o período' : 'verificado: aberto')
      : penalidade(v) === 1
        ? `entregue sem verificação (${v.status}${v.motivo ? `: ${v.motivo}` : ''})`
        : penalidade(v) === 10
          ? 'nenhum candidato compatível com o período; entregue o menos pior'
          : 'todos os candidatos vieram fechados; entregue o primeiro';

  return {
    escolhido: comODoGoogle(v),
    indiceEscolhido: melhor,
    vereditos,
    motivo,
    degradado: penalidade(v) > 1,
  };
}

/// O candidato escolhido, com o que o Google confirmou sobre ele.
///
/// Cópia, para não mexer no objeto que o modelo devolveu. Sem dado, a
/// chave não entra: ausência é o que diz "não consultado".
function comODoGoogle(v) {
  const atividade = { ...v.candidato };
  if (v.placeId) atividade.place_id = v.placeId;
  if (v.horarios) atividade.opening_hours_periods = v.horarios;
  guardarTipos(atividade, v.tipos);
  return atividade;
}

module.exports = {
  escolherCandidato,
  avaliarCandidato,
  penalidade,
};
