// Compara a busca de lugar da Places API legada com a da nova, nos mesmos
// lugares, antes de ligar PLACES_API_NOVA=1 em produção.
//
// Por que existe: a troca de API barateia o Places (61% do custo era
// campo que ninguém lê, medido em 21/09), mas muda como o nome casa com o
// lugar -- e lugar fechado é o pior bug do produto. Então a regra é medir
// antes: as duas APIs contra os ~60 lugares reais de roteiros recentes em
// `lugares-para-comparar.json`, sem tocar em produção.
//
// Como rodar (na sua máquina, com a mesma chave dos serviços):
//
//   GOOGLE_MAPS_KEY=... node scripts/compara-places.js
//
// A Places API (New) precisa estar habilitada no projeto do GCP da
// chave. Se não estiver, toda consulta nova volta "erro: HTTP 403".
//
// O que olhar no resultado:
//   * "mesmo lugar" perto de 100% -- é o casamento;
//   * nenhuma linha em "a nova diz fechado, a legada não" sem conferir à
//     mão, porque ali a troca mudaria o roteiro de alguém;
//   * "só a legada achou" baixo -- lugar que a nova não acha passa sem
//     validação, como hoje passa o "nao_encontrado".

const path = require('node:path');
const fs = require('node:fs');

const {
  consultarLugarLegado,
  consultarLugarNovo,
} = require('../services-generate-trip-trix-1785854447/validar-lugares');

const chave = process.env.GOOGLE_MAPS_KEY;
if (!chave) {
  console.error('Defina GOOGLE_MAPS_KEY.');
  process.exit(1);
}

const lugares = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'lugares-para-comparar.json'), 'utf8'),
);

async function emLotes(itens, tamanho, tarefa) {
  const saida = [];
  for (let i = 0; i < itens.length; i += tamanho) {
    const lote = itens.slice(i, i + tamanho);
    saida.push(...(await Promise.all(lote.map(tarefa))));
  }
  return saida;
}

(async () => {
  const linhas = await emLotes(lugares, 5, async (l) => {
    const [legada, nova] = await Promise.all([
      consultarLugarLegado(l.busca, chave),
      consultarLugarNovo(l.busca, chave),
    ]);
    return { ...l, legada, nova };
  });

  const conta = (f) => linhas.filter(f).length;
  const total = linhas.length;
  const pct = (n) => `${n} de ${total} (${Math.round((n / total) * 100)}%)`;

  const ambasAcharam = (x) => x.legada.placeId && x.nova.placeId;
  const mesmoLugar = conta((x) => ambasAcharam(x) && x.legada.placeId === x.nova.placeId);
  const lugarDiferente = linhas.filter((x) => ambasAcharam(x) && x.legada.placeId !== x.nova.placeId);
  const soLegada = linhas.filter((x) => x.legada.placeId && !x.nova.placeId);
  const soNova = linhas.filter((x) => !x.legada.placeId && x.nova.placeId);
  const fechouNaNova = linhas.filter((x) => x.nova.veredito === 'fechado' && x.legada.veredito !== 'fechado');
  const fechouNaLegada = linhas.filter((x) => x.legada.veredito === 'fechado' && x.nova.veredito !== 'fechado');
  const errosNova = linhas.filter((x) => x.nova.veredito === 'erro');

  console.log('\n== Comparação Places legada x nova ==\n');
  console.log(`Lugares:                 ${total}`);
  console.log(`Mesmo lugar:             ${pct(mesmoLugar)}`);
  console.log(`Lugar diferente:         ${pct(lugarDiferente.length)}`);
  console.log(`Só a legada achou:       ${pct(soLegada.length)}`);
  console.log(`Só a nova achou:         ${pct(soNova.length)}`);
  console.log(`Nova diz fechado, legada não: ${fechouNaNova.length}`);
  console.log(`Legada diz fechado, nova não: ${fechouNaLegada.length}`);
  console.log(`Erros na nova:           ${errosNova.length}`);

  const listar = (titulo, itens, fmt) => {
    if (!itens.length) return;
    console.log(`\n-- ${titulo} --`);
    for (const x of itens) console.log(`  ${fmt(x)}`);
  };
  listar('Lugar diferente (conferir à mão)', lugarDiferente,
    (x) => `${x.busca}\n      legada: ${x.legada.nomeGoogle ?? x.legada.placeId}\n      nova:   ${x.nova.nomeGoogle ?? x.nova.placeId}`);
  listar('Só a legada achou', soLegada, (x) => x.busca);
  listar('Nova diz fechado, legada não', fechouNaNova, (x) => `${x.busca} (${x.nova.status})`);
  listar('Legada diz fechado, nova não', fechouNaLegada, (x) => `${x.busca} (${x.legada.status})`);
  listar('Erros na nova', errosNova, (x) => `${x.busca}: ${x.nova.motivo}`);
  console.log('');
})();
