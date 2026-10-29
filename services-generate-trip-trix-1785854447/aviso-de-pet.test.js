// Viagem com pet (29/10): o aviso no cartão de lugar fechado.

const { test } = require('node:test');
const assert = require('node:assert');
const { temPet, marcarAvisoDePet, AVISO } = require('./aviso-de-pet');

function roteiro() {
  return {
    destinations: [{
      city: 'Buenos Aires',
      itinerary: [{
        day: 1,
        activities: [
          { name: 'Don Julio', place_types: ['steak_house', 'restaurant'], logistics: 'Reserve com antecedência.' },
          { name: 'Bosques de Palermo', place_types: ['park'], logistics: 'Vá cedo.' },
          { name: 'MALBA', place_types: ['art_museum', 'museum'] },
          { name: 'Sem tipo', logistics: 'Nada.' },
        ],
      }],
      backup_activities: [{ name: 'Café Tortoni', place_types: ['cafe'], logistics: 'Fila à tarde.' }],
    }],
  };
}

test('o perfil com pet é lido da companhia', () => {
  assert.equal(temPet({ companions: ['Couple', 'Pet'] }), true);
  assert.equal(temPet({ companions: ['Couple'] }), false);
  assert.equal(temPet(null), false);
});

test('lugar fechado ganha o aviso; parque e lugar sem tipo, não', () => {
  const r = roteiro();
  assert.equal(marcarAvisoDePet(r), 3);
  const [restaurante, parque, museu, semTipo] = r.destinations[0].itinerary[0].activities;
  assert.equal(restaurante.logistics, `Reserve com antecedência. ${AVISO.pt}`);
  assert.equal(restaurante.pet_a_confirmar, true);
  assert.equal(parque.logistics, 'Vá cedo.');
  assert.equal(parque.pet_a_confirmar, undefined);
  assert.equal(museu.logistics, AVISO.pt);
  assert.equal(semTipo.pet_a_confirmar, undefined);
  assert.equal(r.destinations[0].backup_activities[0].pet_a_confirmar, true);
});

test('rodar duas vezes não repete a linha', () => {
  const r = roteiro();
  marcarAvisoDePet(r);
  marcarAvisoDePet(r);
  const restaurante = r.destinations[0].itinerary[0].activities[0];
  assert.equal(restaurante.logistics.split(AVISO.pt).length - 1, 1);
});

test('em inglês, o aviso é em inglês', () => {
  const r = roteiro();
  marcarAvisoDePet(r, { en: true });
  assert.match(r.destinations[0].itinerary[0].activities[0].logistics, /With a pet/);
});
