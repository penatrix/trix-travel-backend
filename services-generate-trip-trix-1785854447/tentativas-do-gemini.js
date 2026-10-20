// As tentativas da chamada ao Gemini na geração (20/10).
//
// A trip 446 (Finlândia, 14 dias, 17/10) esperou 300s duas vezes e
// falhou, e a pessoa não voltou. Não era tamanho: as 52 gerações que
// deram certo desde 29/09 levaram de 41s a 241s INTEIRAS, com a
// validação dos lugares; os roteiros de 22 e 23 dias, 145s e 125s. O
// modelo travou duas vezes seguidas na mesma entrada.
//
// Daí as três decisões, do Paulo, 20/10:
//
//   - **240s por tentativa**, e não 300: acima de tudo que já deu certo.
//   - **Três tentativas**, e a TERCEIRA com thinking LOW. Pensamento que
//     não termina é a causa mais provável de duas travadas seguidas com a
//     mesma entrada, e repetir com o mesmo nível repete a aposta. O motor
//     continua o Pro; só raciocina menos, e só nesse caso.
//   - **429 e 5xx também tentam de novo**, depois de uma pausa. Em
//     setembro o suggest-cities levou um 503 "high demand"; aqui, um erro
//     desses derrubava o roteiro na hora.
//
// E UM PRAZO para a soma, porque duas coisas cortam a geração em 900s:
// o --timeout do Cloud Run, que mata o processo sem rodar o `catch` (a
// row fica em 'generating' e a cota cobrada), e o coletor do banco
// (`recolher_roteiros_travados`, de minuto em minuto), que marca 'failed'
// e estorna o que passa de 15 minutos -- e aí o roteiro que chegar
// depois é descartado. O JSON quebrado pede de novo (`json-de-novo.js`),
// e cada pedido tem as suas tentativas; sem prazo comum, o pior caso
// seria 2 x 3 x 240s. Com ele, tentativa que não cabe não começa, e a
// de que sobra pouco ganha só o que sobra (a terceira, na prática, fica
// com 210s).
//
//   Cloud Run e coletor do banco    900s
//   prazo do Gemini (este arquivo)  690s, contado do primeiro pedido
//   validação de lugares           ~105s no pior caso
//   escritas no Supabase e folga   ~105s
//
// Mexeu num destes números, refaça a conta.

const PLANO = Object.freeze([
  Object.freeze({ timeoutMs: 240000, thinking: 'MEDIUM' }),
  Object.freeze({ timeoutMs: 240000, thinking: 'MEDIUM' }),
  Object.freeze({ timeoutMs: 240000, thinking: 'LOW' }),
]);

/// O prazo da soma de todas as tentativas, a partir do primeiro pedido.
const PRAZO_TOTAL_MS = 690000;

/// Tentativa com menos que isto pela frente não começa: não daria tempo
/// de um roteiro sair, e só adiaria o aviso de falha.
const MINIMO_POR_TENTATIVA_MS = 60000;

/// A pausa antes de repetir um 429 ou 5xx, por tentativa já feita.
const PAUSA_TRANSITORIA_MS = 5000;

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
