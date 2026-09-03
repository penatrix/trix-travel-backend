// Valida disponibilidade real dos lugares: está aberto, e abre no período?
//
// =====================================================================
// POR QUE ISTO MORA NESTE SERVIÇO
// =====================================================================
//
// Ele já é a coisa que JULGA itens. Julgava só contra a restrição do
// usuário ("isto é uma pizzaria?"); agora julga também contra o Google
// ("isto está aberto? abre à noite?"). É o mesmo trabalho sobre a mesma
// lista, e juntar aqui evita expor um endpoint novo só para isso.
//
// O que estava faltando e motivou: a emenda de roteiro escolhia um backup
// porque ele não conflitava com o pedido, mas ninguém checava se aquele
// backup estava aberto ou se abria no turno do slot. Backups nunca tiveram
// veredito de horário - a validação da geração só os checa quando os usa.
// Então a emenda resolvia a restrição e podia introduzir um lugar fechado,
// que é o pior bug do produto.
//
// =====================================================================
// A CHECAGEM É SEM DATA, DE PROPÓSITO
// =====================================================================
//
// Um backup ainda não sabe em que dia vai cair - ele é candidato a um
// slot, e o slot tem período, não data. Então a pergunta é "abre neste
// período em ALGUM dia?", que é a `abreNoPeriodoEmAlgumDia` do módulo
// compartilhado.
//
// Ela pega o caso comum (o restaurante que só serve almoço num slot de
// jantar) e não pega "fecha às segundas". Assumido: para isso seria
// preciso saber a data, e quem escolhe o slot é o app.

const {
  consultarLugar,
  consultarHorarios,
  abreNoPeriodoEmAlgumDia,
  normalizarPeriodo,
  JANELAS,
} = require('./validar-lugares');

/// Avalia um item. NUNCA lança: falha vira "não deu para verificar", e
/// quem chama decide o que fazer com isso.
///
/// `status` é 'aberto' | 'fechado' | 'nao_encontrado' | 'erro'.
/// `hours_ok` é true / false / null, e **null não é reprovação**: praça,
/// mirante e praia não têm horário cadastrado no Google.
async function avaliarDisponibilidade(item, apiKey) {
  const busca = String(item?.maps_search_query ?? '').trim();

  if (!apiKey || !busca) {
    return { id: item.id, status: 'erro', hours_ok: null, motivo: 'sem chave ou sem busca' };
  }

  const lugar = await consultarLugar(busca, apiKey);

  // Sem place_id não há como pedir horário. Vale para fechado, não
  // encontrado e erro.
  if (lugar.veredito !== 'aberto' || !lugar.placeId) {
    return {
      id: item.id,
      status: lugar.veredito,
      hours_ok: null,
      google_status: lugar.status,
      motivo: lugar.motivo,
    };
  }

  const chave = normalizarPeriodo(item?.period);
  const janela = chave ? JANELAS[chave] : null;

  // Sem período reconhecido, o horário fica sem veredito - e o item
  // continua elegível. Não é reprovação por falta de pergunta.
  const hours_ok = janela
    ? abreNoPeriodoEmAlgumDia(await consultarHorarios(lugar.placeId, apiKey), janela)
    : null;

  return {
    id: item.id,
    status: 'aberto',
    hours_ok,
    place_id: lugar.placeId,
    nome_google: lugar.nomeGoogle,
  };
}

/// Avalia todos os itens que trazem `maps_search_query`, em PARALELO.
///
/// Paralelo é o que torna isto viável: seis backups são doze chamadas ao
/// Google, mas o relógio conta duas idas, não doze. Mesmo desenho da
/// escolha de candidato na troca de atividade.
///
/// Itens sem `maps_search_query` são ignorados de propósito: o app manda
/// esse campo só para os backups, porque as atividades já foram validadas
/// na geração do roteiro. Revalidar tudo dobraria a conta do Google sem
/// responder nada novo.
async function avaliarDisponibilidades(itens, apiKey) {
  const candidatos = (Array.isArray(itens) ? itens : []).filter(
    (i) => i && String(i.maps_search_query ?? '').trim() && String(i.id ?? '').trim(),
  );

  if (candidatos.length === 0) return [];

  return Promise.all(candidatos.map((i) => avaliarDisponibilidade(i, apiKey)));
}

module.exports = { avaliarDisponibilidade, avaliarDisponibilidades };
