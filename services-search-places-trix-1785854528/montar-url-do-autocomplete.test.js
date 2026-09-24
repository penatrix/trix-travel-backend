// Trava o `types` da URL do Places Autocomplete.
//
// Não é sobre o formato da URL em si -- é sobre não deixar a busca
// voltar a ser só de cidade em silêncio. `(cities)` e `(regions)`
// produzem URL igualmente "válida"; o que quebra é o alcance da busca,
// e isso só o texto do parâmetro denuncia.

const { test } = require('node:test');
const assert = require('node:assert');

const { montarUrlDoAutocomplete } = require('./montar-url-do-autocomplete');

test('pede regiões, não só cidades', () => {
  const url = montarUrlDoAutocomplete('Indonésia', 'pt-BR', 'chave-de-teste');
  assert.ok(url.includes('types=(regions)'),
    'sem isto, buscar um país inteiro nunca sugere o país');
  assert.ok(!url.includes('types=(cities)'),
    'o tipo antigo não pode voltar misturado ao novo');
});

test('o termo digitado vai codificado para a URL', () => {
  const url = montarUrlDoAutocomplete('São Paulo', 'pt-BR', 'chave-de-teste');
  assert.ok(url.includes(encodeURIComponent('São Paulo')));
});

test('idioma e chave vão para os parâmetros certos', () => {
  const url = montarUrlDoAutocomplete('Kyoto', 'en-US', 'chave-123');
  assert.ok(url.includes('language=en-US'));
  assert.ok(url.includes('key=chave-123'));
});
