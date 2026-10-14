// A notificação push do roteiro: pronto, falhou, refeito (14/10).
//
// O app tinha só o aviso dentro dele, enquanto estava aberto
// ("Avisar quando ficar pronto"). A notificação chega com o app fechado,
// pelo Firebase Cloud Messaging, nos aparelhos que a pessoa autorizou e
// que o app gravou em `aparelhos_de_notificacao` (scripts/p5.0 do app).
//
// =====================================================================
// SEM CHAVE NOVA
// =====================================================================
//
// O Firebase mora no mesmo projeto do Google Cloud que o Cloud Run. A
// conta de serviço do serviço pede o token ao servidor de metadados,
// com o escopo do FCM, e manda pela API v1. Nenhum segredo novo, nenhuma
// dependência: o papel "Firebase Cloud Messaging API Admin" na conta de
// serviço é o que autoriza.
//
// =====================================================================
// NUNCA SEGURA NADA
// =====================================================================
//
// Quem chama não espera (`void avisarDono(...)`): o roteiro já está
// gravado, e um aviso que falha não pode virar roteiro que falha. Tudo
// aqui engole erro e só registra no log. Token que o Firebase diz que
// morreu (app desinstalado, permissão tirada) é apagado da tabela.

const ESCOPO_FCM = 'https://www.googleapis.com/auth/firebase.messaging';
const METADADOS = 'http://metadata.google.internal/computeMetadata/v1';
const TIMEOUT_MS = 5000;

/// O texto de cada aviso. Direto, sem exclamação e sem emoji; o nome do
/// roteiro vai no corpo, porque o título precisa dizer o que aconteceu.
function textoDoAviso(tipo, { titulo, idioma } = {}) {
  const en = idioma === 'en';
  const nome = String(titulo ?? '').trim();
  switch (tipo) {
    case 'pronto':
      return {
        titulo: en ? 'Your itinerary is ready' : 'Seu roteiro está pronto',
        corpo: nome
          ? (en ? `${nome}. Tap to open it.` : `${nome}. Toque para abrir.`)
          : (en ? 'Tap to open it.' : 'Toque para abrir.'),
      };
    case 'refeito':
      return {
        titulo: en ? 'Your itinerary was rebuilt' : 'Seu roteiro foi refeito',
        corpo: nome
          ? (en ? `${nome}. Tap to see what changed.` : `${nome}. Toque para ver o que mudou.`)
          : (en ? 'Tap to see what changed.' : 'Toque para ver o que mudou.'),
      };
    case 'falhou':
      return {
        titulo: en ? 'The itinerary was not generated' : 'O roteiro não foi gerado',
        corpo: en
          ? 'Nothing was charged. Create it again when you like.'
          : 'Nada foi descontado. Crie de novo quando quiser.',
      };
    case 'refazer_falhou':
      return {
        titulo: en ? 'The itinerary was not rebuilt' : 'O roteiro não foi refeito',
        corpo: en
          ? 'Your itinerary stays as it was. You can try again.'
          : 'O roteiro continua como estava. Você pode tentar de novo.',
      };
    default:
      return null;
  }
}

/// A mensagem da API v1 para um aparelho. O `data` é o que o app lê no
/// toque para abrir o roteiro certo; os valores precisam ser texto.
function mensagemParaOAparelho(token, plataforma, tipo, tripId, texto) {
  const data = { tipo, trip_id: String(tripId) };
  const mensagem = {
    token,
    notification: { title: texto.titulo, body: texto.corpo },
    data,
    android: {
      priority: 'high',
      notification: { channel_id: 'roteiro', tag: `roteiro-${tripId}` },
    },
    apns: {
      headers: { 'apns-collapse-id': `roteiro-${tripId}` },
      payload: { aps: { sound: 'default' } },
    },
  };
  if (plataforma === 'web') {
    mensagem.webpush = { fcm_options: { link: 'https://app.trix.travel/' } };
  }
  return { message: mensagem };
}

async function comTempo(url, opcoes = {}) {
  const controle = new AbortController();
  const alarme = setTimeout(() => controle.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opcoes, signal: controle.signal });
  } finally {
    clearTimeout(alarme);
  }
}

let tokenGuardado = null;

/// O token de acesso da conta de serviço, reaproveitado até perto de
/// vencer.
async function tokenDeAcesso() {
  if (tokenGuardado && tokenGuardado.vence > Date.now() + 60_000) {
    return tokenGuardado.valor;
  }
  const resposta = await comTempo(
    `${METADADOS}/instance/service-accounts/default/token?scopes=${encodeURIComponent(ESCOPO_FCM)}`,
    { headers: { 'Metadata-Flavor': 'Google' } },
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
  const resposta = await comTempo(`${METADADOS}/project/project-id`, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!resposta.ok) throw new Error(`metadados responderam ${resposta.status}`);
  projetoGuardado = (await resposta.text()).trim();
  return projetoGuardado;
}

/// O Firebase diz que o token não vale mais: o app foi desinstalado, a
/// permissão saiu, ou o token foi trocado.
function tokenMorreu(status, corpo) {
  if (status === 404) return true;
  const codigo = corpo?.error?.details?.find((d) => d?.errorCode)?.errorCode;
  // INVALID_ARGUMENT fica de fora de propósito: ele também vem de
  // mensagem malformada, e apagar por isso limparia todos os aparelhos.
  return codigo === 'UNREGISTERED';
}

/// Avisa todos os aparelhos do dono do roteiro. Nunca lança.
async function avisarDono(supabase, { userId, tripId, tipo, titulo, idioma }) {
  try {
    if (!userId || !tripId) return;
    const { data: aparelhos, error } = await supabase
      .from('aparelhos_de_notificacao')
      .select('token, plataforma, idioma')
      .eq('user_id', userId);
    if (error) throw error;
    if (!aparelhos || aparelhos.length === 0) return;

    const [acesso, projeto] = await Promise.all([tokenDeAcesso(), projetoDoFirebase()]);
    const url = `https://fcm.googleapis.com/v1/projects/${projeto}/messages:send`;

    await Promise.all(aparelhos.map(async (a) => {
      const texto = textoDoAviso(tipo, { titulo, idioma: idioma || a.idioma });
      if (!texto) return;
      try {
        const resposta = await comTempo(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${acesso}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(mensagemParaOAparelho(a.token, a.plataforma, tipo, tripId, texto)),
        });
        if (resposta.ok) return;
        const corpo = await resposta.json().catch(() => null);
        if (tokenMorreu(resposta.status, corpo)) {
          await supabase.from('aparelhos_de_notificacao').delete().eq('token', a.token);
          return;
        }
        console.warn(`[Push] Trip ${tripId}: FCM respondeu ${resposta.status} para um aparelho ${a.plataforma}.`);
      } catch (erro) {
        console.warn(`[Push] Trip ${tripId}: envio falhou - ${erro.message}`);
      }
    }));
  } catch (erro) {
    console.warn(`[Push] Trip ${tripId}: aviso não saiu - ${erro.message}`);
  }
}

module.exports = { avisarDono, textoDoAviso, mensagemParaOAparelho, tokenMorreu };
