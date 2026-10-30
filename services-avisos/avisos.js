// Os avisos que não são da geração, lidos e escritos sem rede.
//
// Tudo aqui é puro, para o `npm test` travar: quem recebe, o texto e a
// mensagem do Firebase. Quem chama o banco e o Firebase é o `index.js`.

'use strict';

const crypto = require('node:crypto');

/// O que o serviço precisa do ambiente, ou a lista do que falta.
function lerConfig(env) {
  const config = {
    segredo: String(env.AVISOS_WEBHOOK_SECRET ?? '').trim(),
    supabaseUrl: String(env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
    serviceRole: String(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  };
  const faltam = [
    ['AVISOS_WEBHOOK_SECRET', config.segredo],
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', config.serviceRole],
  ].filter(([, v]) => !v).map(([nome]) => nome);
  return { config, faltam };
}

/// O segredo do cabeçalho `x-webhook-secret`, comparado em tempo
/// constante (pelo resumo, para o tamanho não encurtar a comparação).
function autorizado(cabecalho, esperado) {
  if (!esperado) return false;
  const resumo = (t) => crypto.createHash('sha256').update(String(t ?? '')).digest();
  return crypto.timingSafeEqual(resumo(cabecalho), resumo(esperado));
}

/// O que o pedido quer: alguém entrou num roteiro (o gatilho da
/// `trip_members`), a rodada diária da véspera (o pg_cron), ou nada.
function lerPedido(corpo) {
  if (corpo?.modo === 'vespera') return { acao: 'vespera' };
  const r = corpo?.record;
  if (corpo?.type === 'INSERT' && corpo?.table === 'trip_members' && r) {
    // O dono entra como membro ao criar o roteiro: não é ninguém
    // entrando, é o roteiro nascendo.
    if (r.role === 'owner') return { acao: 'ignorar', motivo: 'dono' };
    if (!r.id || !r.trip_id || !r.user_id) return { acao: 'invalido' };
    return {
      acao: 'entrou',
      membroId: String(r.id),
      tripId: Number(r.trip_id),
      quemEntrou: String(r.user_id),
    };
  }
  return { acao: 'invalido' };
}

/// Quem recebe o aviso de que alguém entrou: o dono e quem já estava,
/// sem a própria pessoa que entrou.
function quemAvisarDaEntrada({ dono, membros, quemEntrou }) {
  const todos = new Set([dono, ...(membros ?? [])].filter(Boolean));
  todos.delete(quemEntrou);
  return [...todos];
}

/// A data de hoje e de amanhã em São Paulo, como o banco guarda
/// (`AAAA-MM-DD`). A rodada roda às 18h de lá; em UTC já seria outro dia
/// perto da meia-noite, e a véspera sairia trocada.
function amanhaEmSaoPaulo(agora = new Date()) {
  const hoje = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora);
  const d = new Date(`${hoje}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/// O primeiro nome de quem entrou, ou nada. Só a primeira palavra: o
/// campo é livre, e o aviso fala de uma pessoa, não de um cadastro.
function primeiroNome(nome) {
  const limpo = String(nome ?? '').trim().split(/\s+/)[0] ?? '';
  return limpo.slice(0, 30);
}

/// O texto de cada aviso. Como os da geração: direto, sem exclamação e
/// sem emoji, com o que aconteceu no título e o roteiro no corpo.
function textoDoAviso(tipo, { nome, titulo, idioma } = {}) {
  const en = idioma === 'en';
  const roteiro = String(titulo ?? '').trim();
  switch (tipo) {
    case 'entrou': {
      const quem = primeiroNome(nome);
      return {
        titulo: quem
          ? (en ? `${quem} joined your itinerary` : `${quem} entrou no seu roteiro`)
          : (en ? 'Someone joined your itinerary' : 'Uma pessoa entrou no seu roteiro'),
        corpo: roteiro
          ? (en ? `${roteiro}. Tap to see who is going.` : `${roteiro}. Toque para ver quem vai.`)
          : (en ? 'Tap to see who is going.' : 'Toque para ver quem vai.'),
      };
    }
    case 'vespera':
      return {
        titulo: en ? 'Your trip starts tomorrow' : 'Sua viagem começa amanhã',
        corpo: roteiro
          ? (en ? `${roteiro}. Tap to see day 1.` : `${roteiro}. Toque para ver o dia 1.`)
          : (en ? 'Tap to see day 1.' : 'Toque para ver o dia 1.'),
      };
    default:
      return null;
  }
}

/// A mensagem da API v1 para um aparelho. O `data` é o que o app lê no
/// toque (`notificacoes.dart`): com `trip_id`, abre o roteiro. Os valores
/// precisam ser texto.
function mensagemParaOAparelho(token, plataforma, tipo, tripId, texto) {
  const colapso = `${tipo}-${tripId}`;
  const mensagem = {
    token,
    notification: { title: texto.titulo, body: texto.corpo },
    data: { tipo, trip_id: String(tripId) },
    android: { priority: 'high', notification: { tag: colapso } },
    apns: {
      headers: { 'apns-collapse-id': colapso },
      payload: { aps: { sound: 'default' } },
    },
  };
  if (plataforma === 'web') {
    mensagem.webpush = { fcm_options: { link: 'https://app.trix.travel/' } };
  }
  return { message: mensagem };
}

/// O Firebase diz que o token não vale mais. INVALID_ARGUMENT fica de
/// fora: também vem de mensagem malformada, e apagar por isso limparia
/// todos os aparelhos.
function tokenMorreu(status, corpo) {
  if (status === 404) return true;
  const codigo = corpo?.error?.details?.find((d) => d?.errorCode)?.errorCode;
  return codigo === 'UNREGISTERED';
}

module.exports = {
  lerConfig,
  autorizado,
  lerPedido,
  quemAvisarDaEntrada,
  amanhaEmSaoPaulo,
  primeiroNome,
  textoDoAviso,
  mensagemParaOAparelho,
  tokenMorreu,
};
