// Gera `prompt-da-geracao.casos.json`: entradas e o prompt que este
// serviço monta para cada uma.
//
// Até 02/10 o mesmo arquivo vivia no app, que conferiu o `buildGeminiPrompt`
// do Dart contra ele antes de o Dart sair. Agora é a regressão deste
// serviço: rode `node gerar-casos-da-geracao.js` quando o prompt mudar de
// propósito, e só então.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { montarPromptDaGeracao } = require('./prompt-da-geracao');

// O dia da compra fixo: sem ele o prompt mudaria a cada dia.
const HOJE = '2026-10-26';

const base = {
  start_date: '2026-12-01',
  end_date: '2026-12-09',
  is_date_set: true,
  travelers_count: 2,
  budget_limit: 16000,
  budget_level: 'Comfort',
  pace_level: 'Balanced',
  vibe_tags: 'Wine, Slow travel',
  special_request: '',
  user_language: 'pt',
  origin_city: 'São Paulo',
  planned_destinations: [
    { destination: 'Lisboa, Portugal', days: 5 },
    { destination: 'Porto, Portugal', days: 4 },
  ],
};

const casos = [
  { nome: 'padrão: duas cidades, datas fixas, teto e origem', linha: base, dna: null },
  { nome: 'sem pressa, sem teto, sem origem, em inglês',
    linha: { ...base, pace_level: 'Chill', budget_limit: null, origin_city: null, user_language: 'en' }, dna: null },
  { nome: 'turbina ligada com pedido escrito',
    linha: { ...base, pace_level: 'Action-packed', special_request: 'quero ver aurora boreal' }, dna: null },
  { nome: 'datas provisórias',
    linha: { ...base, is_date_set: false }, dna: null },
  { nome: 'dias não alocados: 9 dias, 5 nas cidades',
    linha: { ...base, planned_destinations: [{ destination: 'Lisboa, Portugal', days: 5 }] }, dna: null },
  { nome: 'ritmo vazio cai em Balanced, nível vazio vira Standard',
    linha: { ...base, pace_level: null, budget_level: null, vibe_tags: '' }, dna: null },
  { nome: 'com Travel DNA, restrição alimentar em português',
    linha: base,
    dna: { likes: ['wine bars', 'old town'], dislikes: ['nightlife'], dietary: ['Sem glúten', 'Vegano'], travel_style: ['slow'] } },
  { nome: 'três cidades, um viajante, 30 dias, ritmo pelo nome antigo',
    linha: { ...base, travelers_count: 1, end_date: '2026-12-30', pace_level: 'Maratonista',
      planned_destinations: [
        { destination: 'Lisboa, Portugal', days: 10 },
        { destination: 'Porto, Portugal', days: 10 },
        { destination: 'Madri, Espanha', days: 10 },
      ] }, dna: null },
  { nome: 'cidade sem dias definidos',
    linha: { ...base, planned_destinations: [{ destination: 'Lisboa, Portugal', days: 0 }, { destination: 'Porto, Portugal', days: 4 }] }, dna: null },
  // As sub-vibes (13/11, `sub-vibes.js`). O handler resolve as chaves de
  // `sub_vibes` em `trix_subvibes` e põe o resultado na linha; aqui ele
  // vem pronto, com as frases do banco em 13/11.
  { nome: 'sub-vibes de gastronomia e esporte, com a trava do esporte',
    linha: { ...base, vibe_tags: 'Gastronomy, Sports',
      sub_vibes: 'comida_de_rua, achados_locais, estadios',
      sub_vibes_resolvidas: [
        { vibe_tag: 'Gastronomy', chave: 'comida_de_rua', ai_prompt: 'street food stalls and food markets', ordem: 2 },
        { vibe_tag: 'Gastronomy', chave: 'achados_locais', ai_prompt: 'little-known places where locals eat, away from the usual tourist lists (still real, established and open)', ordem: 4 },
        { vibe_tag: 'Sports', chave: 'estadios', ai_prompt: 'stadium visits, stadium tours and club museums; never schedule or promise a specific match, game date or ticket', ordem: 1 },
      ] }, dna: null },
  { nome: 'esporte sem sub-vibe: só a trava',
    linha: { ...base, vibe_tags: 'Sports, Wine' }, dna: null },
];

const saida = casos.map((c) => ({ ...c, esperado: montarPromptDaGeracao(c.linha, c.dna, { hoje: HOJE }) }));
fs.writeFileSync(
  path.join(__dirname, 'prompt-da-geracao.casos.json'),
  JSON.stringify(saida, null, 2) + '\n',
);
console.log(`${saida.length} casos escritos.`);
