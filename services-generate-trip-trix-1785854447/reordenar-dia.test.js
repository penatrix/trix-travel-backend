// Testes da reordenação dentro do dia.
//
// A reordenação é pura: recebe predicados em vez de falar com o Google.
// Por isso estes testes não têm dublê de rede nenhum — o que precisa
// ficar travado aqui é a REGRA, não o cliente HTTP.
//
// A regra é deliberadamente assimétrica, e é o ponto todo:
//
//   quem está errado precisa ABRIR no período novo, verificado (=== true)
//   quem cede o slot só não pode QUEBRAR nele          (!== false)
//
// Se alguém "simetrizar" isso por parecer mais limpo, um dos dois lados
// quebra: exigir `true` dos dois mata o caso comum (praça e mirante não
// têm horário cadastrado, então nunca dariam `true`), e aceitar `null` de
// quem se muda troca um problema conhecido por um desconhecido.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  acharTrocaDePeriodo,
  trocarDeSlot,
  distanciaEntrePeriodos,
} = require('./validar-lugares');

/// Um dia como o roteiro traz.
function dia(...pares) {
  return pares.map(([place, period]) => ({ place, period }));
}

/// Monta os predicados a partir de uma tabela "lugar x período -> veredito".
///
/// `tabela` é { "<place>": { manha: true, tarde: false, noite: null } }.
/// Período ausente na tabela do lugar vira null: sem dado.
function predicados(tabela, fechados = []) {
  return {
    abreNoPeriodo: (obj, periodoBruto) => {
      const p = String(periodoBruto ?? '').toLowerCase();
      const chave = p.startsWith('man') ? 'manha' : p.startsWith('tar') ? 'tarde' : 'noite';
      const linha = tabela[obj.place] ?? {};
      return chave in linha ? linha[chave] : null;
    },
    elegivel: (obj) => !fechados.includes(obj.place),
  };
}

// =====================================================================
// O CASO QUE MOTIVOU TUDO
// =====================================================================

test('restaurante de almoço no slot de jantar troca com a atividade de tarde', () => {
  const atividades = dia(['Museu', 'Tarde'], ['Cantina do Almoço', 'Noite']);
  const p = predicados({
    'Cantina do Almoço': { tarde: true, noite: false },
    // Museu sem horário nenhum na tabela: "sem dado" nos dois períodos.
    Museu: {},
  });

  const j = acharTrocaDePeriodo(atividades, 1, p);
  assert.strictEqual(j, 0, 'a parceira é o Museu');
});

test('a troca põe cada atividade no slot da outra, mantendo a ordem do dia', () => {
  const atividades = dia(['Museu', 'Tarde'], ['Cantina do Almoço', 'Noite']);
  trocarDeSlot(atividades, 1, 0);

  // O slot da tarde vem primeiro e agora tem a cantina; o da noite, o museu.
  assert.deepStrictEqual(
    atividades.map((a) => [a.place, a.period]),
    [['Cantina do Almoço', 'Tarde'], ['Museu', 'Noite']],
  );
});

test('a troca preserva a IDENTIDADE dos objetos, não clona', () => {
  // `lugares` e o mapa de horários são indexados pela identidade destes
  // objetos. Um clone perderia os dois, e a validação seguinte iria
  // procurar um horário que não está mais no mapa.
  const museu = { place: 'Museu', period: 'Tarde' };
  const cantina = { place: 'Cantina', period: 'Noite' };
  const atividades = [museu, cantina];

  trocarDeSlot(atividades, 1, 0);

  assert.ok(atividades.includes(museu), 'o museu continua sendo o mesmo objeto');
  assert.ok(atividades.includes(cantina), 'a cantina também');
  assert.strictEqual(cantina.period, 'Tarde');
  assert.strictEqual(museu.period, 'Noite');
});

// =====================================================================
// A REGRA ASSIMÉTRICA
// =====================================================================

test('quem se muda precisa de veredito TRUE: "sem dado" não serve', () => {
  const atividades = dia(['Museu', 'Tarde'], ['Bar', 'Noite']);
  const p = predicados({
    // O bar não abre à noite, e da tarde não se sabe nada. Trocar seria
    // trocar um problema conhecido por um desconhecido.
    Bar: { noite: false },
    Museu: {},
  });

  assert.strictEqual(acharTrocaDePeriodo(atividades, 1, p), -1);
});

test('quem cede o slot passa com "sem dado" — é o caso comum', () => {
  // Praça, mirante e praia não têm opening_hours no Google. Se a regra
  // exigisse `true` deles, a reordenação nunca aconteceria na prática.
  const atividades = dia(['Mirante', 'Manhã'], ['Cantina', 'Noite']);
  const p = predicados({
    Cantina: { manha: true, noite: false },
    Mirante: {},
  });

  assert.strictEqual(acharTrocaDePeriodo(atividades, 1, p), 0);
});

test('quem cede o slot é recusado se QUEBRA nele', () => {
  const atividades = dia(['Balada', 'Noite'], ['Cantina', 'Manhã']);
  const p = predicados({
    Cantina: { manha: false, noite: true },
    // A balada abriria de manhã? Não.
    Balada: { manha: false, noite: true },
  });

  assert.strictEqual(acharTrocaDePeriodo(atividades, 1, p), -1);
});

test('lugar fechado não serve de parceiro', () => {
  // Ele vai ser removido ou substituído logo abaixo na mesma passada.
  // Trocar de slot com ele só mudaria o período do buraco.
  const atividades = dia(['Museu Fechado', 'Tarde'], ['Cantina', 'Noite']);
  const p = predicados(
    { Cantina: { tarde: true, noite: false }, 'Museu Fechado': {} },
    ['Museu Fechado'],
  );

  assert.strictEqual(acharTrocaDePeriodo(atividades, 1, p), -1);
});

test('não troca com quem está no mesmo período', () => {
  const atividades = dia(['Outra Coisa', 'Noite'], ['Cantina', 'Noite']);
  const p = predicados({ Cantina: { noite: false }, 'Outra Coisa': {} });

  assert.strictEqual(acharTrocaDePeriodo(atividades, 1, p), -1);
});

test('período que não reconhecemos não reordena nada', () => {
  const atividades = dia(['Museu', 'Tarde'], ['Cantina', 'Madrugada']);
  const p = predicados({ Cantina: {}, Museu: {} });

  assert.strictEqual(acharTrocaDePeriodo(atividades, 1, p), -1);
});

// =====================================================================
// PREFERÊNCIA PELA TROCA MAIS CURTA
// =====================================================================

test('prefere a troca de menor distância entre períodos', () => {
  // A cantina serve almoço: abre de manhã e de tarde. Duas parceiras
  // possíveis, e a de tarde é a que estranha menos — o texto de logística
  // tem mais chance de continuar valendo.
  const atividades = dia(['Parque', 'Manhã'], ['Museu', 'Tarde'], ['Cantina', 'Noite']);
  const p = predicados({
    Cantina: { manha: true, tarde: true, noite: false },
    Parque: {},
    Museu: {},
  });

  assert.strictEqual(acharTrocaDePeriodo(atividades, 2, p), 1, 'o Museu, da tarde');
});

test('a distância entre períodos é a ordem do dia', () => {
  assert.strictEqual(distanciaEntrePeriodos('Manhã', 'Tarde'), 1);
  assert.strictEqual(distanciaEntrePeriodos('Tarde', 'Noite'), 1);
  assert.strictEqual(distanciaEntrePeriodos('Manhã', 'Noite'), 2);
  assert.strictEqual(distanciaEntrePeriodos('Noite', 'Noite'), 0);
  // Em inglês também: o period vem no idioma do usuário.
  assert.strictEqual(distanciaEntrePeriodos('morning', 'evening'), 2);
  // O que não reconhecemos vai para o fim da fila, nunca é preferido.
  assert.strictEqual(distanciaEntrePeriodos('Madrugada', 'Noite'), 99);
});

// =====================================================================
// DIA DE UMA ATIVIDADE SÓ
// =====================================================================

test('sem parceira possível devolve -1, e aí o aviso na tela é a saída', () => {
  const atividades = dia(['Cantina', 'Noite']);
  const p = predicados({ Cantina: { noite: false } });

  assert.strictEqual(acharTrocaDePeriodo(atividades, 0, p), -1);
});
