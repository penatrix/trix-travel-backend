// A parte pura do concierge: o que entra, o que o modelo lê e o que sai.
//
// =====================================================================
// O QUE O CONCIERGE É
// =====================================================================
//
// A conversa sobre UM roteiro já gerado: como chegar, quanto custa o dia,
// o que levar, o que fazer se chover. Ele lê o roteiro inteiro da row e
// responde com dado dele. Não planeja viagem nova -- para isso existe o
// fluxo de geração, e o concierge diz isso em uma frase.
//
// As regras de IA da casa valem aqui como em todo serviço:
//
//   - **nunca coordenada.** Para chegar a um lugar, a resposta usa o
//     nome e a busca do Maps que o roteiro já traz. A conferência da
//     saída ainda apaga par de coordenadas que escape;
//   - **horário de funcionamento só se estiver no roteiro.** "Lugar
//     fechado é o pior bug do produto": melhor dizer "confira antes de
//     ir" do que afirmar um horário inventado;
//   - **dado da cidade, não do país**, que já vem nos `quick_facts`;
//   - **preço diz se é por pessoa ou total.**
//
// =====================================================================
// POR QUE A CONVERSA NÃO É GRAVADA
// =====================================================================
//
// O histórico mora no aparelho e chega em cada pedido. Conversa sobre
// viagem carrega dado pessoal (saúde, com quem, onde dorme), e uma
// tabela de conversas pediria uma decisão de LGPD -- retenção, acesso,
// exclusão -- que ainda não foi tomada. O custo de cada mensagem é
// gravado na `eventos`, sem o texto.

/** Tetos da entrada. A URL é pública: um histórico de 1 MB não pode
 *  virar um prompt de 1 MB. */
const MAX_MENSAGEM = 1000;
const MAX_TROCAS = 10;
const MAX_TEXTO_DA_TROCA = 2000;

/** Mensagens por conta a cada 24 horas, contra abuso. O concierge está
 *  liberado para todos até a etapa 3 do Premium; o limite é o que impede
 *  um script de queimar Gemini pela URL. */
const LIMITE_DIARIO = 30;

/** Descrição de atividade cortada: o roteiro de 30 dias passaria de
 *  50 KB, e o que o concierge precisa da descrição é o essencial. */
const MAX_DESCRICAO = 240;

const texto = (v) => (v == null ? '' : String(v).trim());

/**
 * A mensagem e o histórico, limpos e com teto.
 *
 * Devolve `null` quando não há mensagem: pergunta vazia não gasta
 * Gemini.
 */
function limparEntrada(corpo) {
  const mensagem = texto(corpo?.mensagem).slice(0, MAX_MENSAGEM);
  if (!mensagem) return null;

  const tripId = Number(corpo?.trip_id);
  if (!Number.isInteger(tripId) || tripId <= 0) return null;

  const historico = (Array.isArray(corpo?.historico) ? corpo.historico : [])
    .map((t) => ({
      papel: t?.papel === 'trix' ? 'trix' : 'usuario',
      texto: texto(t?.texto).slice(0, MAX_TEXTO_DA_TROCA),
    }))
    .filter((t) => t.texto)
    // As ÚLTIMAS trocas: é o fim da conversa que dá contexto à pergunta.
    .slice(-MAX_TROCAS);

  const lang = corpo?.lang === 'en' ? 'en' : 'pt';
  return { tripId, mensagem, historico, lang };
}

/**
 * O roteiro reduzido ao que o concierge usa.
 *
 * Saem `place_id` e as atividades de reserva, que são dado de máquina, e
 * a descrição é cortada. Fica tudo que uma resposta concreta cita:
 * lugar, período, custo, logística e a busca do Maps.
 */
function compactarRoteiro(row) {
  let roteiro = row?.itinerary_json;
  if (typeof roteiro === 'string') {
    try {
      roteiro = JSON.parse(roteiro);
    } catch (_) {
      roteiro = null;
    }
  }
  if (!roteiro || typeof roteiro !== 'object') return null;

  const destinos = (Array.isArray(roteiro.destinations) ? roteiro.destinations : [])
    .map((d) => ({
      cidade: texto(d?.city),
      dias: d?.days,
      dia_a_dia: (Array.isArray(d?.itinerary) ? d.itinerary : []).map((dia) => ({
        dia: dia?.day,
        atividades: (Array.isArray(dia?.activities) ? dia.activities : []).map((a) => ({
          lugar: texto(a?.place),
          periodo: texto(a?.period),
          custo: texto(a?.cost_estimate),
          logistica: texto(a?.logistics),
          descricao: texto(a?.description).slice(0, MAX_DESCRICAO),
          busca_no_maps: texto(a?.maps_search_query),
        })),
      })),
    }));

  const concierge = roteiro.concierge ?? {};
  const checklist = (Array.isArray(concierge?.checklist?.items) ? concierge.checklist.items : [])
    .map((i) => texto(i?.item_title))
    .filter(Boolean);

  return {
    titulo: texto(roteiro.trip_title) || texto(row?.title),
    viajantes: Number(row?.travelers_count) || null,
    // A data só vai quando alguém a escolheu: `start_date` nunca é nulo,
    // e sem `is_date_set` ela é um chute (CLAUDE.md, armadilhas).
    datas: row?.is_date_set === true
      ? { inicio: row?.start_date ?? null, fim: row?.end_date ?? null }
      : null,
    custo_total_brl: roteiro.estimated_cost_brl ?? null,
    custo_por_categoria: roteiro.cost_breakdown ?? null,
    ida_e_volta: roteiro.origin_transfer ?? null,
    destinos,
    dados_das_cidades: Array.isArray(concierge?.quick_facts) ? concierge.quick_facts : [],
    checklist,
  };
}

/** As instruções do sistema. O roteiro vai junto, como dado. */
function montarInstrucoes(roteiroCompacto, lang = 'pt') {
  const idioma = lang === 'en'
    ? 'Answer in English.'
    : 'Responda em português do Brasil.';
  return [
    'Você é o concierge da Trix, um app de planejamento de viagens. A Trix é',
    'uma marca feminina: diga "a Trix", nunca "o Trix".',
    'Você conversa sobre UM roteiro já montado, que vem abaixo em JSON. Responda',
    'só com base nele e no conhecimento geral sobre as cidades dele.',
    '',
    'Regras:',
    '- Direta antes de simpática: a primeira frase é a resposta.',
    '- Concreta: cite lugar, dia, período, custo e trajeto do roteiro quando',
    '  existirem. Sem dado, não invente número.',
    '- Curta: até 120 palavras, em texto corrido ou lista curta. Sem emoji,',
    '  sem markdown de título.',
    '- NUNCA escreva coordenadas de GPS. Para indicar um lugar, use o nome e a',
    '  "busca_no_maps" do roteiro.',
    '- Não afirme horário de funcionamento que não esteja no roteiro. Se for',
    '  importante, diga para conferir no Google Maps antes de ir.',
    '- Preço sempre diz se é por pessoa ou total, como o roteiro diz.',
    '- Se a pergunta não for sobre este roteiro (planejar outra viagem, assunto',
    '  alheio a viagem), diga em uma frase que você cuida deste roteiro e que um',
    '  roteiro novo se cria em "Novo roteiro".',
    '- Se não souber, diga que não sabe. Não suponha.',
    '- A Trix é empresa de tecnologia, não agência de viagens: não reserve,',
    '  não venda e não prometa reserva.',
    idioma,
    '',
    'ROTEIRO:',
    JSON.stringify(roteiroCompacto),
  ].join('\n');
}

/** O histórico no formato de conversa do Gemini, com a pergunta no fim. */
function montarConversa(historico, mensagem) {
  return [
    ...historico.map((t) => ({
      role: t.papel === 'trix' ? 'model' : 'user',
      parts: [{ text: t.texto }],
    })),
    { role: 'user', parts: [{ text: mensagem }] },
  ];
}

// Um par de números com 4+ casas decimais separados por vírgula ou
// espaço: "-23.5505, -46.6333". Endereço e preço não têm esse formato.
const COORDENADAS = /-?\d{1,3}\.\d{4,}\s*[,;]\s*-?\d{1,3}\.\d{4,}/g;

/**
 * A resposta do modelo, conferida. Apaga coordenada que escape -- a IA
 * nunca gera GPS, nem por descuido -- e devolve `null` se não sobrar
 * texto.
 */
function conferirResposta(cru) {
  const limpo = texto(cru).replace(COORDENADAS, '').replace(/\n{3,}/g, '\n\n').trim();
  return limpo || null;
}

/** "Já foram 30 perguntas", no idioma do pedido. */
function mensagemDoLimite(lang = 'pt') {
  return lang === 'en'
    ? `You have reached ${LIMITE_DIARIO} questions in 24 hours. The concierge is back tomorrow.`
    : `Você chegou a ${LIMITE_DIARIO} perguntas em 24 horas. O concierge volta amanhã.`;
}

/// O aviso de roteiro que não é Premium (06/10). O app pergunta antes de
/// abrir a conversa; esta frase só chega lá se a pergunta do app falhou.
function mensagemDoPremium(lang = 'pt') {
  return lang === 'en'
    ? 'The concierge is Premium. Whoever created this itinerary can make it Premium.'
    : 'O concierge é Premium. Quem criou este roteiro pode torná-lo Premium.';
}

module.exports = {
  limparEntrada,
  mensagemDoPremium,
  compactarRoteiro,
  montarInstrucoes,
  montarConversa,
  conferirResposta,
  mensagemDoLimite,
  LIMITE_DIARIO,
  MAX_MENSAGEM,
  MAX_TROCAS,
  MAX_DESCRICAO,
};
