// A cidade de uma coordenada: o que entra, o que se pede ao Google e o
// que volta para o app.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  lerCoordenada,
  montarUrlDoReverso,
  cidadeDoResultado,
} = require('./cidade-por-coordenada');

test('coordenada: par de números no globo, arredondado a duas casas', () => {
  assert.deepStrictEqual(lerCoordenada('-23.55052,-46.633308'),
    { lat: -23.55, lng: -46.63 });
  assert.deepStrictEqual(lerCoordenada(' 38.72 , -9.14 '), { lat: 38.72, lng: -9.14 });
  assert.strictEqual(lerCoordenada('91,0'), null);
  assert.strictEqual(lerCoordenada('0,181'), null);
  assert.strictEqual(lerCoordenada('abc,1'), null);
  assert.strictEqual(lerCoordenada('1'), null);
  assert.strictEqual(lerCoordenada(undefined), null);
});

test('a URL pede só cidade, no idioma do app', () => {
  const url = montarUrlDoReverso({ lat: -23.55, lng: -46.63 }, 'pt-BR', 'chave');
  assert.ok(url.startsWith('https://maps.googleapis.com/maps/api/geocode/json'));
  assert.ok(url.includes('latlng=-23.55,-46.63'));
  assert.ok(url.includes('result_type=locality|administrative_area_level_2'));
  assert.ok(url.includes('language=pt-BR'));
  assert.ok(url.includes('key=chave'));
});

const componente = (long_name, short_name, ...types) => ({ long_name, short_name, types });

test('no Brasil: cidade, sigla do estado e país', () => {
  const dados = {
    status: 'OK',
    results: [{
      types: ['locality', 'political'],
      address_components: [
        componente('São Paulo', 'São Paulo', 'locality', 'political'),
        componente('São Paulo', 'SP', 'administrative_area_level_1', 'political'),
        componente('Brasil', 'BR', 'country', 'political'),
      ],
    }],
  };
  assert.deepStrictEqual(cidadeDoResultado(dados),
    { cidade: 'São Paulo', texto: 'São Paulo, SP, Brasil' });
});

test('fora do Brasil: cidade e país', () => {
  const dados = {
    status: 'OK',
    results: [{
      types: ['locality'],
      address_components: [
        componente('Lisboa', 'Lisboa', 'locality'),
        componente('Lisboa', 'Lisboa', 'administrative_area_level_1'),
        componente('Portugal', 'PT', 'country'),
      ],
    }],
  };
  assert.deepStrictEqual(cidadeDoResultado(dados),
    { cidade: 'Lisboa', texto: 'Lisboa, Portugal' });
});

test('sem localidade, vale o município (administrative_area_level_2)', () => {
  const dados = {
    status: 'OK',
    results: [{
      types: ['administrative_area_level_2'],
      address_components: [
        componente('Ilhabela', 'Ilhabela', 'administrative_area_level_2'),
        componente('São Paulo', 'SP', 'administrative_area_level_1'),
        componente('Brasil', 'BR', 'country'),
      ],
    }],
  };
  assert.strictEqual(cidadeDoResultado(dados).texto, 'Ilhabela, SP, Brasil');
});

test('sem resultado, ou erro do Google: nulo', () => {
  assert.strictEqual(cidadeDoResultado({ status: 'ZERO_RESULTS', results: [] }), null);
  assert.strictEqual(cidadeDoResultado({ status: 'REQUEST_DENIED' }), null);
  assert.strictEqual(cidadeDoResultado(null), null);
});
