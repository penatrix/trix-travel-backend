// A parte pura da foto do destino: de onde buscar, o que aceitar e o
// que guardar. Nada aqui toca a rede -- o `index.js` faz as chamadas e
// passa as respostas para cá.
//
// **A regra (decisão do Paulo, 07/10).** Tenta ser específico e, se não
// houver foto boa, sobe um nível: cidade, depois região, depois país.
// Para no país: uma foto de "Europa" para uma cidade do interior de
// Portugal mostraria outro país, e isso parece erro, não fallback. Sem
// foto em nenhum nível, a tela usa o bloco de cor da marca.
//
// **"Não ter foto" é uma regra, não a busca voltar vazia.** O Unsplash
// quase sempre devolve alguma coisa: para uma cidade pequena do Mato
// Grosso ele devolve uma foto qualquer, às vezes de outro país. Por
// isso uma foto só é aceita num nível quando o nome do lugar daquele
// nível aparece no texto dela (descrição, tags, slug, localização), e
// quando ela passa no padrão da marca.

/// Sem acento, minúsculo, um espaço só. É como os nomes se comparam.
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// =====================================================================
// NOMES EM INGLÊS
//
// O texto das fotos do Unsplash é quase todo em inglês, e o app guarda os
// nomes em português. Sem tradução, "Lisboa" nunca casaria com "Lisbon"
// e toda cidade com nome diferente em inglês cairia para o país.
// =====================================================================

/// País em português (ou inglês) para o código ISO. Montado a partir do
/// próprio Intl, para não manter uma tabela de 250 países à mão.
const CODIGO_DO_PAIS = (() => {
  const mapa = new Map();
  const pt = new Intl.DisplayNames(['pt-BR'], { type: 'region' });
  const en = new Intl.DisplayNames(['en'], { type: 'region' });
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of letras) {
    for (const b of letras) {
      const codigo = a + b;
      let nomePt;
      let nomeEn;
      try {
        nomePt = pt.of(codigo);
        nomeEn = en.of(codigo);
      } catch {
        continue;
      }
      // Código sem nome devolve o próprio código: não é país.
      if (!nomePt || nomePt === codigo) continue;
      mapa.set(normalizar(nomePt), codigo);
      mapa.set(normalizar(nomeEn), codigo);
    }
  }
  // Os jeitos de escrever que o Intl não cobre e que aparecem nos
  // roteiros.
  const apelidos = {
    eua: 'US', usa: 'US', 'estados unidos da america': 'US',
    inglaterra: 'GB', escocia: 'GB', 'pais de gales': 'GB', uk: 'GB',
    holanda: 'NL', 'republica tcheca': 'CZ', tchequia: 'CZ',
    'coreia do sul': 'KR', turkiye: 'TR', 'emirados arabes': 'AE',
  };
  for (const [nome, codigo] of Object.entries(apelidos)) mapa.set(nome, codigo);
  return mapa;
})();

const NOME_EM_INGLES = new Intl.DisplayNames(['en'], { type: 'region' });

function paisEmIngles(pais) {
  const codigo = CODIGO_DO_PAIS.get(normalizar(pais));
  if (!codigo) return null;
  return { codigo, nome: NOME_EM_INGLES.of(codigo) };
}

/// Cidades cujo nome em inglês é outro. Só as que aparecem em roteiro;
/// a maioria (Paris, Barcelona, Buenos Aires) é igual nas duas línguas.
const CIDADES_EM_INGLES = {
  lisboa: 'Lisbon', londres: 'London', roma: 'Rome', florenca: 'Florence',
  veneza: 'Venice', milao: 'Milan', napoles: 'Naples', turim: 'Turin',
  genova: 'Genoa', munique: 'Munich', colonia: 'Cologne', viena: 'Vienna',
  praga: 'Prague', varsovia: 'Warsaw', cracovia: 'Krakow', atenas: 'Athens',
  bruxelas: 'Brussels', antuerpia: 'Antwerp', bruges: 'Bruges', haia: 'The Hague',
  genebra: 'Geneva', zurique: 'Zurich', basileia: 'Basel', berna: 'Bern',
  copenhague: 'Copenhagen', estocolmo: 'Stockholm', moscou: 'Moscow',
  'sao petersburgo': 'Saint Petersburg', budapeste: 'Budapest',
  bucareste: 'Bucharest', edimburgo: 'Edinburgh', sevilha: 'Seville',
  bordeus: 'Bordeaux', liao: 'Lyon', marselha: 'Marseille', monaco: 'Monaco',
  'nova york': 'New York', 'nova iorque': 'New York', 'nova orleans': 'New Orleans',
  'sao francisco': 'San Francisco', filadelfia: 'Philadelphia',
  'cidade do mexico': 'Mexico City', 'cidade do cabo': 'Cape Town',
  montevideu: 'Montevideo', assuncao: 'Asuncion', pequim: 'Beijing',
  xangai: 'Shanghai', toquio: 'Tokyo', quioto: 'Kyoto', seul: 'Seoul',
  singapura: 'Singapore', 'nova delhi': 'New Delhi', jerusalem: 'Jerusalem',
  istambul: 'Istanbul', marraquexe: 'Marrakesh', cairo: 'Cairo',
  dubrovnik: 'Dubrovnik', 'santiago de compostela': 'Santiago de Compostela',
};

/// Estados do Brasil: o app grava a sigla ("Foz do Iguaçu, PR, Brasil"),
/// e a sigla não serve de busca nem de conferência.
const ESTADOS_DO_BRASIL = {
  ac: 'Acre', al: 'Alagoas', ap: 'Amapá', am: 'Amazonas', ba: 'Bahia',
  ce: 'Ceará', df: 'Distrito Federal', es: 'Espírito Santo', go: 'Goiás',
  ma: 'Maranhão', mt: 'Mato Grosso', ms: 'Mato Grosso do Sul',
  mg: 'Minas Gerais', pa: 'Pará', pb: 'Paraíba', pr: 'Paraná',
  pe: 'Pernambuco', pi: 'Piauí', rj: 'Rio de Janeiro',
  rn: 'Rio Grande do Norte', rs: 'Rio Grande do Sul', ro: 'Rondônia',
  rr: 'Roraima', sc: 'Santa Catarina', sp: 'São Paulo', se: 'Sergipe',
  to: 'Tocantins',
};

function nomeDaRegiao(regiao, codigoDoPais) {
  const limpa = String(regiao ?? '').trim();
  if (!limpa) return null;
  if (codigoDoPais === 'BR') {
    const estado = ESTADOS_DO_BRASIL[normalizar(limpa)];
    if (estado) return estado;
  }
  // Sigla de outro país (CA, NY) não serve de busca.
  return limpa.length > 3 ? limpa : null;
}

// =====================================================================
// A CHAVE E OS NÍVEIS
// =====================================================================

/// A chave de um destino no banco. A mesma cidade escrita com ou sem
/// acento cai na mesma foto.
function chaveDoDestino({ cidade, regiao, pais }) {
  return [cidade, regiao, pais].map(normalizar).join('|');
}

/// As chaves dos níveis de cima são compartilhadas: duas cidades do
/// interior da França usam a mesma foto da França, e uma foto que a Lais
/// escolher à mão para o país vale para todas.
function chaveDaRegiao({ regiao, pais }) {
  return ['', normalizar(regiao), normalizar(pais)].join('|');
}
function chaveDoPais({ pais }) {
  return ['', '', normalizar(pais)].join('|');
}

/// Os níveis da busca, do mais específico ao mais geral. Cada nível diz
/// o que buscar e que nomes precisam aparecer na foto para ela valer.
function niveisDaBusca(destino) {
  const pais = paisEmIngles(destino.pais);
  const niveis = [];
  const cidade = String(destino.cidade ?? '').trim();
  if (cidade) {
    const ingles = CIDADES_EM_INGLES[normalizar(cidade)];
    const nomes = [cidade, ingles].filter(Boolean);
    niveis.push({
      nivel: 'cidade',
      chave: chaveDoDestino(destino),
      consulta: [ingles ?? cidade, pais?.nome].filter(Boolean).join(' '),
      exigir: nomes,
    });
  }
  const regiao = nomeDaRegiao(destino.regiao, pais?.codigo);
  if (regiao) {
    niveis.push({
      nivel: 'regiao',
      chave: chaveDaRegiao(destino),
      consulta: [regiao, pais?.nome].filter(Boolean).join(' '),
      exigir: [regiao],
    });
  }
  if (pais) {
    niveis.push({
      nivel: 'pais',
      chave: chaveDoPais(destino),
      consulta: pais.nome,
      exigir: [pais.nome, destino.pais].filter(Boolean),
    });
  }
  return niveis;
}

// =====================================================================
// O QUE ACEITAR
// =====================================================================

/// Todo o texto que o Unsplash dá sobre a foto, normalizado e com
/// espaços nas pontas para casar palavra inteira.
function textoDaFoto(foto) {
  const partes = [
    foto?.description,
    foto?.alt_description,
    foto?.slug,
    ...Object.values(foto?.alternative_slugs ?? {}),
    foto?.location?.name,
    foto?.location?.city,
    foto?.location?.country,
    ...(foto?.tags ?? []).map((t) => t?.title),
  ];
  return ` ${normalizar(partes.filter(Boolean).join(' '))} `;
}

function mencionaAlgum(foto, nomes) {
  const texto = textoDaFoto(foto);
  return nomes.some((nome) => {
    const n = normalizar(nome);
    return n.length >= 3 && texto.includes(` ${n} `);
  });
}

/// "Céu azul saturado com nuvem branca" é a assinatura da concorrência,
/// e o brandbook proíbe. O Unsplash dá a cor predominante da foto: azul
/// forte e claro ali quase sempre é céu ocupando o quadro.
function ceuAzulSaturado(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return false;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h >= 190 && h <= 240 && s >= 0.45 && l >= 0.35 && l <= 0.8;
}

const LARGURA_MINIMA = 1600;

/// A foto diz de que país é, e é outro. Existe Sinop no Mato Grosso e
/// Sinop na Turquia: o nome casa, o lugar não. Só vale quando a foto traz
/// a localização; sem ela, não há como saber e a foto não é recusada.
function deOutroPais(foto, paisDoDestino) {
  const daFoto = normalizar(foto?.location?.country);
  if (!daFoto || !paisDoDestino) return false;
  const esperado = paisEmIngles(paisDoDestino);
  const aceitos = [normalizar(paisDoDestino), normalizar(esperado?.nome)].filter(Boolean);
  return !aceitos.includes(daFoto) && CODIGO_DO_PAIS.get(daFoto) !== esperado?.codigo;
}

/// Por que uma foto foi recusada, ou null se ela vale. O motivo vai para
/// o log: é por ele que se ajusta a regra depois.
function motivoDaRecusa(foto, nomes, paisDoDestino) {
  if (!foto?.urls?.regular) return 'sem_url';
  // Unsplash+ é licença paga; a API não deveria devolver, mas se
  // devolver não serve.
  if (foto.premium || foto.plus) return 'unsplash_plus';
  if (!(foto.width >= LARGURA_MINIMA && foto.width > foto.height)) return 'pequena_ou_vertical';
  if (!mencionaAlgum(foto, nomes)) return 'lugar_errado';
  if (deOutroPais(foto, paisDoDestino)) return 'outro_pais';
  if (ceuAzulSaturado(foto.color)) return 'ceu_azul';
  return null;
}

/// A melhor foto aceita de uma busca: entre as que passam, a de mais
/// curtidas. Devolve a foto e as recusas, para o log.
function escolherFoto(resultados, nomes, paisDoDestino) {
  const recusas = {};
  const aceitas = [];
  for (const foto of Array.isArray(resultados) ? resultados : []) {
    const motivo = motivoDaRecusa(foto, nomes, paisDoDestino);
    if (motivo) recusas[motivo] = (recusas[motivo] ?? 0) + 1;
    else aceitas.push(foto);
  }
  aceitas.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0));
  return { foto: aceitas[0] ?? null, recusas };
}

// =====================================================================
// O QUE GUARDAR E DEVOLVER
// =====================================================================

/// A licença pede o link de volta com estes parâmetros.
const UTM = 'utm_source=trix_travel&utm_medium=referral';
function comUtm(url) {
  if (!url) return null;
  return url + (url.includes('?') ? '&' : '?') + UTM;
}

/// A linha da tabela `fotos_de_destino` para uma foto escolhida.
function linhaDaFoto({ chave, tipo, nivel, consulta, foto }) {
  return {
    chave,
    tipo,
    nivel,
    consulta,
    unsplash_id: foto.id,
    url: foto.urls.regular,
    url_pequena: foto.urls.small ?? foto.urls.regular,
    cor: foto.color ?? null,
    fotografo_nome: foto.user?.name ?? null,
    fotografo_url: comUtm(foto.user?.links?.html),
    pagina_url: comUtm(foto.links?.html),
  };
}

/// A linha de "não há foto", para não refazer a busca a cada abertura.
function linhaSemFoto({ chave, tipo, consulta }) {
  return { chave, tipo, nivel: 'nenhuma', consulta };
}

/// "Não há foto" vale por 30 dias; depois a busca é refeita, porque o
/// acervo do Unsplash cresce.
const VALIDADE_SEM_FOTO_MS = 30 * 24 * 3600 * 1000;

function linhaAindaVale(linha, agora = Date.now()) {
  if (!linha) return false;
  if (linha.nivel !== 'nenhuma') return true;
  const quando = Date.parse(linha.atualizada_em ?? linha.criada_em ?? '');
  return Number.isFinite(quando) && agora - quando < VALIDADE_SEM_FOTO_MS;
}

/// O que o app recebe: só o que a tela usa, ou null.
function paraOApp(linha) {
  if (!linha || linha.nivel === 'nenhuma' || !linha.url) return null;
  return {
    nivel: linha.nivel,
    url: linha.url,
    url_pequena: linha.url_pequena ?? linha.url,
    cor: linha.cor ?? null,
    fotografo_nome: linha.fotografo_nome ?? null,
    fotografo_url: linha.fotografo_url ?? null,
    pagina_url: linha.pagina_url ?? null,
  };
}

// =====================================================================
// LUGARES (as atividades)
//
// Para atividade não há cascata: a foto do Louvre serve, uma foto "da
// França" no lugar de um restaurante não. Ou o lugar aparece na foto, ou
// a tela usa a imagem da categoria.
// =====================================================================

/// Palavras que não identificam um lugar: "Museu", "Igreja", "de". Sem
/// tirá-las, "Museu de Arte" casaria com qualquer museu.
const PALAVRAS_GENERICAS = new Set(
  (
    'museu museo museum musee igreja church iglesia eglise catedral cathedral ' +
    'basilica capela chapel praca plaza square place parque park jardim garden ' +
    'mercado market restaurante restaurant cafe bar rua street avenida avenue ' +
    'ponte bridge castelo castle palacio palace torre tower mirante viewpoint ' +
    'praia beach porto port casa house centro center centre galeria gallery ' +
    'teatro theatre theater bairro do da de dos das di del la le el the of and ' +
    'e em no na nos nas a o os as y st santa santo sao saint san ' +
    'central municipal nacional national antigo antiga velho velha novo nova old new'
  ).split(' '),
);

function nomesDoLugar(lugar) {
  const palavras = normalizar(lugar).split(' ').filter(Boolean);
  const distintas = palavras.filter((p) => p.length >= 4 && !PALAVRAS_GENERICAS.has(p));
  return distintas;
}

function chaveDoLugar({ lugar, cidade, pais }) {
  return ['lugar', normalizar(lugar), normalizar(cidade), normalizar(pais)].join('|');
}

/// A busca de um lugar: o nome e a cidade. Para valer, uma palavra
/// própria do nome do lugar precisa aparecer na foto. Sem palavra própria
/// ("Mercado Central") não há como conferir, e não se busca.
function buscaDoLugar(alvo) {
  const nomes = nomesDoLugar(alvo.lugar);
  if (!nomes.length) return null;
  const cidade = String(alvo.cidade ?? '').trim();
  const cidadeEn = CIDADES_EM_INGLES[normalizar(cidade)] ?? cidade;
  return {
    nivel: 'lugar',
    chave: chaveDoLugar(alvo),
    consulta: [alvo.lugar, cidadeEn].filter(Boolean).join(' '),
    exigir: nomes,
  };
}

module.exports = {
  normalizar,
  paisEmIngles,
  nomeDaRegiao,
  chaveDoDestino,
  chaveDaRegiao,
  chaveDoPais,
  niveisDaBusca,
  textoDaFoto,
  ceuAzulSaturado,
  motivoDaRecusa,
  escolherFoto,
  linhaDaFoto,
  linhaSemFoto,
  linhaAindaVale,
  paraOApp,
  nomesDoLugar,
  chaveDoLugar,
  buscaDoLugar,
  comUtm,
  LARGURA_MINIMA,
};
