const jwt = require('jsonwebtoken');
const foto = require('./foto');

// A foto do destino e do lugar, decidida uma vez e guardada (07/10).
//
// O app pede uma lista de destinos ("Lyon, França") e de lugares ("Louvre,
// Paris, França"); este serviço devolve uma foto para cada um, ou null.
// A primeira vez que um destino aparece, ele busca no Unsplash pela regra
// do `foto.js` e grava em `fotos_de_destino`. Da segunda em diante, só lê.
//
// Por que no backend, e não no app:
//   - a chave do Unsplash sai do bundle, onde estava desde o FlutterFlow;
//   - todo mundo vê a mesma foto de Lyon, em todas as telas;
//   - o limite do Unsplash (1.000 buscas por hora em produção) só é
//     gasto na primeira vez de cada destino;
//   - a Lais troca qualquer foto direto na tabela, e a troca vale para
//     todos.

// =================================================================
// AUTENTICACAO: chamadas vindas do app (usuario logado, real ou anonimo)
//
// Sem token, qualquer um gastaria o limite do Unsplash pela URL.
// =================================================================
function verifySupabaseAuth(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, process.env.SUPABASE_JWT_SECRET, {
      algorithms: ['HS256'],
    });
    if (payload.role !== 'authenticated') return null;
    return payload;
  } catch (err) {
    return null;
  }
}

// =================================================================
// TETOS
// =================================================================

// Cada busca no Unsplash. Ela costuma voltar em menos de 1 s.
const TETO_UNSPLASH_MS = 6000;
// O banco, nas duas pontas (ler o que já existe, gravar o que achou).
const TETO_BANCO_MS = 5000;
// O pedido inteiro: uma lista de 20 destinos novos faz até 60 buscas.
// O que não couber volta null e é buscado na próxima abertura.
const TETO_TOTAL_MS = 22000;
// Quantas buscas ao mesmo tempo.
const PARALELO = 4;

// A URL é pública: listas e textos têm teto.
const MAX_DESTINOS = 20;
const MAX_LUGARES = 30;
const MAX_TEXTO = 120;

const UNSPLASH = 'https://api.unsplash.com';

function texto(valor) {
  return String(valor ?? '').trim().slice(0, MAX_TEXTO);
}

function lerPedido(corpo) {
  const destinos = (Array.isArray(corpo?.destinos) ? corpo.destinos : [])
    .slice(0, MAX_DESTINOS)
    .map((d) => ({ cidade: texto(d?.cidade), regiao: texto(d?.regiao), pais: texto(d?.pais) }));
  const lugares = (Array.isArray(corpo?.lugares) ? corpo.lugares : [])
    .slice(0, MAX_LUGARES)
    .map((l) => ({ lugar: texto(l?.lugar), cidade: texto(l?.cidade), pais: texto(l?.pais) }));
  return { destinos, lugares };
}

// =================================================================
// BANCO (PostgREST, sem SDK, como os outros serviços)
// =================================================================

async function chamarBanco(caminho, opcoes = {}) {
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_BANCO_MS);
  try {
    const resposta = await fetch(`${url}/rest/v1/${caminho}`, {
      ...opcoes,
      headers: {
        apikey: chave,
        Authorization: `Bearer ${chave}`,
        'Content-Type': 'application/json',
        ...(opcoes.headers ?? {}),
      },
      signal: controlador.signal,
    });
    if (!resposta.ok) {
      throw new Error(`Banco respondeu ${resposta.status}: ${(await resposta.text()).slice(0, 200)}`);
    }
    return resposta;
  } finally {
    clearTimeout(alarme);
  }
}

/// As linhas que já existem para estas chaves, num mapa chave -> linha.
async function lerLinhas(chaves) {
  const unicas = [...new Set(chaves)];
  if (!unicas.length) return new Map();
  // As chaves têm `|` e espaço: entre aspas duplas no `in`.
  const lista = unicas.map((c) => `"${c.replace(/"/g, '')}"`).join(',');
  const resposta = await chamarBanco(
    `fotos_de_destino?select=*&chave=in.(${encodeURIComponent(lista)})`,
  );
  const linhas = await resposta.json();
  return new Map(linhas.map((l) => [l.chave, l]));
}

async function gravarLinha(linha) {
  await chamarBanco('fotos_de_destino?on_conflict=chave', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ ...linha, atualizada_em: new Date().toISOString() }),
  });
}

// =================================================================
// UNSPLASH
// =================================================================

class LimiteDoUnsplash extends Error {}

async function buscarNoUnsplash(consulta) {
  const params = new URLSearchParams({
    query: consulta,
    orientation: 'landscape',
    content_filter: 'high',
    per_page: '20',
  });
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_UNSPLASH_MS);
  try {
    const resposta = await fetch(`${UNSPLASH}/search/photos?${params}`, {
      headers: {
        Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}`,
        'Accept-Version': 'v1',
      },
      signal: controlador.signal,
    });
    // 403 com o limite estourado, ou 429: parar de buscar neste pedido.
    if (resposta.status === 429 || (resposta.status === 403 && resposta.headers.get('x-ratelimit-remaining') === '0')) {
      throw new LimiteDoUnsplash('Limite do Unsplash atingido.');
    }
    if (!resposta.ok) throw new Error(`Unsplash respondeu ${resposta.status}.`);
    const corpo = await resposta.json();
    return Array.isArray(corpo?.results) ? corpo.results : [];
  } finally {
    clearTimeout(alarme);
  }
}

/// A licença exige avisar o Unsplash quando uma foto é usada: é como o
/// fotógrafo recebe o crédito. Avisamos uma vez, quando a foto vira a
/// foto daquele destino. Falha aqui não derruba a escolha.
async function avisarUso(downloadLocation) {
  if (!downloadLocation) return;
  const controlador = new AbortController();
  const alarme = setTimeout(() => controlador.abort(), TETO_UNSPLASH_MS);
  try {
    await fetch(downloadLocation, {
      headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
      signal: controlador.signal,
    });
  } catch (erro) {
    console.warn(`[Foto] Não consegui avisar o uso ao Unsplash: ${erro.message}`);
  } finally {
    clearTimeout(alarme);
  }
}

// =================================================================
// A RESOLUÇÃO
// =================================================================

/// Resolve um nível (uma chave). Lê do que já existe; se não houver, ou
/// se o "não há foto" venceu, busca, grava e devolve a linha. Chaves
/// repetidas no mesmo pedido (duas cidades da França caindo no país)
/// resolvem uma vez só.
function resolvedor(existentes, prazo, estado) {
  const emAndamento = new Map();

  return function resolver(nivel, tipo, paisDoDestino) {
    if (emAndamento.has(nivel.chave)) return emAndamento.get(nivel.chave);
    const promessa = (async () => {
      const guardada = existentes.get(nivel.chave);
      if (foto.linhaAindaVale(guardada)) return guardada;
      if (estado.semLimite || Date.now() > prazo) return null;

      let resultados;
      try {
        resultados = await buscarNoUnsplash(nivel.consulta);
      } catch (erro) {
        if (erro instanceof LimiteDoUnsplash) estado.semLimite = true;
        console.warn(`[Foto] Busca "${nivel.consulta}" falhou: ${erro.message}`);
        return null;
      }
      const { foto: escolhida, recusas } = foto.escolherFoto(resultados, nivel.exigir, paisDoDestino);
      console.log(JSON.stringify({
        evento: 'foto_buscada',
        nivel: nivel.nivel,
        consulta: nivel.consulta,
        resultados: resultados.length,
        recusas,
        escolhida: escolhida?.id ?? null,
      }));

      const linha = escolhida
        ? foto.linhaDaFoto({ chave: nivel.chave, tipo, nivel: nivel.nivel, consulta: nivel.consulta, foto: escolhida })
        : foto.linhaSemFoto({ chave: nivel.chave, tipo, consulta: nivel.consulta });
      try {
        await gravarLinha(linha);
      } catch (erro) {
        console.warn(`[Foto] Não consegui gravar ${nivel.chave}: ${erro.message}`);
      }
      if (escolhida) await avisarUso(escolhida.links?.download_location);
      return linha;
    })();
    emAndamento.set(nivel.chave, promessa);
    return promessa;
  };
}

/// A cascata de um destino: o primeiro nível com foto ganha.
async function fotoDoDestino(destino, resolver) {
  for (const nivel of foto.niveisDaBusca(destino)) {
    const linha = await resolver(nivel, 'destino', destino.pais);
    if (linha && linha.nivel !== 'nenhuma') return linha;
  }
  return null;
}

async function fotoDoLugar(alvo, resolver) {
  const busca = foto.buscaDoLugar(alvo);
  if (!busca) return null;
  const linha = await resolver(busca, 'lugar', alvo.pais);
  return linha && linha.nivel !== 'nenhuma' ? linha : null;
}

/// Roda as tarefas com no máximo `n` ao mesmo tempo, mantendo a ordem.
async function emParalelo(tarefas, n) {
  const saida = new Array(tarefas.length);
  let proxima = 0;
  async function trabalhar() {
    while (proxima < tarefas.length) {
      const i = proxima++;
      saida[i] = await tarefas[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tarefas.length) }, trabalhar));
  return saida;
}

// =================================================================
// SERVIÇO
// =================================================================
exports.fotoDoDestino = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }

  const usuario = verifySupabaseAuth(req);
  if (!usuario) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  const { destinos, lugares } = lerPedido(req.body);
  if (!destinos.length && !lugares.length) {
    return res.status(200).json({ destinos: [], lugares: [] });
  }

  const prazo = Date.now() + TETO_TOTAL_MS;
  const estado = { semLimite: false };

  // Uma leitura só para tudo que o pedido pode precisar: os três níveis
  // de cada destino e cada lugar.
  const chaves = [
    ...destinos.flatMap((d) => foto.niveisDaBusca(d).map((n) => n.chave)),
    ...lugares.map((l) => foto.buscaDoLugar(l)?.chave).filter(Boolean),
  ];
  let existentes;
  try {
    existentes = await lerLinhas(chaves);
  } catch (erro) {
    // Sem o banco não há como guardar, e buscar sem guardar gastaria o
    // limite a cada abertura. A tela fica com o bloco de cor.
    console.error(`[Foto] Não consegui ler fotos_de_destino: ${erro.message}`);
    return res.status(200).json({
      destinos: destinos.map(() => null),
      lugares: lugares.map(() => null),
    });
  }

  const resolver = resolvedor(existentes, prazo, estado);
  const tarefas = [
    ...destinos.map((d) => () => fotoDoDestino(d, resolver)),
    ...lugares.map((l) => () => fotoDoLugar(l, resolver)),
  ];
  const linhas = await emParalelo(tarefas, PARALELO);

  return res.status(200).json({
    destinos: linhas.slice(0, destinos.length).map(foto.paraOApp),
    lugares: linhas.slice(destinos.length).map(foto.paraOApp),
  });
};

// Para os testes.
exports._interno = { lerPedido, emParalelo };
