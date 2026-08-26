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
    trocados_por_horario: 0,
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

  const vereditos = await emLotes(lugares, CONCORRENCIA, (lugar) =>
    consultarLugar(lugar.obj.maps_search_query, apiKey),
  );

  lugares.forEach((lugar, i) => {
    lugar.veredito = vereditos[i];
    resumo.verificados += 1;
    switch (vereditos[i].veredito) {
      case 'aberto': resumo.abertos += 1; break;
      case 'fechado': resumo.fechados += 1; break;
      case 'nao_encontrado': resumo.nao_encontrados += 1; break;
      default: resumo.erros += 1;
    }
    // place_id resolvido deixa o link do Maps exato em vez de uma busca por
    // texto. Continua sendo o Google quem geolocaliza, não o modelo.
    if (vereditos[i].placeId) {
      lugar.obj.place_id = vereditos[i].placeId;
    }
  });

  // Banco de substitutos por destino: só backups confirmados abertos.
  const bancoPorDestino = new Map();
  for (const lugar of lugares) {
    if (lugar.tipo !== 'backup') continue;
    if (lugar.veredito.veredito !== 'aberto') continue;
    if (!bancoPorDestino.has(lugar.destino)) bancoPorDestino.set(lugar.destino, []);
    bancoPorDestino.get(lugar.destino).push(lugar.obj);
  }

  // Troca as atividades fechadas. Percorre de trás para frente porque
  // remover altera os índices seguintes.
  for (const destino of roteiro?.destinations ?? []) {
    const banco = bancoPorDestino.get(destino) ?? [];
    for (const dia of destino?.itinerary ?? []) {
      const atividades = dia?.activities ?? [];
      for (let i = atividades.length - 1; i >= 0; i--) {
        const registro = lugares.find(
          (l) => l.tipo === 'atividade' && l.obj === atividades[i],
        );
        if (!registro || registro.veredito.veredito !== 'fechado') continue;

        const custoSaiu = valorBrl(atividades[i].cost_estimate) ?? 0;
        const substituto = banco.shift();
        if (substituto) {
          resumo.detalhes.push(
            `${atividades[i].place} (${registro.veredito.status}) -> ${substituto.place}`,
          );
          // O período é da agenda, não do lugar: o substituto herda o horário
          // do que saiu, senão o dia perde a estrutura manhã/tarde/noite.
          atividades[i] = { ...substituto, period: atividades[i].period };
          // Sai do banco de backup para não aparecer duas vezes no roteiro.
          destino.backup_activities = (destino.backup_activities ?? []).filter(
            (b) => b !== substituto,
          );
          resumo.trocados += 1;
          resumo.deltaCusto += (valorBrl(substituto.cost_estimate) ?? 0) - custoSaiu;
        } else {
          resumo.detalhes.push(
            `${atividades[i].place} (${registro.veredito.status}) -> removido, sem backup`,
          );
          atividades.splice(i, 1);
          resumo.removidos += 1;
          resumo.deltaCusto -= custoSaiu;
        }
      }
    }

    // Hospedagem fechada não tem substituto no banco - o backup é de
    // atividade, não de hotel. Marcamos para o log; trocar hotel exigiria
    // uma nova chamada de IA e é decisão de produto.
    const hosp = lugares.find(
      (l) => l.tipo === 'hospedagem' && l.destino === destino,
    );
    if (hosp && hosp.veredito.veredito === 'fechado') {
      resumo.detalhes.push(
        `HOSPEDAGEM FECHADA em ${destino.city}: ${destino.accommodation.name} (${hosp.veredito.status})`,
      );
    }

    // Backups fechados saem do roteiro: eles existem para serem oferecidos
    // ao usuário na troca de atividade, e oferecer um lugar fechado ali é o
    // mesmo bug num lugar diferente.
    const antes = (destino.backup_activities ?? []).length;
    destino.backup_activities = (destino.backup_activities ?? []).filter((b) => {
      const r = lugares.find((l) => l.tipo === 'backup' && l.obj === b);
      return !r || r.veredito.veredito !== 'fechado';
    });
    const removidosBackup = antes - destino.backup_activities.length;
    if (removidosBackup > 0) {
      resumo.detalhes.push(
        `${removidosBackup} backup(s) fechado(s) removido(s) em ${destino.city}`,
      );
    }
  }

  // =====================================================================
  // SEGUNDA PASSADA: horário de funcionamento
  //
  // Status pega o que fechou de vez; isto pega o museu que não abre segunda
  // e o restaurante que só serve jantar. Só roda com a data de início da
  // viagem: sem ela não dá para saber o dia da semana de cada dia.
  //
  // Só age quando o Google diz com certeza que NÃO abre na janela. Sem
  // horário cadastrado (praça, mirante, praia) não é fechamento, e falso
  // positivo aqui estragaria roteiro bom.
  // =====================================================================
  const dataInicio = opcoes.dataInicio;
  if (dataInicio) {
    const destinos = roteiro?.destinations ?? [];

    // O campo `day` pode ser global (1..N na viagem toda) ou reiniciar a
    // cada destino. Detecta pelo primeiro dia de cada um.
    let offset = 0;
    const diaGlobal = new Map();
    for (const destino of destinos) {
      const dias = destino?.itinerary ?? [];
      const reinicia = offset > 0 && Number(dias[0]?.day) === 1;
      for (const dia of dias) {
        const n = Number(dia?.day);
        if (Number.isFinite(n)) diaGlobal.set(dia, reinicia ? offset + n : n);
      }
      offset += dias.length;
    }

    const paraHorario = [];
    for (const destino of destinos) {
      for (const dia of destino?.itinerary ?? []) {
        for (const a of dia?.activities ?? []) {
          if (a?.place_id && normalizarPeriodo(a.period)) {
            paraHorario.push({ tipo: 'atividade', obj: a, destino, dia });
          }
        }
      }
      for (const b of destino?.backup_activities ?? []) {
        if (b?.place_id) paraHorario.push({ tipo: 'backup', obj: b, destino });
      }
    }

    if (paraHorario.length) {
      const horarios = await emLotes(paraHorario, CONCORRENCIA, (it) =>
        consultarHorarios(it.obj.place_id, apiKey),
      );
      paraHorario.forEach((it, i) => {
        it.periods = horarios[i];
      });
      resumo.horarios_verificados = paraHorario.length;

      for (const destino of destinos) {
        const banco = bancoPorDestino.get(destino) ?? [];
        for (const dia of destino?.itinerary ?? []) {
          const atividades = dia?.activities ?? [];
          for (let i = 0; i < atividades.length; i++) {
            const reg = paraHorario.find(
              (h) => h.tipo === 'atividade' && h.obj === atividades[i],
            );
            if (!reg) continue;

            const periodo = normalizarPeriodo(atividades[i].period);
            const diaSemana = diaDaSemanaDoDia(dataInicio, diaGlobal.get(dia));
            if (!periodo || diaSemana === null) continue;

            // true (abre) ou null (sem dado) não mexem em nada.
            if (abreNaJanela(reg.periods, diaSemana, JANELAS[periodo]) !== false) {
              continue;
            }
            resumo.fora_do_horario += 1;

            // O substituto precisa abrir na MESMA janela. Aceita quem não
            // tem horário cadastrado; recusa só quem sabidamente não abre.
            const idx = banco.findIndex((cand) => {
              const rc = paraHorario.find(
                (h) => h.tipo === 'backup' && h.obj === cand,
              );
              return (
                abreNaJanela(rc?.periods, diaSemana, JANELAS[periodo]) !== false
              );
            });

            if (idx === -1) {
              resumo.detalhes.push(
                `${atividades[i].place} não abre no período ${atividades[i].period} -> mantido, sem backup compatível`,
              );
              continue;
            }

            const substituto = banco.splice(idx, 1)[0];
            const custoSaiu = valorBrl(atividades[i].cost_estimate) ?? 0;
            resumo.detalhes.push(
              `${atividades[i].place} não abre no período ${atividades[i].period} -> ${substituto.place}`,
            );
            atividades[i] = { ...substituto, period: atividades[i].period };
            destino.backup_activities = (destino.backup_activities ?? []).filter(
              (b) => b !== substituto,
            );
            resumo.trocados_por_horario += 1;
            resumo.deltaCusto +=
              (valorBrl(substituto.cost_estimate) ?? 0) - custoSaiu;
          }
        }
      }
    }
  }

  // O prompt exige que estimated_cost_brl seja a soma exata dos custos. Se
  // trocamos ou removemos atividade, ele deixou de ser - e o valor alimenta
  // o controle de orçamento em Minhas Viagens. Ajusta pela diferença em vez
  // de recalcular tudo, para não brigar com o que o modelo somou de
  // hospedagem.
  const totalAtual = valorBrl(roteiro?.estimated_cost_brl);
  if (resumo.deltaCusto !== 0 && totalAtual != null) {
    const novo = Math.max(0, Math.round(totalAtual + resumo.deltaCusto));
    roteiro.estimated_cost_brl = novo;
    resumo.custoAjustado = { de: totalAtual, para: novo };
  }

  return resumo;
}

module.exports = {
  validarEConsertarRoteiro,
  consultarLugar,
  coletarLugares,
  // Exportados para teste: a lógica de janela é onde mora o risco de falso
  // positivo, e ela precisa ser exercitável sem chamar o Google.
  abreNaJanela,
  normalizarPeriodo,
  diaDaSemanaDoDia,
  JANELAS,
};
