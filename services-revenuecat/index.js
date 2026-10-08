const {
  lerConfig,
  autorizado,
  lerEvento,
  eventoParaGuardar,
} = require('./revenuecat');

// =================================================================
// A VENDA PELAS LOJAS
//
// O app vende pelo Google Play e pela App Store através do RevenueCat,
// que confere o recibo com a loja e avisa aqui por webhook. Este serviço
// só traduz o aviso numa das três funções do banco (scripts/p4.3 do
// app): registrar_compra, reembolsar_compra, expirar_assinatura. O app
// nunca grava compra; ele espera o plano mudar.
//
// Quem chama é o RevenueCat, não o app: não há token do Supabase. A
// porta é o cabeçalho Authorization cadastrado no painel do RevenueCat,
// o mesmo valor guardado em REVENUECAT_WEBHOOK_AUTH.
//
// Os códigos de resposta são o contrato com o RevenueCat, que reenvia o
// aviso enquanto não recebe 2xx:
//
//   200  tratado, ou ignorado de propósito (reenviar não mudaria nada)
//   401  autorização errada
//   500  o banco falhou: o reenvio é o que salva a compra, e as funções
//        são idempotentes pela transação
//
// Não fala com o Gemini: não há linha de custo em `eventos`.
// =================================================================

// O Supabase responde em milissegundos; 8s é teto, e cabe nos 30s do
// deploy. O RevenueCat espera até 60s antes de considerar falha.
const TETO_MS = 8000;

function rpc(config, funcao, parametros) {
  return fetch(`${config.supabaseUrl}/rest/v1/rpc/${funcao}`, {
    method: 'POST',
    headers: {
      apikey: config.serviceRole,
      Authorization: `Bearer ${config.serviceRole}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parametros),
    signal: AbortSignal.timeout(TETO_MS),
  });
}

async function chamar(config, funcao, parametros) {
  const resposta = await rpc(config, funcao, parametros);
  if (!resposta.ok) {
    throw new Error(`${funcao} falhou: ${resposta.status}`);
  }
  return resposta.json();
}

async function tratar(config, lido, evento) {
  const quem = lido.conta ?? 'sem conta';
  const rotulo = `${lido.evento} ${lido.produto} ${lido.loja}/${lido.ambiente} ${quem}`;

  if (lido.acao === 'registrar') {
    const r = await chamar(config, 'registrar_compra', {
      p_user_id: lido.conta,
      p_loja: lido.loja,
      p_produto: lido.produto,
      p_transacao: lido.transacao,
      p_transacao_original: lido.transacaoOriginal,
      p_tipo: lido.tipo,
      p_valido_ate: lido.validoAte,
      p_comprado_em: lido.compradoEm,
      p_evento: eventoParaGuardar(evento),
    });
    if (!lido.conta) {
      console.error(`[RevenueCat] Compra sem conta da Trix, gravada sem direito: ${rotulo}.`);
    } else {
      console.log(`[RevenueCat] ${r?.nova ? 'Registrada' : 'Repetida'}: ${rotulo}.`);
    }
    return;
  }

  if (lido.acao === 'reembolsar') {
    const r = await chamar(config, 'reembolsar_compra', {
      p_loja: lido.loja,
      p_transacao: lido.transacao,
    });
    if (!r?.achou) {
      console.error(`[RevenueCat] Reembolso de compra desconhecida: ${rotulo} ${lido.transacao}.`);
    } else {
      console.log(`[RevenueCat] Reembolsada (${r.revogou} revogado): ${rotulo}.`);
    }
    return;
  }

  if (lido.acao === 'expirar') {
    const n = await chamar(config, 'expirar_assinatura', {
      p_user_id: lido.conta,
      p_expirou_em: lido.expirouEm,
    });
    console.log(`[RevenueCat] Expirou (${n}): ${rotulo}.`);
  }
}

exports.avisoDoRevenuecat = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Só POST.' });
  }

  const { config, faltam } = lerConfig(process.env);
  if (faltam.length) {
    console.error(`[RevenueCat] Variáveis ausentes: ${faltam.join(', ')}.`);
    return res.status(500).json({ error: 'Serviço sem configuração.' });
  }

  if (!autorizado(req.headers.authorization, config.autorizacao)) {
    console.error('[RevenueCat] Aviso com autorização errada.');
    return res.status(401).json({ error: 'Não autorizado.' });
  }

  const evento = req.body?.event;
  const lido = lerEvento(req.body);

  if (lido.acao === 'invalido') {
    console.error(`[RevenueCat] Aviso sem os campos necessários: ${evento?.type ?? '?'} ${evento?.id ?? ''}.`);
    return res.status(400).json({ error: 'Aviso inválido.' });
  }
  if (lido.acao === 'desconhecido') {
    // Produto que este serviço não conhece. Reenviar não muda nada, então
    // 200 -- e o log é o alarme: alguém cadastrou produto na loja sem
    // ensinar este serviço.
    console.error(`[RevenueCat] Produto desconhecido: ${lido.produto} (${lido.evento}, ${lido.conta ?? 'sem conta'}).`);
    return res.status(200).json({ ok: true, ignorado: 'produto desconhecido' });
  }
  if (lido.acao === 'ignorar') {
    console.log(`[RevenueCat] Ignorado: ${lido.motivo}.`);
    return res.status(200).json({ ok: true, ignorado: lido.motivo });
  }

  try {
    await tratar(config, lido, evento);
    return res.status(200).json({ ok: true });
  } catch (erro) {
    const msg = erro.name === 'TimeoutError'
      ? `Sem resposta em ${Math.round(TETO_MS / 1000)}s.`
      : erro.message;
    console.error(`[RevenueCat] ${lido.evento} ${lido.transacao ?? ''} falhou: ${msg}`);
    return res.status(500).json({ error: 'Falha ao gravar; o RevenueCat reenvia.' });
  }
};
