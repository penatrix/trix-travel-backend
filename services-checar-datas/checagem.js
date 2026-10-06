// A checagem de datas, na parte que não fala com ninguém.
//
// =====================================================================
// O QUE ELA FAZ
// =====================================================================
//
// Quando a pessoa escolhe (ou muda) a data de um roteiro pronto, cada
// dia do roteiro passa a ter um dia da semana de verdade. Esta é a
// conferência que a geração não podia fazer: museu que fecha às
// segundas, restaurante que não abre no domingo, e o que fecha no
// feriado.
//
// O conserto vai do mais barato para o mais caro, como na geração:
//
//   1. reordenar dentro do dia (nenhuma chamada, nenhum lugar novo);
//   2. trocar por um backup da cidade que abre naquele dia;
//   3. trocar pelo Pro, o mesmo motor da troca de atividade, sabendo o
//      dia -- até `MAX_TROCAS_PELA_IA` por checagem (decisão do Paulo,
//      06/10), porque cada uma é uma chamada Pro de 15 a 40 s;
//   4. se nada servir, a atividade fica com o aviso de horário
//      (`hours_mismatch`), que a tela já mostra.
//
// O passo 3 é do handler, que fala com o modelo: aqui ele só vira
// `pendentes`.
//
// =====================================================================
// O NÚMERO DO DIA
// =====================================================================
//
// É a POSIÇÃO do dia no roteiro achatado (destino a destino, 1-based),
// como o app conta (`dias_achatados.dart`) -- e não o campo `day` do
// modelo, que às vezes reinicia por cidade. O dia 1 cai na data de
// chegada que a pessoa escolheu; o app escreve a mesma conta em
// `dataDoDia`.
// =====================================================================

const {
  abreNaJanela,
  acharTrocaDePeriodo,
  trocarDeSlot,
  normalizarPeriodo,
  valorBrl,
  JANELAS,
  CAMPO_HORARIOS,
} = require('./validar-lugares');

const MAX_TROCAS_PELA_IA = 3;

/// A marca que liga um objeto do roteiro à resposta do Flash. Vive só
/// durante a checagem: sai antes de o roteiro voltar ao app.
const MARCA = '__checagem';

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

// =====================================================================
// ENTRADA
// =====================================================================

/// O corpo, conferido. `null` quando falta o roteiro ou a data.
function limparEntrada(corpo) {
  const c = corpo || {};
  const tripId = Number(c.trip_id);
  if (!Number.isInteger(tripId) || tripId <= 0) return null;
  const dataInicio = dataValida(c.data_inicio);
  if (!dataInicio) return null;
  return { tripId, dataInicio, idioma: c.idioma === 'en' ? 'en' : 'pt' };
}

/// "2026-12-24" se for uma data de calendário de verdade; senão null.
/// "2026-02-30" não passa: `Date` a empurraria para março em silêncio.
function dataValida(texto) {
  const m = DATA_ISO.exec(String(texto ?? '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 ||
      d.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return m[0];
}

// =====================================================================
// O CALENDÁRIO DO ROTEIRO
// =====================================================================

/// O roteiro como mapa. Aceita jsonb (objeto) ou texto; lixo vira null.
function lerRoteiro(json) {
  let valor = json;
  if (typeof valor === 'string') {
    try {
      valor = JSON.parse(valor);
    } catch (_) {
      return null;
    }
  }
  if (!valor || typeof valor !== 'object' || Array.isArray(valor)) return null;
  if (!Array.isArray(valor.destinations) || valor.destinations.length === 0) return null;
  return valor;
}

/// Os dias do roteiro em ordem, com o número contado por posição.
function achatarDias(roteiro) {
  const dias = [];
  for (const destino of roteiro?.destinations ?? []) {
    for (const dia of destino?.itinerary ?? []) {
      if (!dia || typeof dia !== 'object') continue;
      dias.push({ destino, dia, numero: dias.length + 1 });
    }
  }
  return dias;
}

/// A data do dia N, contando a partir da chegada (dia 1).
function dataDoDia(dataInicio, numero) {
  const m = DATA_ISO.exec(dataInicio);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + numero - 1));
  return d.toISOString().slice(0, 10);
}

/// 0 = domingo, como o Places.
function diaDaSemanaDe(dataIso) {
  return new Date(`${dataIso}T12:00:00Z`).getUTCDay();
}

/// Toda atividade e todo backup do roteiro, cada um com o destino.
function lugaresDoRoteiro(roteiro) {
  const lugares = [];
  for (const destino of roteiro?.destinations ?? []) {
    for (const dia of destino?.itinerary ?? []) {
      for (const a of dia?.activities ?? []) {
        if (a && typeof a === 'object') lugares.push({ tipo: 'atividade', obj: a, destino });
      }
    }
    for (const b of destino?.backup_activities ?? []) {
      if (b && typeof b === 'object') lugares.push({ tipo: 'backup', obj: b, destino });
    }
  }
  return lugares;
}

/// Dá a cada atividade e backup uma marca curta ("a1", "b1"), que é o
/// que o Flash recebe no lugar do objeto. A marca sobrevive à cópia
/// profunda, e é por isso que ela mora DENTRO do objeto.
function marcarLugares(roteiro) {
  let a = 0;
  let b = 0;
  for (const l of lugaresDoRoteiro(roteiro)) {
    l.obj[MARCA] = l.tipo === 'atividade' ? `a${++a}` : `b${++b}`;
  }
}

/// Tira a marca de tudo, inclusive do que mudou de lista no caminho.
function desmarcarLugares(roteiro) {
  for (const l of lugaresDoRoteiro(roteiro)) delete l.obj[MARCA];
}

// =====================================================================
// A CONFERÊNCIA DE UM DIA
// =====================================================================

/// O que há de errado com o lugar naquela data, ou null.
///
///   feriado         -- o Flash disse que fecha no feriado daquele dia;
///   fechado_no_dia  -- o Google diz que não abre naquele dia da semana;
///   fora_do_horario -- abre naquele dia, mas não naquele período.
///
/// Sem horário guardado, ou sem período reconhecível, não há problema:
/// ausência de dado nunca conta como fechado.
function problemaDoLugar(obj, data, feriadoDe) {
  const feriado = feriadoDe(obj, data);
  if (feriado) return { motivo: 'feriado', feriado };

  const periodo = normalizarPeriodo(obj?.period);
  if (!periodo) return null;
  const horarios = obj?.[CAMPO_HORARIOS];
  const diaSemana = diaDaSemanaDe(data);
  if (abreNaJanela(horarios, diaSemana, JANELAS[periodo]) !== false) return null;

  const abreNoDia = Object.values(JANELAS).some(
    (janela) => abreNaJanela(horarios, diaSemana, janela) === true,
  );
  return { motivo: abreNoDia ? 'fora_do_horario' : 'fechado_no_dia' };
}

/// O lugar abre naquele período, naquela data? true / false / null.
function abreNoPeriodoDaData(obj, periodoBruto, data, feriadoDe) {
  if (feriadoDe(obj, data)) return false;
  const periodo = normalizarPeriodo(periodoBruto);
  if (!periodo) return null;
  return abreNaJanela(obj?.[CAMPO_HORARIOS], diaDaSemanaDe(data), JANELAS[periodo]);
}

/// A atividade que sai volta para o banco da cidade. Ela não serve
/// NAQUELE dia, mas pode servir em outro -- e, se a pessoa mudar a data
/// de novo, é dela que o conserto vai precisar.
function devolverAoBanco(destino, atividade) {
  const saiu = { ...atividade };
  delete saiu.period;
  delete saiu.hours_mismatch;
  delete saiu.reserved;
  if (!Array.isArray(destino.backup_activities)) destino.backup_activities = [];
  destino.backup_activities.push(saiu);
}

/// O que entra no lugar de outra atividade: herda o período do slot, e
/// não carrega aviso nem marca de reserva de quem saiu.
function entrarNoSlot(nova, periodo) {
  const atividade = { ...nova, period: periodo };
  delete atividade.hours_mismatch;
  delete atividade.reserved;
  return atividade;
}

function diferencaDeCusto(entrou, saiu) {
  return (valorBrl(entrou?.cost_estimate) ?? 0) - (valorBrl(saiu?.cost_estimate) ?? 0);
}

/**
 * Confere o roteiro inteiro contra a data de chegada. Muta o roteiro.
 *
 * `feriadoDe(obj, data)` devolve o nome do feriado em que o lugar fecha
 * naquela data, ou null.
 *
 * Com `consertar: false`, só marca o aviso nas atividades com problema,
 * sem mexer em nada: é a versão que o "Desfazer" do app aplica, com as
 * datas novas e as atividades como estavam.
 *
 * @returns {{ mudancas: object[], pendentes: object[], deltaCusto: number }}
 */
function aplicarChecagem(roteiro, {
  dataInicio,
  feriadoDe = () => null,
  consertar = true,
  maxPelaIa = MAX_TROCAS_PELA_IA,
}) {
  const mudancas = [];
  const pendentes = [];
  const reservadosParaIa = new Set();
  let deltaCusto = 0;

  // O aviso antigo foi calculado contra outra data (ou contra a data
  // provisória da geração). Recomeça do zero.
  for (const l of lugaresDoRoteiro(roteiro)) delete l.obj.hours_mismatch;

  for (const { destino, dia, numero } of achatarDias(roteiro)) {
    const data = dataDoDia(dataInicio, numero);
    const atividades = Array.isArray(dia.activities) ? dia.activities : [];

    for (let i = 0; i < atividades.length; i += 1) {
      const atv = atividades[i];
      if (!atv || typeof atv !== 'object' || reservadosParaIa.has(atv)) continue;
      const problema = problemaDoLugar(atv, data, feriadoDe);
      if (!problema) continue;

      const base = {
        dia: numero,
        data,
        cidade: destino.city ?? null,
        lugar: atv.place ?? null,
        periodo: atv.period ?? null,
        motivo: problema.motivo,
        feriado: problema.feriado ?? null,
      };

      if (!consertar) {
        atv.hours_mismatch = true;
        continue;
      }

      // ---- 1. Reordenar dentro do dia ----
      // Só serve para "abre, mas em outro período". Quem não abre no
      // dia, ou fecha no feriado, não melhora trocando de turno.
      if (problema.motivo === 'fora_do_horario') {
        const j = acharTrocaDePeriodo(atividades, i, {
          abreNoPeriodo: (obj, periodo) => abreNoPeriodoDaData(obj, periodo, data, feriadoDe),
          elegivel: (obj) => !reservadosParaIa.has(obj) && !feriadoDe(obj, data),
        });
        if (j !== -1) {
          const parceira = atividades[j];
          trocarDeSlot(atividades, i, j);
          mudancas.push({
            ...base,
            tipo: 'reordenado',
            periodo_novo: atv.period,
            parceira: parceira.place ?? null,
          });
          continue;
        }
      }

      // ---- 2. Um backup da cidade que abre naquele dia ----
      // Primeiro quem o Google confirma aberto; depois quem não tem
      // horário cadastrado (praça, mirante), como na geração.
      const banco = Array.isArray(destino.backup_activities) ? destino.backup_activities : [];
      let escolhido = -1;
      for (const aceita of [(r) => r === true, (r) => r === null]) {
        escolhido = banco.findIndex(
          (b) => b && typeof b === 'object' &&
            aceita(abreNoPeriodoDaData(b, atv.period, data, feriadoDe)),
        );
        if (escolhido !== -1) break;
      }
      if (escolhido !== -1) {
        const backup = banco.splice(escolhido, 1)[0];
        const nova = entrarNoSlot(backup, atv.period);
        atividades[i] = nova;
        devolverAoBanco(destino, atv);
        deltaCusto += diferencaDeCusto(nova, atv);
        mudancas.push({ ...base, tipo: 'backup', lugar_novo: nova.place ?? null });
        continue;
      }

      // ---- 3. O Pro, até o teto ----
      if (pendentes.length < maxPelaIa) {
        reservadosParaIa.add(atv);
        pendentes.push({
          ...base,
          atividade: atv,
          diaDoRoteiro: dia,
          destino,
          diaDaSemana: diaDaSemanaDe(data),
        });
        continue;
      }

      // ---- 4. Aviso ----
      atv.hours_mismatch = true;
      mudancas.push({ ...base, tipo: 'aviso' });
    }
  }

  return { mudancas, pendentes, deltaCusto };
}

/// O que o Pro trouxe entra no slot da pendente. Devolve a mudança e a
/// diferença de custo, ou null se o slot já não existe.
function aplicarTrocaDaIa(pendente, nova) {
  const atividades = pendente.diaDoRoteiro.activities ?? [];
  const i = atividades.indexOf(pendente.atividade);
  if (i === -1) return null;
  const entrou = entrarNoSlot(nova, pendente.atividade.period);
  atividades[i] = entrou;
  devolverAoBanco(pendente.destino, pendente.atividade);
  return {
    mudanca: { ...resumoDaPendente(pendente), tipo: 'ia', lugar_novo: entrou.place ?? null },
    deltaCusto: diferencaDeCusto(entrou, pendente.atividade),
  };
}

/// O Pro não trouxe nada que sirva: a atividade fica, com o aviso.
function marcarAviso(pendente) {
  pendente.atividade.hours_mismatch = true;
  return { ...resumoDaPendente(pendente), tipo: 'aviso' };
}

function resumoDaPendente(p) {
  const { dia, data, cidade, lugar, periodo, motivo, feriado } = p;
  return { dia, data, cidade, lugar, periodo, motivo, feriado };
}

/// O pedido que vai no prompt da troca, para o Pro saber POR QUE está
/// trocando e o que o substituto precisa cumprir. A checagem do Google
/// confere o dia da semana; o feriado, só o modelo sabe evitar.
function pedidoParaIa(p, idioma = 'pt') {
  const nomes = idioma === 'pt'
    ? ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
    : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dia = nomes[p.diaDaSemana];
  if (idioma === 'pt') {
    const porque = p.motivo === 'feriado'
      ? `fecha no feriado (${p.feriado})`
      : p.motivo === 'fechado_no_dia'
        ? 'não abre nesse dia da semana'
        : 'não abre nesse período';
    return `Substituto para ${p.lugar}, que ${porque}. Precisa estar aberto na ${dia}, ${p.data}, no período ${p.periodo}` +
      (p.feriado ? `, que é feriado (${p.feriado})` : '') + '.';
  }
  const why = p.motivo === 'feriado'
    ? `closes on the holiday (${p.feriado})`
    : p.motivo === 'fechado_no_dia'
      ? 'is closed on that weekday'
      : 'is not open in that period';
  return `Replacement for ${p.lugar}, which ${why}. It must be open on ${dia}, ${p.data}, in the ${p.periodo}` +
    (p.feriado ? `, a public holiday (${p.feriado})` : '') + '.';
}

/// Todo nome de lugar do roteiro e do banco, para o Pro não repetir.
function lugaresParaEvitar(roteiro) {
  return [...new Set(
    lugaresDoRoteiro(roteiro).map((l) => l.obj.place).filter((p) => typeof p === 'string' && p.trim()),
  )];
}

/// Ajusta o total e a linha de atividades pela diferença, como a
/// geração faz: sem isto o `cost_breakdown` deixaria de somar o total.
function ajustarCusto(roteiro, delta) {
  if (!delta) return;
  const total = valorBrl(roteiro?.estimated_cost_brl);
  if (total == null) return;
  roteiro.estimated_cost_brl = Math.max(0, Math.round(total + delta));
  const bd = roteiro.cost_breakdown;
  if (bd && typeof bd === 'object' && !Array.isArray(bd)) {
    const atividades = valorBrl(bd.activities_and_tickets);
    if (atividades != null) {
      bd.activities_and_tickets = Math.max(0, Math.round(atividades + delta));
    }
  }
}

/// A ordem em que a folha do app lista: dia a dia.
function ordenarMudancas(mudancas) {
  return [...mudancas].sort((a, b) => a.dia - b.dia);
}

module.exports = {
  limparEntrada,
  dataValida,
  lerRoteiro,
  achatarDias,
  dataDoDia,
  diaDaSemanaDe,
  lugaresDoRoteiro,
  marcarLugares,
  desmarcarLugares,
  problemaDoLugar,
  aplicarChecagem,
  aplicarTrocaDaIa,
  marcarAviso,
  pedidoParaIa,
  lugaresParaEvitar,
  ajustarCusto,
  ordenarMudancas,
  MAX_TROCAS_PELA_IA,
  MARCA,
};
