// Testes do prompt da geração, montado no backend a partir da row.
//
// `prompt-da-geracao.casos.json` guarda nove entradas e o prompt que este
// serviço monta para cada uma. Até 02/10 o mesmo arquivo vivia no app, e
// lá o `buildGeminiPrompt` do Dart produziu exatamente o mesmo texto nos
// nove -- foi a prova de que a transcrição bateu, antes de o Dart sair.
// Agora os casos são a regressão: mudar o prompt sem regenerá-los falha,
// e regenerar é decisão, não faxina.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  montarPromptDaGeracao,
  ritmoDe,
  dietaryToDb,
  diasEntre,
} = require('./prompt-da-geracao');

const casos = require('./prompt-da-geracao.casos.json');

test('o prompt é o dos casos, que o app confere contra o Dart', () => {
  assert.ok(casos.length >= 9);
  for (const c of casos) {
    assert.strictEqual(montarPromptDaGeracao(c.linha, c.dna), c.esperado, c.nome);
  }
});

test('os dias contam as duas pontas, sem depender do fuso', () => {
  assert.strictEqual(diasEntre('2026-12-01', '2026-12-09'), 9);
  assert.strictEqual(diasEntre('2026-12-01', '2026-12-01'), 1);
  // A virada do horário de verão europeu não come um dia.
  assert.strictEqual(diasEntre('2026-10-20', '2026-10-30'), 11);
});

test('o ritmo aceita canônico, rótulo novo e nome antigo', () => {
  assert.strictEqual(ritmoDe('Balanced').paradas, 3);
  assert.strictEqual(ritmoDe('Turbina ligada').paradas, 5);
  assert.strictEqual(ritmoDe('De boa').paradas, 2);
  assert.strictEqual(ritmoDe(''), null);
  assert.strictEqual(ritmoDe('Lento'), null);
});

test('restrição alimentar vai em inglês, e desconhecida passa intacta', () => {
  assert.deepStrictEqual(dietaryToDb(['Sem glúten', 'Vegan', 'Kosher']), ['Gluten-free', 'Vegan', 'Kosher']);
});

test('as datas provisórias não viram datas fixas', () => {
  const base = casos[0].linha;
  assert.match(montarPromptDaGeracao({ ...base, is_date_set: true }), /These dates are FIXED/);
  assert.match(montarPromptDaGeracao({ ...base, is_date_set: false }), /PLACEHOLDER for duration only/);
  // Sem a coluna, o erro seguro: tratar como aproximada.
  assert.match(montarPromptDaGeracao({ ...base, is_date_set: undefined }), /PLACEHOLDER/);
});

test('o teto é do grupo, e sem teto não se inventa um', () => {
  const base = casos[0].linha;
  assert.match(montarPromptDaGeracao(base), /Total Budget: BRL 16000 for the WHOLE trip, the round trip from home included/);
  assert.match(montarPromptDaGeracao({ ...base, budget_limit: null }), /Total Budget: Not specified/);
});

test('sem origem, a passagem é zero e não se inventa tarifa', () => {
  const base = casos[0].linha;
  assert.match(montarPromptDaGeracao({ ...base, origin_city: '  ' }), /origin city is UNKNOWN, so set this to 0/);
  assert.match(montarPromptDaGeracao(base), /São Paulo to the first city, and the last city back to São Paulo/);
});

test('o handler monta aqui quando a row não traz o prompt, e diz qual veio', () => {
  // Varredura do fonte: o handler cria o cliente do Supabase na importação
  // e não roda sem ele.
  const fonte = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(fonte, /montarPromptDaGeracao\(tripAtual, dono\?\.travel_dna \?\? null\)/);
  assert.match(fonte, /prompt: origemDoPrompt/);
  for (const coluna of ['planned_destinations', 'origin_city', 'is_date_set', 'budget_limit', 'vibe_tags']) {
    assert.match(fonte, new RegExp(coluna), `o select precisa ler ${coluna}`);
  }
});

// =====================================================================
// O que os testes do app conferiam no `buildGeminiPrompt`, e que mudou
// de casa junto com ele (fase B, 02/10). Cada bloco diz de onde veio,
// porque o motivo de produto está no teste de origem.
// =====================================================================

// Uma linha com duas cidades, para o que só aparece da segunda em diante.
const duasCidades = {
  ...casos[0].linha,
  planned_destinations: [
    { destination: 'Lisboa, Portugal', days: 3 },
    { destination: 'Porto, Portugal', days: 3 },
  ],
  start_date: '2026-12-01',
  end_date: '2026-12-06',
};

test('o ritmo promete na tela o mesmo número que o prompt exige', () => {
  // O app escreve na tela "Duas paradas por dia" a partir do
  // `RitmoDaViagem` (`lib/flutter_flow/ritmo_da_viagem.dart`); este
  // serviço manda o modelo cumprir EXATAMENTE o número do `RITMOS`. São
  // duas cópias em dois repositórios, e nenhuma ferramenta compara as
  // duas: o `ritmo_da_viagem_test.dart` do app trava 2/3/5 do lado de lá,
  // este trava do lado de cá. Mexeu num, mexa no outro.
  assert.strictEqual(ritmoDe('Chill').paradas, 2);
  assert.strictEqual(ritmoDe('Balanced').paradas, 3);
  assert.strictEqual(ritmoDe('Action-packed').paradas, 5);
  // Sem ritmo, o do meio -- o `RitmoDaViagem.padrao` do app.
  assert.match(montarPromptDaGeracao({ ...casos[0].linha, pace_level: null }),
    /EXACTLY 3 activities per day/);
});

test('a distribuição pelos períodos soma o número exigido', () => {
  // De `ritmo_da_viagem_test.dart`. O schema só tem três períodos, então
  // cinco paradas obrigam a repetir um; a distribuição sugerida tem de
  // somar o que se exige, senão o modelo recebe duas ordens na mesma
  // frase.
  for (const canonico of ['Chill', 'Balanced', 'Action-packed']) {
    const r = ritmoDe(canonico);
    const d = r.distribuicao;
    const soma = d.includes('in each of the three periods')
      ? Number(d.match(/^(\d+)/)[1]) * 3
      : [...d.matchAll(/(\d+) in /g)].reduce((a, m) => a + Number(m[1]), 0);
    assert.strictEqual(soma, r.paradas, canonico);
    assert.ok(montarPromptDaGeracao({ ...casos[0].linha, pace_level: canonico }).includes(d), canonico);
  }
});

test('com data escolhida, o feriado é regra, e sem ela não é', () => {
  // De `datas_no_prompt_test.dart`: achado do Paulo em 18/09, no item
  // 1.5.1 do QA ("coloquei data no Natal e o Gemini ignorou"). Mandar
  // planejar em volta de feriado sobre data provisória seria trocar um
  // erro por outro pior, por isso os blocos se excluem.
  const fixa = montarPromptDaGeracao({ ...casos[0].linha, is_date_set: true });
  assert.match(fixa, /These dates are FIXED/);
  assert.match(fixa, /public holidays/);
  assert.match(fixa, /local closing days/);
  assert.match(fixa, /A museum shut on 25 December is a ruined day/);
  assert.doesNotMatch(fixa, /PLACEHOLDER/);

  const chute = montarPromptDaGeracao({ ...casos[0].linha, is_date_set: false });
  assert.match(chute, /PLACEHOLDER for duration only/);
  assert.match(chute, /the traveler has NOT chosen dates yet/);
  assert.match(chute, /Do not build the itinerary around a specific week/);
  assert.doesNotMatch(chute, /These dates are FIXED/);
  assert.doesNotMatch(chute, /public holidays/);
});

test('a instrução de data vem colada na linha das datas', () => {
  // Instrução solta no fim do prompt é lida longe do dado a que se refere.
  const p = montarPromptDaGeracao({ ...casos[0].linha, is_date_set: true });
  const datas = p.indexOf('Dates: from');
  const regra = p.indexOf('These dates are FIXED');
  const total = p.indexOf('Total Days:');
  assert.notStrictEqual(datas, -1);
  assert.ok(regra > datas && total > regra);
});

test('o bloco por cidade pede voltagem e transporte, com a regra da cidade', () => {
  // De `concierge_test.dart`. O parser do app pode estar certo e o dado
  // nunca chegar: se o prompt não pede, o modelo não devolve. Salvador e
  // Vitória da Conquista são a prova de que voltagem é dado de cidade.
  const p = montarPromptDaGeracao(casos[0].linha);
  assert.match(p, /"voltage"/);
  assert.match(p, /"transport"/);
  assert.match(p, /Salvador is 127V/);
  assert.match(p, /plug SHAPE only/);
  assert.match(p, /Never name a system the city does not have/);
});

test('o checklist pede as cinco categorias, sem traduzir', () => {
  // De `checklist_da_viagem_test.dart`: a tela traduz a categoria para a
  // etiqueta, então o valor tem de vir sempre em inglês.
  const p = montarPromptDaGeracao(casos[0].linha);
  assert.match(p, /"item_category"/);
  assert.match(p, /documents, bookings, packing, money, health/);
  assert.match(p, /Never translate it\./);
});

test('o traslado entre cidades é pedido, e no idioma do roteiro', () => {
  // De `traslado_entre_cidades_test.dart`. Decisão do Paulo em 28/09:
  // "Não podemos ter um roteiro irreal!" (viagem 226, Salvador num dia e
  // Vitória da Conquista no outro, a ~500 km, sem nada no meio).
  const p = montarPromptDaGeracao(duasCidades);
  assert.match(p, /"arrival_transfer"/);
  assert.match(p, /Every destination AFTER the first MUST carry/);
  assert.match(p, /flight, train, bus, car, ferry/);
  assert.match(p, /The travel happens on the FIRST day of the new destination/);
  assert.match(p, /This cost goes into "local_transport"/);
  // Exemplo em inglês num prompt em português fez o modelo escrever
  // "BRL 20 per person" dentro de um roteiro em pt.
  const i = p.indexOf('"arrival_transfer": {');
  assert.notStrictEqual(i, -1);
  assert.doesNotMatch(p.substring(i, p.indexOf('}', i)), /per person/);
});

test('o nível e o teto do jeito de gastar chegam ao prompt', () => {
  // De `jeito_de_gastar_test.dart`: o teto é do GRUPO, e o nível é o
  // canônico que a row grava.
  const p = montarPromptDaGeracao({ ...casos[0].linha, budget_level: 'Premium', budget_limit: 24000 });
  assert.match(p, /Total Budget: BRL 24000 for the WHOLE trip, the round trip from home included \(Level: Premium\)/);
});
