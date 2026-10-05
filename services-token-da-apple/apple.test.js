// Testes da parte pura do token da Apple. Nenhum toca a rede.
//
// O que fica travado é o que a Apple confere e o compilador não vê: o
// formato do segredo (um JWT ES256 com claims exatos) e os campos dos
// dois pedidos. Um `sub` errado ou um `aud` com barra no fim e a Apple
// responde `invalid_client`, sem dizer qual campo.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const {
  CLIENT_ID,
  VALIDADE_DO_SEGREDO_S,
  URL_DO_TOKEN,
  URL_DA_REVOGACAO,
  lerChavePrivada,
  lerConfig,
  montarClientSecret,
  pedidoDeTroca,
  pedidoDeRevogacao,
  subDoIdToken,
  mesmaContaDaApple,
} = require('./apple');

// Uma chave P-256 como a .p8 da Apple (PKCS8), gerada só para o teste.
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const chave = privateKey.export({ type: 'pkcs8', format: 'pem' });
const publica = publicKey.export({ type: 'spki', format: 'pem' });

const config = { teamId: '9YDU67FKQM', keyId: 'ABC123DEFG', chave };

// =====================================================================
// O SEGREDO
// =====================================================================

test('o segredo é um JWT ES256 que confere com a chave pública', () => {
  const segredo = montarClientSecret(config);
  const conferido = jwt.verify(segredo, publica, { algorithms: ['ES256'] });
  assert.strictEqual(conferido.iss, '9YDU67FKQM');
  assert.strictEqual(conferido.sub, 'travel.trix.app');
  assert.strictEqual(conferido.aud, 'https://appleid.apple.com');
});

test('o cabeçalho leva o Key ID', () => {
  const { header } = jwt.decode(montarClientSecret(config), { complete: true });
  assert.deepStrictEqual(header, { alg: 'ES256', kid: 'ABC123DEFG' });
});

test('vale cinco minutos a partir de agora', () => {
  const agora = Date.UTC(2026, 9, 5, 12, 0, 0);
  const { iat, exp } = jwt.decode(montarClientSecret({ ...config, agora }));
  assert.strictEqual(iat, agora / 1000);
  assert.strictEqual(exp - iat, VALIDADE_DO_SEGREDO_S);
  assert.ok(VALIDADE_DO_SEGREDO_S <= 15777000, 'a Apple recusa mais de seis meses');
});

test('o client_id é o do app, não o Services ID da web', () => {
  assert.strictEqual(CLIENT_ID, 'travel.trix.app');
  assert.notStrictEqual(CLIENT_ID, 'travel.trix.signin');
});

// =====================================================================
// A CHAVE E O AMBIENTE
// =====================================================================

test('a chave colada com \\n literal vira PEM de verdade', () => {
  const colada = chave.trim().replace(/\n/g, '\\n');
  assert.strictEqual(lerChavePrivada(colada), chave.trim());
  // E assina, que é o que importa.
  assert.doesNotThrow(() => montarClientSecret({ ...config, chave: lerChavePrivada(colada) }));
});

test('lerConfig diz o que falta, pelo nome da variável', () => {
  const { faltam } = lerConfig({ APPLE_TEAM_ID: '9YDU67FKQM', SUPABASE_URL: 'https://x.supabase.co' });
  assert.deepStrictEqual(faltam, ['APPLE_KEY_ID', 'APPLE_PRIVATE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']);
});

test('lerConfig tira a barra do fim da URL do Supabase', () => {
  const { config: c } = lerConfig({ SUPABASE_URL: 'https://x.supabase.co/' });
  assert.strictEqual(c.supabaseUrl, 'https://x.supabase.co');
});

// =====================================================================
// OS PEDIDOS
// =====================================================================

test('a troca manda o código como authorization_code', () => {
  const { url, corpo } = pedidoDeTroca({ codigo: 'c.123', segredo: 's' });
  assert.strictEqual(url, 'https://appleid.apple.com/auth/token');
  assert.strictEqual(url, URL_DO_TOKEN);
  assert.deepStrictEqual(Object.fromEntries(corpo), {
    client_id: 'travel.trix.app',
    client_secret: 's',
    code: 'c.123',
    grant_type: 'authorization_code',
  });
});

test('a revogação manda o refresh_token com a dica do tipo', () => {
  const { url, corpo } = pedidoDeRevogacao({ token: 'r.456', segredo: 's' });
  assert.strictEqual(url, 'https://appleid.apple.com/auth/revoke');
  assert.strictEqual(url, URL_DA_REVOGACAO);
  assert.deepStrictEqual(Object.fromEntries(corpo), {
    client_id: 'travel.trix.app',
    client_secret: 's',
    token: 'r.456',
    token_type_hint: 'refresh_token',
  });
});

// =====================================================================
// A CONTA CERTA
// =====================================================================

const idToken = (corpo) =>
  `cabecalho.${Buffer.from(JSON.stringify(corpo)).toString('base64url')}.assinatura`;

test('subDoIdToken lê o sub, e devolve null para lixo', () => {
  assert.strictEqual(subDoIdToken(idToken({ sub: '001234.abc' })), '001234.abc');
  assert.strictEqual(subDoIdToken('nao-e-jwt'), null);
  assert.strictEqual(subDoIdToken(undefined), null);
});

test('mesmaContaDaApple confere o sub com a identidade Apple da conta', () => {
  const usuario = {
    identities: [
      { provider: 'email', id: 'x' },
      { provider: 'apple', id: '001234.abc', identity_data: { sub: '001234.abc' } },
    ],
  };
  assert.strictEqual(mesmaContaDaApple('001234.abc', usuario), true);
  assert.strictEqual(mesmaContaDaApple('999999.zzz', usuario), false);
});

test('conta sem identidade Apple, ou sub vazio, não confere', () => {
  assert.strictEqual(mesmaContaDaApple('001234.abc', { identities: [{ provider: 'google', id: '001234.abc' }] }), false);
  assert.strictEqual(mesmaContaDaApple('001234.abc', {}), false);
  assert.strictEqual(mesmaContaDaApple(null, { identities: [{ provider: 'apple', id: '' }] }), false);
});
