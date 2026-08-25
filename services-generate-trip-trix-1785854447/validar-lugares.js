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
async function validarEConsertarRoteiro(roteiro, apiKey) {
  const resumo = {
    verificados: 0,
    abertos: 0,
    fechados: 0,
    nao_encontrados: 0,
    erros: 0,
    trocados: 0,
    removidos: 0,
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

module.exports = { validarEConsertarRoteiro, consultarLugar, coletarLugares };
