// O aviso do RevenueCat, lido: quem comprou, o quê, e o que fazer.
//
// Tudo aqui é puro, sem rede, para o `npm test` travar a leitura. Quem
// chama o banco é o `index.js`.
//
// Referência: "Webhooks" e "Event Types and Fields", na documentação do
// RevenueCat. O corpo é `{ api_version, event: { type, app_user_id, ... } }`.

'use strict';

const crypto = require('node:crypto');

/// O que o serviço precisa do ambiente, ou a lista do que falta.
function lerConfig(env) {
  const config = {
    autorizacao: String(env.REVENUECAT_WEBHOOK_AUTH ?? '').trim(),
    supabaseUrl: String(env.SUPABASE_URL ?? '').trim().replace(/\/+$/, ''),
    serviceRole: String(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  };
  const faltam = [
    ['REVENUECAT_WEBHOOK_AUTH', config.autorizacao],
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_ROLE_KEY', config.serviceRole],
  ].filter(([, v]) => !v).map(([nome]) => nome);
  return { config, faltam };
}

/// O cabeçalho Authorization que o RevenueCat manda é o valor que se
/// cadastra no painel dele, inteiro. Compara em tempo constante: pelo
/// resumo, para o tamanho diferente não encurtar a comparação.
function autorizado(cabecalho, esperado) {
  if (!esperado) return false;
  const resumo = (t) => crypto.createHash('sha256').update(String(t ?? '')).digest();
  return crypto.timingSafeEqual(resumo(cabecalho), resumo(esperado));
}

/// O produto, pelo identificador da loja. No Play a assinatura pode vir
/// com o plano básico (`premium_anual:anual`); por isso o prefixo.
/// Produto desconhecido devolve null: é erro de cadastro, e o handler
/// registra no log em vez de inventar um tipo.
function tipoDoProduto(produto) {
  const p = String(produto ?? '');
  if (p === 'premium_anual' || p.startsWith('premium_anual:')) return 'annual';
  if (p === 'travel.trix.app.premium.anual') return 'annual';
  if (p === 'roteiro_premium' || p === 'travel.trix.app.premium.roteiro') return 'trip_credit';
  return null;
}

/// A loja como a `purchases` guarda. Outras (Stripe, promocional do
/// painel) não vendem nada da Trix hoje.
function lojaDoEvento(store) {
  if (store === 'PLAY_STORE') return 'google';
  if (store === 'APP_STORE' || store === 'MAC_APP_STORE') return 'apple';
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/// A conta da Trix: o primeiro identificador que é um uuid do Supabase.
/// O app faz `logIn` com o uid antes de vender, mas uma compra feita
/// antes do login chega com o id anônimo do RevenueCat em `app_user_id`
/// e o uid nos `aliases`.
function contaDoEvento(evento) {
  const candidatos = [
    evento.app_user_id,
    evento.original_app_user_id,
    ...(Array.isArray(evento.aliases) ? evento.aliases : []),
  ];
  return candidatos.find((c) => typeof c === 'string' && UUID.test(c)) ?? null;
}

const quando = (ms) =>
  Number.isFinite(Number(ms)) && ms !== null ? new Date(Number(ms)).toISOString() : null;

/// O que fazer com o aviso. Devolve `{ acao, ... }`:
///
///   registrar   compra nova ou renovação (`registrar_compra`)
///   reembolsar  a loja devolveu o dinheiro (`reembolsar_compra`)
///   expirar     o anual acabou sem renovar (`expirar_assinatura`)
///   ignorar     com `motivo`, para o log
///
/// Cancelar a renovação NÃO tira o Premium: o anual vale até o fim do
/// período pago, e o aviso que encerra é o EXPIRATION. Só o cancelamento
/// pelo suporte da loja (`CUSTOMER_SUPPORT`) é reembolso.
function lerEvento(corpo) {
  const evento = corpo?.event;
  if (!evento || typeof evento.type !== 'string') {
    return { acao: 'invalido' };
  }
  const tipoDoEvento = evento.type;
  if (tipoDoEvento === 'TEST') {
    return { acao: 'ignorar', motivo: 'evento de teste do painel' };
  }

  const loja = lojaDoEvento(evento.store);
  const tipo = tipoDoProduto(evento.product_id);
  const base = {
    evento: tipoDoEvento,
    loja,
    tipo,
    produto: evento.product_id ?? null,
    conta: contaDoEvento(evento),
    transacao: evento.transaction_id ?? null,
    transacaoOriginal: evento.original_transaction_id ?? null,
    ambiente: evento.environment ?? null,
  };

  const compra = ['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE'];
  const relevante = [...compra, 'CANCELLATION', 'EXPIRATION'];
  if (!relevante.includes(tipoDoEvento)) {
    return { ...base, acao: 'ignorar', motivo: `evento ${tipoDoEvento}` };
  }
  if (!loja) {
    return { ...base, acao: 'ignorar', motivo: `loja ${evento.store}` };
  }
  if (!tipo) {
    return { ...base, acao: 'desconhecido' };
  }

  if (compra.includes(tipoDoEvento)) {
    if (!base.transacao) return { ...base, acao: 'invalido' };
    return {
      ...base,
      acao: 'registrar',
      validoAte: tipo === 'annual' ? quando(evento.expiration_at_ms) : null,
      compradoEm: quando(evento.purchased_at_ms),
    };
  }

  if (tipoDoEvento === 'CANCELLATION') {
    if (evento.cancel_reason !== 'CUSTOMER_SUPPORT') {
      return { ...base, acao: 'ignorar', motivo: `cancelamento ${evento.cancel_reason}` };
    }
    if (!base.transacao) return { ...base, acao: 'invalido' };
    return { ...base, acao: 'reembolsar' };
  }

  // EXPIRATION
  if (tipo !== 'annual') {
    return { ...base, acao: 'ignorar', motivo: 'expiração de produto avulso' };
  }
  if (!base.conta) {
    return { ...base, acao: 'ignorar', motivo: 'expiração sem conta' };
  }
  return { ...base, acao: 'expirar', expirouEm: quando(evento.expiration_at_ms) };
}

/// O que vai para `purchases.raw_receipt`: o aviso sem os atributos de
/// assinante, que podem carregar e-mail e nome (o app não manda, mas o
/// painel permite). Fica o que serve para auditar a compra.
function eventoParaGuardar(evento) {
  const {
    subscriber_attributes: _a,
    ...resto
  } = evento ?? {};
  return resto;
}

module.exports = {
  lerConfig,
  autorizado,
  tipoDoProduto,
  lojaDoEvento,
  contaDoEvento,
  lerEvento,
  eventoParaGuardar,
};
