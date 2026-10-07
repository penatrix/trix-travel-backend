// A regra da foto, sem rede.
//
// O que fica travado aqui é o que decide se uma foto aparece para alguém:
// a ordem dos níveis, a tradução dos nomes e os motivos de recusa. Uma
// foto do lugar errado na tela é pior que o bloco de cor.

const { test } = require('node:test');
const assert = require('node:assert');

const f = require('./foto');

const fotoDe = (extra = {}) => ({
  id: 'abc',
  width: 4000,
  height: 2667,
  color: '#8c6d4f',
  likes: 10,
  description: null,
  alt_description: null,
  slug: '',
  tags: [],
  urls: { regular: 'https://images.unsplash.com/r', small: 'https://images.unsplash.com/s' },
  links: { html: 'https://unsplash.com/photos/abc', download_location: 'https://api.unsplash.com/photos/abc/download' },
  user: { name: 'Ana Souza', links: { html: 'https://unsplash.com/@ana' } },
  ...extra,
});

// =====================================================================
// NÍVEIS
// =====================================================================

test('a cascata é cidade, região, país, nessa ordem', () => {
  const niveis = f.niveisDaBusca({ cidade: 'Sinop', regiao: 'MT', pais: 'Brasil' });
  assert.deepStrictEqual(niveis.map((n) => n.nivel), ['cidade', 'regiao', 'pais']);
  assert.strictEqual(niveis[0].consulta, 'Sinop Brazil');
  assert.strictEqual(niveis[1].consulta, 'Mato Grosso Brazil', 'a sigla do estado vira o nome');
  assert.strictEqual(niveis[2].consulta, 'Brazil');
});

test('nunca desce ao continente', () => {
  const niveis = f.niveisDaBusca({ cidade: 'Óbidos', regiao: '', pais: 'Portugal' });
  assert.ok(!niveis.some((n) => /europe|europa/i.test(n.consulta)));
  assert.strictEqual(niveis.at(-1).nivel, 'pais');
});

test('cidade com nome diferente em inglês busca e confere pelos dois', () => {
  const [cidade] = f.niveisDaBusca({ cidade: 'Lisboa', pais: 'Portugal' });
  assert.strictEqual(cidade.consulta, 'Lisbon Portugal');
  assert.deepStrictEqual(cidade.exigir, ['Lisboa', 'Lisbon']);
});

test('país em português vira o nome em inglês pelo Intl', () => {
  assert.strictEqual(f.paisEmIngles('França').nome, 'France');
  assert.strictEqual(f.paisEmIngles('Estados Unidos').codigo, 'US');
  assert.strictEqual(f.paisEmIngles('EUA').codigo, 'US');
  assert.strictEqual(f.paisEmIngles('Holanda').codigo, 'NL');
  assert.strictEqual(f.paisEmIngles('Narnia'), null);
});

test('sem país conhecido, fica só a cidade', () => {
  const niveis = f.niveisDaBusca({ cidade: 'Lyon', pais: '' });
  assert.deepStrictEqual(niveis.map((n) => n.nivel), ['cidade']);
  assert.strictEqual(niveis[0].consulta, 'Lyon');
});

test('sigla de estado de fora do Brasil não vira busca', () => {
  assert.strictEqual(f.nomeDaRegiao('CA', 'US'), null);
  assert.strictEqual(f.nomeDaRegiao('Toscana', 'IT'), 'Toscana');
});

test('as chaves dos níveis de cima são compartilhadas entre cidades', () => {
  const a = f.niveisDaBusca({ cidade: 'Lyon', pais: 'França' });
  const b = f.niveisDaBusca({ cidade: 'Annecy', pais: 'França' });
  assert.notStrictEqual(a[0].chave, b[0].chave);
  assert.strictEqual(a.at(-1).chave, b.at(-1).chave);
  assert.strictEqual(f.chaveDoDestino({ cidade: 'São Paulo', pais: 'Brasil' }), f.chaveDoDestino({ cidade: 'sao paulo', pais: 'brasil' }));
});

// =====================================================================
// ACEITE
// =====================================================================

test('aceita a foto que menciona o lugar', () => {
  const boa = fotoDe({ description: 'Old town of Lyon at dusk' });
  assert.strictEqual(f.motivoDaRecusa(boa, ['Lyon']), null);
});

test('recusa a foto que não fala do lugar: a busca sempre devolve alguma coisa', () => {
  const qualquer = fotoDe({ description: 'a river in the evening' });
  assert.strictEqual(f.motivoDaRecusa(qualquer, ['Sinop']), 'lugar_errado');
});

test('o nome casa palavra inteira, não pedaço', () => {
  const foto = fotoDe({ description: 'parisian cafe' });
  assert.strictEqual(f.motivoDaRecusa(foto, ['Paris']), 'lugar_errado');
});

test('o nome confere sem acento e em várias fontes do texto', () => {
  assert.strictEqual(f.motivoDaRecusa(fotoDe({ tags: [{ title: 'são paulo' }] }), ['Sao Paulo']), null);
  assert.strictEqual(f.motivoDaRecusa(fotoDe({ slug: 'cuiaba-mato-grosso-xyz' }), ['Cuiabá']), null);
  assert.strictEqual(f.motivoDaRecusa(fotoDe({ location: { city: 'Lisbon' } }), ['Lisboa', 'Lisbon']), null);
});

test('mesmo nome, outro país: Sinop da Turquia não vale para o Mato Grosso', () => {
  const turca = fotoDe({ description: 'Sinop harbour', location: { country: 'Turkey' } });
  assert.strictEqual(f.motivoDaRecusa(turca, ['Sinop'], 'Brasil'), 'outro_pais');
  const daqui = fotoDe({ description: 'Sinop', location: { country: 'Brazil' } });
  assert.strictEqual(f.motivoDaRecusa(daqui, ['Sinop'], 'Brasil'), null);
});

test('recusa foto pequena ou em pé', () => {
  assert.strictEqual(f.motivoDaRecusa(fotoDe({ description: 'Lyon', width: 1200 }), ['Lyon']), 'pequena_ou_vertical');
  assert.strictEqual(f.motivoDaRecusa(fotoDe({ description: 'Lyon', width: 2000, height: 3000 }), ['Lyon']), 'pequena_ou_vertical');
});

test('recusa céu azul saturado, que é a assinatura da concorrência', () => {
  assert.strictEqual(f.ceuAzulSaturado('#3a8fd9'), true);
  assert.strictEqual(f.ceuAzulSaturado('#8c6d4f'), false, 'tom de pedra');
  assert.strictEqual(f.ceuAzulSaturado('#14213d'), false, 'azul escuro, de noite');
  assert.strictEqual(f.ceuAzulSaturado('#c9d3dc'), false, 'céu nublado, dessaturado');
  assert.strictEqual(f.motivoDaRecusa(fotoDe({ description: 'Lyon', color: '#3a8fd9' }), ['Lyon']), 'ceu_azul');
});

test('recusa Unsplash+', () => {
  assert.strictEqual(f.motivoDaRecusa(fotoDe({ description: 'Lyon', premium: true }), ['Lyon']), 'unsplash_plus');
});

test('entre as aceitas, ganha a mais curtida; as recusas são contadas', () => {
  const { foto, recusas } = f.escolherFoto(
    [
      fotoDe({ id: 'a', description: 'Lyon', likes: 5 }),
      fotoDe({ id: 'b', description: 'Lyon', likes: 50 }),
      fotoDe({ id: 'c', description: 'nada' }),
    ],
    ['Lyon'],
  );
  assert.strictEqual(foto.id, 'b');
  assert.deepStrictEqual(recusas, { lugar_errado: 1 });
  assert.strictEqual(f.escolherFoto([], ['Lyon']).foto, null);
});

// =====================================================================
// O QUE SE GUARDA
// =====================================================================

test('a linha guarda a atribuição com o UTM que a licença pede', () => {
  const linha = f.linhaDaFoto({ chave: 'k', tipo: 'destino', nivel: 'cidade', consulta: 'Lyon France', foto: fotoDe() });
  assert.strictEqual(linha.fotografo_nome, 'Ana Souza');
  assert.match(linha.fotografo_url, /utm_source=trix_travel&utm_medium=referral$/);
  assert.match(linha.pagina_url, /utm_source=trix_travel/);
  assert.strictEqual(linha.url_pequena, 'https://images.unsplash.com/s');
});

test('"não há foto" vale 30 dias; foto achada vale para sempre', () => {
  const agora = Date.parse('2026-10-07T12:00:00Z');
  assert.strictEqual(f.linhaAindaVale({ nivel: 'nenhuma', atualizada_em: '2026-09-20T00:00:00Z' }, agora), true);
  assert.strictEqual(f.linhaAindaVale({ nivel: 'nenhuma', atualizada_em: '2026-08-01T00:00:00Z' }, agora), false);
  assert.strictEqual(f.linhaAindaVale({ nivel: 'pais', atualizada_em: '2020-01-01T00:00:00Z' }, agora), true);
  assert.strictEqual(f.linhaAindaVale(undefined, agora), false);
});

test('o app não recebe a linha de "não há foto"', () => {
  assert.strictEqual(f.paraOApp({ nivel: 'nenhuma' }), null);
  assert.strictEqual(f.paraOApp(null), null);
  assert.strictEqual(f.paraOApp({ nivel: 'manual', url: 'u' }).url_pequena, 'u', 'foto escolhida à mão vale');
});

// =====================================================================
// LUGARES
// =====================================================================

test('o lugar confere pela palavra própria do nome, não pela genérica', () => {
  assert.deepStrictEqual(f.nomesDoLugar('Museu do Louvre'), ['louvre']);
  assert.deepStrictEqual(f.nomesDoLugar('Café de Flore'), ['flore']);
  assert.deepStrictEqual(f.nomesDoLugar('Mercado Central'), [], '"central" não identifica mercado nenhum');
});

test('lugar sem palavra própria não é buscado', () => {
  assert.strictEqual(f.buscaDoLugar({ lugar: 'Praça da Sé', cidade: 'São Paulo', pais: 'Brasil' }), null);
  const louvre = f.buscaDoLugar({ lugar: 'Museu do Louvre', cidade: 'Paris', pais: 'França' });
  assert.strictEqual(louvre.consulta, 'Museu do Louvre Paris');
  assert.deepStrictEqual(louvre.exigir, ['louvre']);
});

test('lugar busca com o nome da cidade em inglês', () => {
  const b = f.buscaDoLugar({ lugar: 'Torre de Belém', cidade: 'Lisboa', pais: 'Portugal' });
  assert.strictEqual(b.consulta, 'Torre de Belém Lisbon');
  assert.match(b.chave, /^lugar\|/);
});
