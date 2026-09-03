// =====================================================================
// VALIDAÇÃO DE STATUS DOS LUGARES
//
// O pior bug do produto é entregar um lugar fechado. O Gemini não tem como
// saber que um restaurante fechou: ele escreve a partir do que leu no
// treinamento. Quem sabe é o Google, e nós já pedimos ao modelo a string
// exata de busca (maps_search_query) para consultá-lo.
//
// Esta camada roda DEPOIS do Gemini responder e ANTES de o roteiro virar
// 'ready'. Lugar fechado é trocado, em silêncio, por um do banco de
// backup_activities daquela cidade - que é exatamente para isso que o prompt
// pede 4 backups por destino, e é o que o CLAUDE.md manda preferir a uma
// nova chamada de IA.
//
// Usa a API legada do Places (maps.googleapis.com), mesma família do
// autocomplete que já funciona com a GOOGLE_MAPS_KEY atual. A Places API
// (New) exigiria habilitar outro serviço no GCP.
// =====================================================================

const CONCORRENCIA = 5;        // consultas simultâneas ao Google
const TIMEOUT_MS = 8000;       // por consulta

const FECHADO = new Set(['CLOSED_TEMPORARILY', 'CLOSED_PERMANENTLY']);

// ---------------------------------------------------------------------
// Horário de funcionamento
//
// business_status pega o que fechou de vez. Horário pega o que está
// fechado NAQUELE momento - museu que não abre segunda, restaurante que
// só serve jantar. É a queixa "indicou de manhã e estava fechado".
// ---------------------------------------------------------------------

/// Janelas em minutos desde a meia-noite. Ficam aqui, e não no prompt,
/// porque quem compara com o Google somos nós e não o modelo.
const JANELAS = {
  manha: [6 * 60, 12 * 60],
  tarde: [12 * 60, 18 * 60],
  noite: [18 * 60, 24 * 60],
};

/// O period vem no idioma do usuário. Aceita os dois e devolve a chave
/// interna; qualquer outra coisa vira null e a atividade não é checada.
function normalizarPeriodo(bruto) {
  const p = String(bruto ?? '').trim().toLowerCase();
  if (p === 'manhã' || p === 'manha' || p === 'morning') return 'manha';
  if (p === 'tarde' || p === 'afternoon') return 'tarde';
  if (p === 'noite' || p === 'evening' || p === 'night') return 'noite';
  return null;
}

/// "0930" -> 570. null em qualquer formato inesperado.
function horaParaMinutos(hhmm) {
  const m = /^(\d{2})(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/// O lugar abre em algum momento da janela, naquele dia da semana?
///
/// `periods` é o formato do Places: day 0 = domingo, time "HHMM". Um
/// período sem `close` significa aberto 24 horas.
/// Devolve null quando não há dado - que NÃO é o mesmo que fechado.
function abreNaJanela(periods, diaDaSemana, janela) {
  if (!Array.isArray(periods) || periods.length === 0) return null;
  const [inicio, fim] = janela;

  for (const p of periods) {
    const abre = p?.open;
    if (!abre) continue;

    // Sem close = aberto 24h, todos os dias.
    if (!p.close) return true;

    const tAbre = horaParaMinutos(abre.time);
    const tFecha = horaParaMinutos(p.close.time);
    if (tAbre === null || tFecha === null) continue;

    // Trecho que começa no dia pedido. Se fecha em outro dia, atravessa a
    // meia-noite e, para este dia, vale até o fim do dia.
    if (abre.day === diaDaSemana) {
      const ate = p.close.day === diaDaSemana ? tFecha : 24 * 60;
      if (tAbre < fim && ate > inicio) return true;
    }

    // Trecho que começou ontem e ainda está aberto de madrugada. Raro na
    // janela da manhã, mas um bar que fecha às 04:00 cai aqui.
    const ontem = (diaDaSemana + 6) % 7;
    if (abre.day === ontem && p.close.day === diaDaSemana) {
      if (fim > 0 && tFecha > inicio) return true;
    }
  }
  return false;
}

/// Busca os horários pelo place_id que a consulta de status já resolveu.
/// fields=opening_hours mantém resposta e custo no mínimo.
// =====================================================================
// REORDENAR DENTRO DO DIA, EM VEZ DE GASTAR BACKUP
//
// O defeito: o modelo põe restaurante que só serve almoço num slot de
// jantar. A correção antiga era trocar o LUGAR por um backup - e a viagem
// 252 mostrou que é isso que esvazia o banco: `0 fechados` e `5 fora do
// período`, com Foz do Iguaçu gastando os dois backups e ainda entregando
// dois jantares impossíveis.
//
// Só que quase sempre não falta lugar: falta ORDEM. Se o restaurante de
// almoço está à noite e há uma atividade de tarde no mesmo dia, as duas
// trocando de slot resolve sem gastar backup, sem chamar API e sem
// inventar lugar nenhum.
//
// As duas condições são deliberadamente assimétricas:
//
//   - quem está errado precisa ABRIR no período novo, verificado (`true`).
//     "Sem dado" não serve: trocar um problema conhecido por um
//     desconhecido não é conserto.
//   - quem cede o slot só não pode QUEBRAR nele (`!== false`). Aqui "sem
//     dado" passa, e é isso que faz a troca funcionar no caso comum:
//     praça, mirante, praia e mercado a céu aberto não têm horário
//     cadastrado, então recebem qualquer período.
//
// Custo conhecido: o texto de `logistics` do lugar que se mudou pode
// citar horário ("vá no fim do dia"). Reescrever exigiria nova chamada ao
// modelo, o que é justamente o que esta função existe para evitar.
// =====================================================================

/// Distância entre períodos, em slots. Serve para preferir a troca mais
/// curta: mandar o almoço para a tarde estranha menos que para a manhã, e
/// é onde o texto de logística tem mais chance de continuar valendo.
const ORDEM_DOS_PERIODOS = ['manha', 'tarde', 'noite'];

function distanciaEntrePeriodos(a, b) {
  const ia = ORDEM_DOS_PERIODOS.indexOf(normalizarPeriodo(a));
  const ib = ORDEM_DOS_PERIODOS.indexOf(normalizarPeriodo(b));
  if (ia < 0 || ib < 0) return 99;
  return Math.abs(ia - ib);
}

/// Procura, no MESMO dia, com quem a atividade do índice `i` pode trocar
/// de slot. Devolve o índice da parceira, ou -1.
///
/// `abreNoPeriodo(obj, periodoBruto)` -> true / false / null
/// `elegivel(obj)` -> false para quem já está condenado (lugar fechado
/// sai ou é substituído logo abaixo; trocar de slot com ele só mudaria o
/// período do buraco).
function acharTrocaDePeriodo(atividades, i, { abreNoPeriodo, elegivel }) {
  const atv = atividades[i];
  const periodoAtual = normalizarPeriodo(atv?.period);
  if (!periodoAtual) return -1;

  const candidatos = [];
  for (let j = 0; j < atividades.length; j += 1) {
    if (j === i) continue;
    const outra = atividades[j];
    const periodoOutra = normalizarPeriodo(outra?.period);
    if (!periodoOutra || periodoOutra === periodoAtual) continue;
    if (!elegivel(outra)) continue;
    if (abreNoPeriodo(atv, outra.period) !== true) continue;
    if (abreNoPeriodo(outra, atv.period) === false) continue;
    candidatos.push(j);
  }

  if (!candidatos.length) return -1;

  candidatos.sort(
    (x, y) =>
      distanciaEntrePeriodos(atividades[x].period, periodoAtual) -
      distanciaEntrePeriodos(atividades[y].period, periodoAtual),
  );
  return candidatos[0];
}

/// Troca duas atividades de slot, no lugar.
///
/// Cada SLOT mantém o período dele; quem muda de lugar são as atividades.
/// Por isso o period é trocado E as posições também: a ordem do array é a
/// ordem em que o dia aparece na tela, então ela precisa continuar
/// casando com os períodos - senão o usuário vê noite antes de tarde.
///
/// Muta os objetos em vez de clonar, de propósito: `lugares` e o mapa de
/// horários são indexados pela IDENTIDADE destes objetos, e um clone
/// perderia os dois.
function trocarDeSlot(atividades, i, j) {
  const p = atividades[i].period;
  atividades[i].period = atividades[j].period;
  atividades[j].period = p;

  const t = atividades[i];
  atividades[i] = atividades[j];
  atividades[j] = t;
}

async function consultarHorarios(placeId, apiKey) {
  const url =
    'https://maps.googleapis.com/maps/api/place/details/json' +
    `?place_id=${encodeURIComponent(placeId)}&fields=opening_hours&key=${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resposta = await fetch(url, { signal: controller.signal });
    if (!resposta.ok) return null;
    const dados = await resposta.json();
    if (dados.status !== 'OK') return null;
    // Ausência de opening_hours é comum e não é fechamento: praça, mirante,
    // praia e ponto de vista não têm horário cadastrado.
    return dados.result?.opening_hours?.periods ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/// Dia da semana (0 = domingo) do dia N da viagem.
/// Devolve null sem data de início - aí não dá para checar horário.
function diaDaSemanaDoDia(dataInicio, numeroDoDia) {
  if (!dataInicio || !Number.isFinite(numeroDoDia)) return null;
  const base = new Date(`${String(dataInicio).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  base.setUTCDate(base.getUTCDate() + (numeroDoDia - 1));
  return base.getUTCDay();
}

/// Extrai o primeiro número de "BRL 1.250,00 por pessoa" -> 1250.
/// Aceita tanto o formato pt (1.250,00) quanto o en (1,250.00).
function valorBrl(texto) {
  if (typeof texto === 'number') return texto;
  if (typeof texto !== 'string') return null;
  const bruto = texto.replace(/[^\d.,]/g, '');
  if (!bruto) return null;
  const normalizado = bruto.includes(',')
    ? bruto.replace(/\./g, '').replace(',', '.')
    : bruto;
  const v = Number.parseFloat(normalizado);
  return Number.isFinite(v) ? v : null;
}

/// Consulta um lugar pelo texto de busca. Devolve sempre um objeto - nunca
/// lança - porque falha de rede não pode derrubar a geração inteira.
async function consultarLugar(textoBusca, apiKey) {
  const url =
    'https://maps.googleapis.com/maps/api/place/textsearch/json' +
    `?query=${encodeURIComponent(textoBusca)}&key=${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const resposta = await fetch(url, { signal: controller.signal });
    if (!resposta.ok) {
      return { veredito: 'erro', motivo: `HTTP ${resposta.status}` };
    }
    const dados = await resposta.json();

    if (dados.status === 'ZERO_RESULTS') {
      // O Google não achou nada com essa string. Pode ser um lugar que não
      // existe (alucinação) ou só uma busca ruim. Não derrubamos a atividade
      // por isso: falso positivo aqui destruiria roteiro bom.
      return { veredito: 'nao_encontrado' };
    }
    if (dados.status !== 'OK') {
      return { veredito: 'erro', motivo: dados.status };
    }

    const primeiro = dados.results?.[0];
    if (!primeiro) return { veredito: 'nao_encontrado' };

    const status = primeiro.business_status;

    // business_status ausente é comum em pontos que não são estabelecimento
    // comercial (praças, mirantes, praias). Ausência não é fechamento.
    if (!status) {
      return { veredito: 'aberto', placeId: primeiro.place_id, semStatus: true };
    }

    return {
      veredito: FECHADO.has(status) ? 'fechado' : 'aberto',
      status,
      placeId: primeiro.place_id,
      nomeGoogle: primeiro.name,
    };
  } catch (erro) {
    return { veredito: 'erro', motivo: erro.name === 'AbortError' ? 'timeout' : erro.message };
  } finally {
    clearTimeout(timer);
  }
}

/// Roda as consultas com um teto de simultaneidade, para não estourar a
/// cota do Google nem abrir 30 conexões de uma vez.
async function emLotes(itens, tamanho, tarefa) {
  const saida = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    const lote = itens.slice(i, i + tamanho);
    saida.push(...(await Promise.all(lote.map(tarefa))));
  }
  return saida;
}

/// Junta todo lugar do roteiro que tem maps_search_query, mantendo a
/// referência ao objeto original para poder alterá-lo depois.
function coletarLugares(roteiro) {
  const lugares = [];
  for (const destino of roteiro?.destinations ?? []) {
    if (destino?.accommodation?.maps_search_query) {
      lugares.push({ tipo: 'hospedagem', obj: destino.accommodation, destino });
    }
    for (const dia of destino?.itinerary ?? []) {
      for (const atividade of dia?.activities ?? []) {
        if (atividade?.maps_search_query) {
          lugares.push({ tipo: 'atividade', obj: atividade, destino, dia });
        }
      }
    }
    for (const backup of destino?.backup_activities ?? []) {
      if (backup?.maps_search_query) {
        lugares.push({ tipo: 'backup', obj: backup, destino });
      }
    }
  }
  return lugares;
}

/**
 * Valida e conserta o roteiro no lugar (muta o objeto recebido).
 *
 * Nunca lança: se o Google estiver fora, devolve o roteiro intacto com o
 * resumo marcando o que não deu para verificar. Roteiro possivelmente
 * desatualizado é ruim; roteiro nenhum é pior.
 *
 * @returns {object} resumo da validação, para log e métrica
 */
async function validarEConsertarRoteiro(roteiro, apiKey, opcoes = {}) {
  const resumo = {
    verificados: 0,
    abertos: 0,
    fechados: 0,
    nao_encontrados: 0,
    erros: 0,
    trocados: 0,
    removidos: 0,
    horarios_verificados: 0,
    fora_do_horario: 0,
    reordenados: 0,
    trocados_por_horario: 0,
    mantidos_fora_do_horario: 0,
    deltaCusto: 0,
    custoAjustado: null,
    detalhes: [],
  };

  if (!apiKey) {
    resumo.detalhes.push('GOOGLE_MAPS_KEY ausente: validação não rodou.');
    return resumo;
  }

  const lugares = coletarLugares(roteiro);
  if (!lugares.length) return resumo;

  // ---- 1. Status de cada lugar ----
  const vereditos = await emLotes(lugares, CONCORRENCIA, (l) =>
    consultarLugar(l.obj.maps_search_query, apiKey),
  );

  lugares.forEach((l, i) => {
    l.veredito = vereditos[i];
    resumo.verificados += 1;
    switch (vereditos[i].veredito) {
      case 'aberto': resumo.abertos += 1; break;
      case 'fechado': resumo.fechados += 1; break;
      case 'nao_encontrado': resumo.nao_encontrados += 1; break;
      default: resumo.erros += 1;
    }
    // place_id resolvido deixa o link do Maps exato em vez de uma busca por
    // texto, e é o insumo da consulta de horário logo abaixo.
    if (vereditos[i].placeId) l.obj.place_id = vereditos[i].placeId;
  });

  // ---- 2. Backup fechado sai antes de qualquer troca ----
  // Oferecer um lugar fechado na troca de atividade seria o mesmo bug em
  // outro lugar, e ele também não pode ser escolhido como substituto.
  for (const destino of roteiro?.destinations ?? []) {
    const antes = (destino.backup_activities ?? []).length;
    destino.backup_activities = (destino.backup_activities ?? []).filter((b) => {
      const r = lugares.find((l) => l.tipo === 'backup' && l.obj === b);
      return !r || r.veredito.veredito !== 'fechado';
    });
    const removidos = antes - destino.backup_activities.length;
    if (removidos > 0) {
      resumo.detalhes.push(
        `${removidos} backup(s) fechado(s) removido(s) em ${destino.city}`,
      );
    }
  }

  // ---- 3. Horários, ANTES de trocar qualquer coisa ----
  //
  // Buscar os horários primeiro é o que impede gastar dois backups num
  // problema só. Na trip 243 aconteceu exatamente isso: a troca por
  // fechamento escolheu o Soya Cantine Bio às cegas, e a checagem de
  // horário logo depois descobriu que ele não abre de manhã e teve que
  // trocar de novo. Dois backups queimados, um problema resolvido.
  const dataInicio = opcoes.dataInicio;
  const diaGlobal = new Map();
  const horarioDe = new Map();

  if (dataInicio) {
    // O campo `day` pode ser global ou reiniciar por destino.
    let offset = 0;
    for (const destino of roteiro?.destinations ?? []) {
      const dias = destino?.itinerary ?? [];
      const reinicia = offset > 0 && Number(dias[0]?.day) === 1;
      for (const dia of dias) {
        const n = Number(dia?.day);
        if (Number.isFinite(n)) diaGlobal.set(dia, reinicia ? offset + n : n);
      }
      offset += dias.length;
    }

    // Hospedagem fica de fora: não tem período, e hotel não se troca aqui.
    const paraHorario = lugares.filter(
      (l) =>
        l.tipo !== 'hospedagem' &&
        l.obj.place_id &&
        l.veredito.veredito !== 'fechado',
    );
    if (paraHorario.length) {
      const horarios = await emLotes(paraHorario, CONCORRENCIA, (l) =>
        consultarHorarios(l.obj.place_id, apiKey),
      );
      paraHorario.forEach((l, i) => horarioDe.set(l.obj, horarios[i]));
      resumo.horarios_verificados = paraHorario.length;
    }
  }

  /// true / false / null (sem dado). null nunca conta como fechado.
  const abreNoPeriodo = (obj, dia, periodoBruto) => {
    const periodo = normalizarPeriodo(periodoBruto);
    const diaSemana = diaDaSemanaDoDia(dataInicio, diaGlobal.get(dia));
    if (!periodo || diaSemana === null || !horarioDe.has(obj)) return null;
    return abreNaJanela(horarioDe.get(obj), diaSemana, JANELAS[periodo]);
  };

  // ---- 4. Uma passada só de conserto ----
  const bancoPorDestino = new Map();
  for (const l of lugares) {
    if (l.tipo !== 'backup') continue;
    if (l.veredito.veredito !== 'aberto') continue;
    if (!(l.destino.backup_activities ?? []).includes(l.obj)) continue;
    if (!bancoPorDestino.has(l.destino)) bancoPorDestino.set(l.destino, []);
    bancoPorDestino.get(l.destino).push(l.obj);
  }

  for (const destino of roteiro?.destinations ?? []) {
    const banco = bancoPorDestino.get(destino) ?? [];
    for (const dia of destino?.itinerary ?? []) {
      const atividades = dia?.activities ?? [];
      // De trás para frente: remover altera os índices seguintes.
      for (let i = atividades.length - 1; i >= 0; i--) {
        const atv = atividades[i];
        const reg = lugares.find((l) => l.tipo === 'atividade' && l.obj === atv);
        if (!reg) continue;

        const fechado = reg.veredito.veredito === 'fechado';
        const foraDoHorario =
          !fechado && abreNoPeriodo(atv, dia, atv.period) === false;
        if (!fechado && !foraDoHorario) continue;
        if (foraDoHorario) resumo.fora_do_horario += 1;

        const rotulo = fechado
          ? `${atv.place} (${reg.veredito.status})`
          : `${atv.place} não abre no período ${atv.period}`;

        // ---- 4a. Antes de gastar backup: dá para reordenar o dia? ----
        //
        // Só vale para período errado. Lugar FECHADO não se reordena: ele
        // não pode ficar no roteiro em período nenhum.
        //
        // Esta é a saída mais barata que existe - nenhuma chamada de API,
        // nenhum token, nenhum lugar novo. E é a que o log da viagem 252
        // pedia: lá o problema nunca foi falta de lugar, foi ordem.
        if (foraDoHorario) {
          const j = acharTrocaDePeriodo(atividades, i, {
            abreNoPeriodo: (obj, periodoBruto) =>
              abreNoPeriodo(obj, dia, periodoBruto),
            elegivel: (obj) => {
              const r = lugares.find(
                (l) => l.tipo === 'atividade' && l.obj === obj,
              );
              return !r || r.veredito.veredito !== 'fechado';
            },
          });

          if (j !== -1) {
            const parceira = atividades[j];
            resumo.detalhes.push(
              `${rotulo} -> reordenado: trocou de slot com ${parceira.place} ` +
              `(${parceira.period})`,
            );
            trocarDeSlot(atividades, i, j);
            resumo.reordenados += 1;
            continue;
          }
        }

        // O substituto precisa passar nos DOIS critérios de uma vez: aberto
        // (já garantido pelo banco) E compatível com o período do slot.
        const idx = banco.findIndex(
          (cand) => abreNoPeriodo(cand, dia, atv.period) !== false,
        );
        const custoSaiu = valorBrl(atv.cost_estimate) ?? 0;

        if (idx === -1) {
          if (fechado) {
            // Lugar fechado não pode ficar de jeito nenhum.
            resumo.detalhes.push(`${rotulo} -> removido, sem backup`);
            atividades.splice(i, 1);
            resumo.removidos += 1;
            resumo.deltaCusto -= custoSaiu;
          } else {
            // Período errado é ruim; buraco no dia é pior. Mas até aqui o
            // usuário recebia o jantar impossível sem aviso nenhum - o
            // problema existia só no log do Cloud Run.
            //
            // Esta flag é o que leva o aviso à tela. É um BOOLEANO, não uma
            // frase: a copy é pt-BR e mora no app, onde a Lais pode trocar
            // sem mexer em backend. E a chave segue o schema do roteiro,
            // que é em inglês.
            atv.hours_mismatch = true;
            resumo.mantidos_fora_do_horario += 1;
            resumo.detalhes.push(
              `${rotulo} -> mantido COM AVISO NA TELA, sem backup nem troca de slot`,
            );
          }
          continue;
        }

        const substituto = banco.splice(idx, 1)[0];
        resumo.detalhes.push(`${rotulo} -> ${substituto.place}`);
        // O período é da agenda, não do lugar.
        atividades[i] = { ...substituto, period: atv.period };
        destino.backup_activities = (destino.backup_activities ?? []).filter(
          (b) => b !== substituto,
        );
        if (fechado) resumo.trocados += 1;
        else resumo.trocados_por_horario += 1;
        resumo.deltaCusto += (valorBrl(substituto.cost_estimate) ?? 0) - custoSaiu;
      }
    }

    // Hospedagem fechada não tem substituto: o banco é de atividade. Vira
    // log; trocar hotel exigiria nova chamada de IA e é decisão de produto.
    const hosp = lugares.find(
      (l) => l.tipo === 'hospedagem' && l.destino === destino,
    );
    if (hosp && hosp.veredito.veredito === 'fechado') {
      resumo.detalhes.push(
        `HOSPEDAGEM FECHADA em ${destino.city}: ${destino.accommodation.name} (${hosp.veredito.status})`,
      );
    }
  }

  // ---- 5. Custo ----
  // O prompt exige que estimated_cost_brl seja a soma exata do
  // cost_breakdown, e esse valor alimenta o controle de orçamento em
  // Minhas Viagens. Ajusta pela diferença em vez de recalcular, para não
  // brigar com passagem, hospedagem e as outras linhas.
  const totalAtual = valorBrl(roteiro?.estimated_cost_brl);
  if (resumo.deltaCusto !== 0 && totalAtual != null) {
    const novo = Math.max(0, Math.round(totalAtual + resumo.deltaCusto));
    roteiro.estimated_cost_brl = novo;
    resumo.custoAjustado = { de: totalAtual, para: novo };

    // A troca mexeu SÓ em atividade, então só a linha de atividades muda.
    // Sem isto o breakdown deixaria de somar o total - e ele existe
    // justamente para o número ser reconciliável pelo usuário.
    const bd = roteiro.cost_breakdown;
    if (bd && typeof bd === 'object' && !Array.isArray(bd)) {
      const atividades = valorBrl(bd.activities_and_tickets);
      if (atividades != null) {
        bd.activities_and_tickets = Math.max(
          0,
          Math.round(atividades + resumo.deltaCusto),
        );
        resumo.custoAjustado.atividades = {
          de: atividades,
          para: bd.activities_and_tickets,
        };
      }
    }
  }

  return resumo;
}

module.exports = {
  validarEConsertarRoteiro,
  consultarLugar,
  // Usado também pelo generate-micro-activity, que recebe este arquivo por
  // um passo de cópia no cloudbuild dele. Este módulo é autocontido
  // (nenhum `require`) de propósito - é o que torna a cópia possível.
  consultarHorarios,
  coletarLugares,
  // Exportados para teste: a lógica de janela é onde mora o risco de falso
  // positivo, e ela precisa ser exercitável sem chamar o Google.
  abreNaJanela,
  normalizarPeriodo,
  diaDaSemanaDoDia,
  JANELAS,
  // A reordenação é pura de propósito: recebe predicados em vez de falar
  // com o Google, e é por isso que dá para exercitar a regra assimétrica
  // (`=== true` para quem se muda, `!== false` para quem cede o slot) sem
  // rede nenhuma.
  acharTrocaDePeriodo,
  trocarDeSlot,
  distanciaEntrePeriodos,
};
