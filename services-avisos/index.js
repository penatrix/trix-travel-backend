const {
  lerConfig,
  autorizado,
  lerPedido,
  quemAvisarDaEntrada,
  amanhaEmSaoPaulo,
  textoDoAviso,
  mensagemParaOAparelho,
  tokenMorreu,
} = require('./avisos');

// =================================================================
// OS AVISOS QUE NÃO SÃO DA GERAÇÃO (30/10)
//
// Pronto, falhou e refeito saem do generate-trip (`aviso-push.js`),
// na hora em que a geração termina. Este serviço manda o resto:
//
//   entrou   alguém entrou num roteiro: avisa o dono e quem já estava.
//            Quem chama é o gatilho `trip_members_avisa_entrada`
//            (scripts/p5.9 do app), no INSERT.
//   vespera  a viagem começa amanhã: avisa todo mundo do roteiro. Quem
//            chama é o pg_cron, às 18h de São Paulo. Só roteiro com
//            `is_date_set`: sem data escolhida, a `start_date` é chute.
//
// Campanha não passa por aqui: vai pelo painel do Firebase, para o
// tópico `novidades`, em que o app inscreve quem aceitou novidades.
//
// Cada aviso entra antes em `avisos_enviados`, com uma chave única por
// pessoa. A chave repetida não volta do insert, e quem não volta não
// recebe: o gatilho que dispara duas vezes e a rodada que roda de novo
// não mandam o mesmo aviso duas vezes.
//
// Sem chave nova para o Firebase: a conta de serviço do Cloud Run pede
// o token ao servidor de metadados, como o generate-trip.
//
// Respostas: 200 tratado ou ignorado, 401 segredo errado, 400 pedido
// que não é nenhum dos dois, 500 o banco falhou.
// =================================================================

const ESCOPO_FCM = 'https://www.googleapis.com/auth/firebase.messaging';
const METADADOS = 'http://metadata.google.internal/computeMetadata/v1';

// O Supabase responde em milissegundos e o Firebase em menos de um
// segundo; os tetos cabem nos 60s do deploy.
const TETO_BANCO_MS = 8000;
const TETO_FCM_MS = 5000;

function cabecalhos(config, extras = {}) {
  return {
    apikey: config.serviceRole,
    Authorization: `Bearer ${config.serviceRole}`,
    'Content-Type': 'application/json',
    ...extras,
  };
}

async function ler(config, caminho) {
  const resposta = await fetch(`${config.supabaseUrl}/rest/v1/${caminho}`, {
    headers: cabecalhos(config),
    signal: AbortSignal.timeout(TETO_BANCO_MS),
  });
  if (!resposta.ok) throw new Error(`leitura de ${caminho.split('?')[0]} falhou: ${resposta.status}`);
  return resposta.json();
}

/// Grava os avisos e devolve só os que são novos.
async function registrar(config, linhas) {
  if (linhas.length === 0) return [];
  const resposta = await fetch(`${config.supabaseUrl}/rest/v1/avisos_enviados?on_conflict=chave`, {
    method: 'POST',
    headers: cabecalhos(config, { Prefer: 'resolution=ignore-duplicates,return=representation' }),
    body: JSON.stringify(linhas),
    signal: AbortSignal.timeout(TETO_BANCO_MS),
  });
  if (!resposta.ok) throw new Error(`registro dos avisos falhou: ${resposta.status}`);
  return resposta.json();
}

const lista = (ids) => `(${ids.map((id) => `"${id}"`).join(',')})`;

let tokenGuardado = null;

async function tokenDeAcesso() {
  if (tokenGuardado && tokenGuardado.vence > Date.now() + 60_000) {
    return tokenGuardado.valor;
  }
  const resposta = await fetch(
    `${METADADOS}/instance/service-accounts/default/token?scopes=${encodeURIComponent(ESCOPO_FCM)}`,
    { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(TETO_FCM_MS) },
  );
  if (!resposta.ok) throw new Error(`metadados responderam ${resposta.status}`);
  const corpo = await resposta.json();
  tokenGuardado = {
    valor: corpo.access_token,
    vence: Date.now() + (Number(corpo.expires_in) || 0) * 1000,
  };
  return tokenGuardado.valor;
}

let projetoGuardado = null;

async function projetoDoFirebase() {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  if (projetoGuardado) return projetoGuardado;
  const resposta = await fetch(`${METADADOS}/project/project-id`, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(TETO_FCM_MS),
  });
  if (!resposta.ok) throw new Error(`metadados responderam ${resposta.status}`);
  projetoGuardado = (await resposta.text()).trim();
  return projetoGuardado;
}

/// Manda a cada aparelho das pessoas. `texto(idioma)` monta o texto na
/// língua do aparelho. Devolve quantos aparelhos receberam. Um aparelho
/// que falha não derruba os outros.
async function enviar(config, { pessoas, tipo, tripId, texto }) {
  if (pessoas.length === 0) return 0;
  const aparelhos = await ler(
    config,
    `aparelhos_de_notificacao?select=token,plataforma,idioma&user_id=in.${lista(pessoas)}`,
  );
  if (aparelhos.length === 0) return 0;

  const [acesso, projeto] = await Promise.all([tokenDeAcesso(), projetoDoFirebase()]);
  const url = `https://fcm.googleapis.com/v1/projects/${projeto}/messages:send`;

  const entregues = await Promise.all(aparelhos.map(async (a) => {
    try {
      const resposta = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${acesso}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(mensagemParaOAparelho(a.token, a.plataforma, tipo, tripId, texto(a.idioma))),
        signal: AbortSignal.timeout(TETO_FCM_MS),
      });
      if (resposta.ok) return 1;
      const corpo = await resposta.json().catch(() => null);
      if (tokenMorreu(resposta.status, corpo)) {
        await fetch(
          `${config.supabaseUrl}/rest/v1/aparelhos_de_notificacao?token=eq.${encodeURIComponent(a.token)}`,
          { method: 'DELETE', headers: cabecalhos(config), signal: AbortSignal.timeout(TETO_BANCO_MS) },
        ).catch(() => {});
        return 0;
      }
      console.warn(`[Avisos] ${tipo} ${tripId}: FCM respondeu ${resposta.status} para um aparelho ${a.plataforma}.`);
    } catch (erro) {
      console.warn(`[Avisos] ${tipo} ${tripId}: envio falhou - ${erro.message}`);
    }
    return 0;
  }));
  return entregues.reduce((a, b) => a + b, 0);
}

async function avisarEntrada(config, pedido) {
  const [roteiro] = await ler(config, `trips?select=id,title,user_id,status&id=eq.${pedido.tripId}`);
  if (!roteiro) return 'roteiro não existe';
  const membros = await ler(config, `trip_members?select=user_id&trip_id=eq.${pedido.tripId}`);
  const pessoas = quemAvisarDaEntrada({
    dono: roteiro.user_id,
    membros: membros.map((m) => m.user_id),
    quemEntrou: pedido.quemEntrou,
  });
  const novos = await registrar(config, pessoas.map((p) => ({
    chave: `entrou:${pedido.membroId}:${p}`,
    tipo: 'entrou',
    trip_id: pedido.tripId,
    user_id: p,
  })));
  if (novos.length === 0) return 'nada novo';

  const [quem] = await ler(config, `users?select=first_name&id=eq.${pedido.quemEntrou}`);
  const entregues = await enviar(config, {
    pessoas: novos.map((n) => n.user_id),
    tipo: 'entrou',
    tripId: pedido.tripId,
    texto: (idioma) => textoDoAviso('entrou', { nome: quem?.first_name, titulo: roteiro.title, idioma }),
  });
  return `${novos.length} pessoa(s), ${entregues} aparelho(s)`;
}

async function avisarVespera(config, agora = new Date()) {
  const amanha = amanhaEmSaoPaulo(agora);
  const roteiros = await ler(
    config,
    `trips?select=id,title,user_id&status=eq.ready&is_date_set=is.true&start_date=eq.${amanha}`,
  );
  if (roteiros.length === 0) return `nenhum roteiro começa em ${amanha}`;

  const membros = await ler(
    config,
    `trip_members?select=trip_id,user_id&trip_id=in.(${roteiros.map((r) => r.id).join(',')})`,
  );
  let pessoasAvisadas = 0;
  let aparelhos = 0;
  for (const roteiro of roteiros) {
    const pessoas = [...new Set([
      roteiro.user_id,
      ...membros.filter((m) => m.trip_id === roteiro.id).map((m) => m.user_id),
    ].filter(Boolean))];
    const novos = await registrar(config, pessoas.map((p) => ({
      chave: `vespera:${roteiro.id}:${p}`,
      tipo: 'vespera',
      trip_id: roteiro.id,
      user_id: p,
    })));
    if (novos.length === 0) continue;
    pessoasAvisadas += novos.length;
    aparelhos += await enviar(config, {
      pessoas: novos.map((n) => n.user_id),
      tipo: 'vespera',
      tripId: roteiro.id,
      texto: (idioma) => textoDoAviso('vespera', { titulo: roteiro.title, idioma }),
    });
  }
  return `${roteiros.length} roteiro(s) em ${amanha}, ${pessoasAvisadas} pessoa(s), ${aparelhos} aparelho(s)`;
}

exports.enviarAvisos = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Só POST.' });
  }
  const { config, faltam } = lerConfig(process.env);
  if (faltam.length) {
    console.error(`[Avisos] Variáveis ausentes: ${faltam.join(', ')}.`);
    return res.status(500).json({ error: 'Serviço sem configuração.' });
  }
  if (!autorizado(req.headers['x-webhook-secret'], config.segredo)) {
    console.error('[Avisos] Pedido com segredo errado.');
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  const pedido = lerPedido(req.body);
  if (pedido.acao === 'invalido') {
    return res.status(400).json({ error: 'Pedido inválido.' });
  }
  if (pedido.acao === 'ignorar') {
    return res.status(200).json({ ok: true, ignorado: pedido.motivo });
  }

  try {
    const resultado = pedido.acao === 'vespera'
      ? await avisarVespera(config)
      : await avisarEntrada(config, pedido);
    console.log(`[Avisos] ${pedido.acao}: ${resultado}.`);
    return res.status(200).json({ ok: true, resultado });
  } catch (erro) {
    const msg = erro.name === 'TimeoutError' ? 'sem resposta a tempo' : erro.message;
    console.error(`[Avisos] ${pedido.acao} falhou: ${msg}`);
    return res.status(500).json({ error: 'Falha ao avisar.' });
  }
};

exports._internos = { avisarEntrada, avisarVespera };
