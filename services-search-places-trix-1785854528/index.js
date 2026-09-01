const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');

// CTO Tip: Inicializar clientes externos FORA da função principal.
// O Cloud Run mantém isso em memória em execuções contínuas,
// economizando centenas de milissegundos por requisição.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// =================================================================
// AUTENTICACAO: chamadas vindas do app (usuario logado, real ou anonimo)
// Valida o JWT do Supabase enviado pelo app no header Authorization.
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
    return payload; // payload.sub = id do usuario (auth.uid())
  } catch (err) {
    return null;
  }
}

// =================================================================
// AUTENTICACAO: chamadas vindas do Webhook do Supabase (servidor-a-servidor)
// Confere um segredo compartilhado enviado como header pelo proprio Webhook,
// configurado em Database > Webhooks > HTTP Headers no painel do Supabase.
// =================================================================
function verifyWebhookSecret(req) {
  const provided = req.headers['x-webhook-secret'];
  const expected = process.env.SUPABASE_WEBHOOK_SECRET;
  return !!expected && provided === expected;
}

// =================================================================
// NOVO SERVIÇO: PROXY DO GOOGLE PLACES (Busca de Cidades)
// =================================================================
exports.searchPlaces = async (req, res) => {
  // 1. A MÁGICA DO CORS: Isso avisa ao navegador Web que ele pode confiar nesta API
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Responde rápido se for apenas a verificação de segurança do navegador (Preflight)
  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  // Usado tambem no funil pre-cadastro (antes de existir sessao) -- por isso
  // o token e opcional aqui, mas quando vier, precisa ser valido.
  //
  // Atencao ao header VAZIO: o app monta 'Authorization: Bearer <token>'
  // sempre, e deslogado o token e string vazia. O header chegava como
  // 'Bearer ' (truthy), caia no 401 e a busca de destino do onboarding
  // pre-cadastro devolvia zero resultados. So rejeitamos quando existe um
  // token de fato e ele nao confere.
  const bearerToken = (req.headers.authorization || '')
    .replace(/^Bearer\s*/i, '')
    .trim();
  if (bearerToken && !verifySupabaseAuth(req)) {
    return res.status(401).json({ error: 'Token de autenticação inválido.' });
  }

  // 2. Pega o que o FlutterFlow enviou na URL
  const input = req.query.input;
  const lang = req.query.lang || 'pt-BR';

  if (!input) {
    return res.status(400).json({ error: 'O parâmetro input é obrigatório' });
  }

  // 3. Monta a URL do Google usando a chave que já está nas suas variáveis
  const apiKey = process.env.GOOGLE_MAPS_KEY;
  const googleUrl = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&types=(cities)&language=${lang}&key=${apiKey}`;

  // 4. Chama o Google e devolve para o FlutterFlow
  try {
    const response = await fetch(googleUrl);
    const data = await response.json();

    if (data.status === 'OK') {
      return res.status(200).json(data.predictions);
    } else {
      return res.status(200).json([]); // Retorna lista vazia se não achar nada
    }
  } catch (error) {
    console.error('Erro ao chamar o Google Places:', error);
    return res.status(500).json({ error: 'Erro interno no servidor' });
  }
};
