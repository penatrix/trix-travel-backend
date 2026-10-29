// Viagem com pet (29/10).
//
// Quem marca "Com pet" no Perfil recebeu restaurantes que não aceitam
// animal (feedback de quem testou na família e amigos). O prompt já pedia
// lugares que aceitam pet, e o modelo não tem como saber: ele escreve do
// treinamento, e o Google não diz isso na busca que o roteiro usa.
//
// Então a Trix diz o que sabe e o que não sabe. Em todo lugar fechado
// onde a regra é da casa (restaurante, café, bar, museu, loja), a dica do
// cartão (`logistics`) ganha uma linha: confirme antes se aceita animais.
// Parque, praia e mirante não ganham: ali o animal entra.
//
// A atividade também leva `pet_a_confirmar: true`, para o app poder dar
// destaque depois sem depender do texto. Roda nos lugares do roteiro e
// nos de reserva (`backup_activities`), que podem entrar no lugar de um.

const TIPOS_DE_LUGAR_FECHADO = [
  'restaurant', 'cafe', 'coffee', 'bar', 'pub', 'bakery', 'food', 'meal',
  'wine', 'winery', 'brewery', 'night_club', 'museum', 'gallery',
  'store', 'shopping', 'market', 'spa', 'theater', 'theatre', 'cinema',
];

const AVISO = {
  pt: 'Com pet: confirme antes se o lugar aceita animais.',
  en: 'With a pet: check ahead that the place allows animals.',
};

/** O perfil diz que a pessoa viaja com pet? */
function temPet(travelDna) {
  const lista = travelDna?.companions;
  return Array.isArray(lista) && lista.includes('Pet');
}

function ehLugarFechado(atividade) {
  const tipos = Array.isArray(atividade?.place_types) ? atividade.place_types : [];
  return tipos.some((t) =>
    typeof t === 'string' && TIPOS_DE_LUGAR_FECHADO.some((f) => t.includes(f)));
}

function marcar(atividade, en) {
  if (!atividade || typeof atividade !== 'object') return false;
  if (!ehLugarFechado(atividade)) return false;
  const aviso = en ? AVISO.en : AVISO.pt;
  const dica = typeof atividade.logistics === 'string' ? atividade.logistics.trim() : '';
  if (!dica.includes(aviso)) {
    atividade.logistics = dica ? `${dica} ${aviso}` : aviso;
  }
  atividade.pet_a_confirmar = true;
  return true;
}

/**
 * Marca o roteiro no lugar (muta). Devolve quantos lugares ganharam o
 * aviso. Rodar duas vezes não repete a linha.
 */
function marcarAvisoDePet(roteiro, { en = false } = {}) {
  let marcados = 0;
  for (const destino of roteiro?.destinations ?? []) {
    for (const dia of destino?.itinerary ?? []) {
      for (const atividade of dia?.activities ?? []) {
        if (marcar(atividade, en)) marcados += 1;
      }
    }
    for (const backup of destino?.backup_activities ?? []) {
      if (marcar(backup, en)) marcados += 1;
    }
  }
  return marcados;
}

module.exports = { temPet, marcarAvisoDePet, AVISO };
