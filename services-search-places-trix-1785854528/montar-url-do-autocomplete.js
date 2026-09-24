// A URL do Google Places Autocomplete, extraída para ser testável sem
// `require('./index')` -- o `index.js` inicializa o cliente do Supabase
// no escopo do módulo, e isso quebra fora do Cloud Run sem as variáveis
// de ambiente.
//
// `types=(regions)` -- Achado do Paulo em 24/09: alguém pode querer
// viajar para a INDONÉSIA, não necessariamente para Jacarta. Com
// `(cities)` o autocomplete só devolvia `locality`/`administrative_area3`
// -- um país inteiro nunca aparecia como sugestão, só as cidades dele.
// `(regions)` é a coleção de tipos que o Places Autocomplete documenta
// para isto: `locality`, `sublocality`, `postal_code`, `country`,
// `administrative_area_level_1/2` -- cidade continua aparecendo (é
// `locality`), país e estado entram junto.
function montarUrlDoAutocomplete(input, lang, apiKey) {
  return 'https://maps.googleapis.com/maps/api/place/autocomplete/json' +
    `?input=${encodeURIComponent(input)}` +
    '&types=(regions)' +
    `&language=${lang}` +
    `&key=${apiKey}`;
}

module.exports = { montarUrlDoAutocomplete };
