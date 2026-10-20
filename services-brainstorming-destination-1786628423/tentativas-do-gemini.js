// As tentativas da chamada ao Gemini no brainstorming (20/10).
//
// A mesma lógica do generate-trip (`tentativas-do-gemini.js` de lá: cada
// serviço tem a sua cópia, porque o contexto de build é a pasta), com os
// números deste serviço, medidos nos 30 dias até 20/10:
//
//   - 25 respostas boas entre 9s e 34s, mediana perto de 15s;
//   - 3 falhas por timeout (45s duas vezes em 13/10, 70s em 19/10). Na de
//     19/10 a pessoa pediu de novo e a segunda saiu em 15s: o modelo
//     trava às vezes, e uma segunda tentativa resolve.
//
// Por isso: 40s na primeira, acima de tudo que já deu certo, e 30s na
// segunda; as duas com thinking LOW, que já era o deste serviço (3
// cards curtos). 429 e 5xx também tentam de novo, depois de uma pausa.
//
// O PRAZO cabe no --timeout do Cloud Run (90s, cloudbuild.yaml): quando
// ele corta, o processo morre sem o `catch`, e a linha fica presa em
// 'generating'. O app espera 90s pela linha.
//
//   prazo do Gemini (este arquivo)  72s
//   catch, escrita no Supabase      ~18s
//   --timeout do Cloud Run           90s
//
// Mexeu num destes números, refaça a conta.

const PLANO = Object.freeze([
  Object.freeze({ timeoutMs: 40000, thinking: 'LOW' }),
  Object.freeze({ timeoutMs: 30000, thinking: 'LOW' }),
]);

/// O prazo da soma das tentativas, a partir do primeiro pedido.
const PRAZO_TOTAL_MS = 72000;

/// Tentativa com menos que isto pela frente não começa.
const MINIMO_POR_TENTATIVA_MS = 15000;

/// A pausa antes de repetir um 429 ou 5xx, por tentativa já feita.
const PAUSA_TRANSITORIA_MS = 2000;

/// Erro HTTP que passa sozinho: limite de taxa e o servidor do Google.
/// 400 e 403 não: o pedido ou a chave estão errados, e repetir só gasta.
function ehTransitorio(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Chama o Gemini pelo plano de tentativas.
 *
 * `chamar({ thinking, signal })` faz o fetch e devolve a Response; quem
 * chama monta o corpo com o `thinking` da tentativa.
 *
 * Devolve `{ resposta, tentativa, thinking, ms }` da primeira resposta
 * OK, ou da última resposta HTTP de erro (quem chama lança com o texto
 * dela, como antes). Lança `Error` com "timeout" quando nenhuma
 * respondeu, que o `statusDoErro` grava como 'timeout'.
 *
 * `fim` é o instante (ms) em que o prazo acaba; sem ele, conta
 * `prazoTotalMs` a partir de agora. `relogio` e `esperar` são de teste.
 */
async function chamarComTentativas(chamar, rotulo, {
  plano = PLANO,
  fim = null,
  prazoTotalMs = PRAZO_TOTAL_MS,
  minimoMs = MINIMO_POR_TENTATIVA_MS,
  pausaMs = PAUSA_TRANSITORIA_MS,
  relogio = () => Date.now(),
  esperar = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = console,
} = {}) {
  // `fim` vem de quem chama quando o prazo é de mais de uma chamada (o
  // JSON quebrado pede de novo dentro do MESMO prazo).
  if (fim == null) fim = relogio() + prazoTotalMs;
  let ultimoMotivo = 'nenhuma tentativa coube no prazo';
  let ultimaResposta = null;

  for (let i = 0; i < plano.length; i++) {
    const { timeoutMs, thinking } = plano[i];
    const tentativa = i + 1;
    const resta = fim - relogio();
    if (resta < minimoMs) {
      log.error(`[Gemini] ${rotulo}: tentativa ${tentativa} não coube no prazo (${Math.round(resta / 1000)}s).`);
      break;
    }
    const limite = Math.min(timeoutMs, resta);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limite);
    const inicio = relogio();
    try {
      const resposta = await chamar({ thinking, signal: controller.signal });
      const ms = relogio() - inicio;
      log.log(`[Gemini] ${rotulo}: respondeu ${resposta.status} em ${ms}ms (tentativa ${tentativa}, thinking ${thinking}).`);
      if (resposta.ok || !ehTransitorio(resposta.status) || tentativa === plano.length) {
        return { resposta, tentativa, thinking, ms };
      }
      ultimaResposta = { resposta, tentativa, thinking, ms };
      ultimoMotivo = `HTTP ${resposta.status}`;
      await esperar(pausaMs * tentativa);
    } catch (erro) {
      ultimoMotivo = erro.name === 'AbortError'
        ? `timeout de ${Math.round(limite / 1000)}s`
        : (erro.cause?.code || erro.message);
      log.error(`[Gemini] ${rotulo}: tentativa ${tentativa} falhou (${ultimoMotivo}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  // Um 5xx que se repetiu até o prazo acabar: devolve o último, para o
  // erro dizer o que o Google respondeu.
  if (ultimaResposta) return ultimaResposta;
  throw new Error(`Falha de rede ao chamar o Gemini (${rotulo}): ${ultimoMotivo}`);
}

module.exports = {
  PLANO,
  PRAZO_TOTAL_MS,
  ehTransitorio,
  chamarComTentativas,
};
