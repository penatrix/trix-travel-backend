const jwt = require('jsonwebtoken');
const {
  lerConfig,
  montarClientSecret,
  pedidoDeTroca,
  pedidoDeRevogacao,
  subDoIdToken,
  mesmaContaDaApple,
} = require('./apple');

// =================================================================
// O TOKEN DA APPLE, DO LOGIN À EXCLUSÃO
//
// A Apple exige que um app com login da Apple e exclusão de conta
// revogue o token dela quando a conta é apagada (App Review, diretriz
// 5.1.1(v)). Revogar pede o `refresh_token`, e ele só sai de uma troca
// feita no servidor com a chave .p8 -- por isso este serviço.
//
// Duas ações, um handler (uma pasta, um handler, como as outras):
//
//   guardar   o app nativo manda o `authorization_code` logo depois do
//             login da Apple; aqui ele vira `refresh_token`, gravado em
//             `tokens_da_apple` (scripts/p3.8 do app).
//   revogar   o app chama ANTES do `delete_my_account`; aqui o token é
//             revogado na Apple e a linha sai.
//
// Não fala com o Gemini: não há linha de custo em `eventos`, e por isso
// não há cópia do `registra-evento`.
// =================================================================

// Toda chamada externa tem prazo. A Apple e o Supabase respondem em
// milissegundos; 8s é teto para não pendurar a tela de login nem a de
// exclusão, e cabe folgado nos 30s do deploy.
const TETO_MS = 8000;

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

/// Chamada ao Supabase com a service role. A tabela não tem policy
/// nenhuma: só esta chave lê e escreve.
function supabase(config, caminho, opcoes = {}) {
  return fetch(`${config.supabaseUrl}${caminho}`, {
    ...opcoes,
    headers: {
      apikey: config.serviceRole,
      Authorization: `Bearer ${config.serviceRole}`,
      'Content-Type': 'application/json',
      ...(opcoes.headers ?? {}),
    },
    signal: AbortSignal.timeout(TETO_MS),
  });
}

/// Pedido à Apple, em formulário, como ela exige.
function apple({ url, corpo }) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: corpo,
    signal: AbortSignal.timeout(TETO_MS),
  });
}

/// O `error` da resposta da Apple, sem o resto: a resposta de erro não
/// carrega token, mas o log só precisa do código.
async function erroDaApple(resposta) {
  try {
    const dados = await resposta.json();
    return dados?.error ?? `status ${resposta.status}`;
  } catch (_) {
    return `status ${resposta.status}`;
  }
}

async function guardar({ config, usuario, codigo }) {
  const segredo = montarClientSecret(config);
  const troca = await apple(pedidoDeTroca({ codigo, segredo }));
  if (!troca.ok) {
    const erro = await erroDaApple(troca);
    console.error(`[Apple] Troca recusada para ${usuario.sub}: ${erro}`);
    return { status: 502, corpo: { error: 'A Apple recusou o código.' } };
  }
  const dados = await troca.json();
  if (!dados.refresh_token) {
    console.error(`[Apple] Troca sem refresh_token para ${usuario.sub}.`);
    return { status: 502, corpo: { error: 'A Apple não devolveu o token.' } };
  }

  // O código precisa ser da conta Apple ligada a ESTA conta da Trix.
  const conta = await supabase(config, `/auth/v1/admin/users/${usuario.sub}`);
  if (!conta.ok) {
    throw new Error(`Leitura da conta falhou: ${conta.status}`);
  }
  if (!mesmaContaDaApple(subDoIdToken(dados.id_token), await conta.json())) {
    console.error(`[Apple] Código de outra conta Apple para ${usuario.sub}.`);
    return { status: 403, corpo: { error: 'O código não é desta conta.' } };
  }

  const gravacao = await supabase(config, '/rest/v1/tokens_da_apple?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      user_id: usuario.sub,
      refresh_token: dados.refresh_token,
      atualizado_em: new Date().toISOString(),
    }),
  });
  if (!gravacao.ok) {
    throw new Error(`Gravação do token falhou: ${gravacao.status}`);
  }
  console.log(`[Apple] Token guardado para ${usuario.sub}.`);
  return { status: 204 };
}

async function revogar({ config, usuario }) {
  const filtro = `user_id=eq.${encodeURIComponent(usuario.sub)}`;
  const leitura = await supabase(config, `/rest/v1/tokens_da_apple?${filtro}&select=refresh_token`);
  if (!leitura.ok) {
    throw new Error(`Leitura do token falhou: ${leitura.status}`);
  }
  const linhas = await leitura.json();
  const token = Array.isArray(linhas) ? linhas[0]?.refresh_token : null;

  // Quem nunca entrou pela Apple no app nativo não tem o que revogar --
  // inclusive quem entrou pela Apple na WEB, cujo token fica com o
  // Supabase e não chega a ninguém.
  if (!token) {
    console.log(`[Apple] Nada a revogar para ${usuario.sub}.`);
    return { status: 204 };
  }

  const segredo = montarClientSecret(config);
  const revogacao = await apple(pedidoDeRevogacao({ token, segredo }));
  // `invalid_grant` é token que já não vale (revogado pela própria
  // pessoa nos ajustes do iPhone, por exemplo): o efeito que se queria
  // já existe, e a linha sai do mesmo jeito.
  const erro = revogacao.ok ? null : await erroDaApple(revogacao);
  if (erro && erro !== 'invalid_grant') {
    console.error(`[Apple] Revogação recusada para ${usuario.sub}: ${erro}`);
    // A linha fica. A exclusão da conta segue no app, e o `on delete
    // cascade` a apaga junto.
    return { status: 502, corpo: { error: 'A Apple recusou a revogação.' } };
  }

  const remocao = await supabase(config, `/rest/v1/tokens_da_apple?${filtro}`, {
    method: 'DELETE',
  });
  if (!remocao.ok) {
    throw new Error(`Remoção do token falhou: ${remocao.status}`);
  }
  console.log(`[Apple] Token revogado para ${usuario.sub}${erro ? ' (já não valia)' : ''}.`);
  return { status: 204 };
}

exports.tokenDaApple = async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  const usuario = verifySupabaseAuth(req);
  if (!usuario) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  const { config, faltam } = lerConfig(process.env);
  if (faltam.length) {
    console.error(`[Apple] Variáveis ausentes: ${faltam.join(', ')}.`);
    return res.status(500).json({ error: 'Serviço sem configuração.' });
  }

  const corpo = req.body ?? {};
  try {
    let resultado;
    if (corpo.acao === 'guardar') {
      // Sessão anônima do soft onboarding não tem conta Apple.
      if (usuario.is_anonymous) {
        return res.status(403).json({ error: 'Sessão anônima.' });
      }
      const codigo = String(corpo.authorization_code ?? '').trim();
      if (!codigo) {
        return res.status(400).json({ error: 'authorization_code é obrigatório.' });
      }
      resultado = await guardar({ config, usuario, codigo });
    } else if (corpo.acao === 'revogar') {
      resultado = await revogar({ config, usuario });
    } else {
      return res.status(400).json({ error: "acao deve ser 'guardar' ou 'revogar'." });
    }
    return resultado.status === 204
      ? res.status(204).send('')
      : res.status(resultado.status).json(resultado.corpo);
  } catch (erro) {
    const msg = erro.name === 'TimeoutError'
      ? `Sem resposta em ${Math.round(TETO_MS / 1000)}s.`
      : erro.message;
    console.error(`[Apple] ${corpo.acao ?? '?'} falhou para ${usuario.sub}: ${msg}`);
    return res.status(500).json({ error: 'Falha ao tratar o token da Apple.' });
  }
};
