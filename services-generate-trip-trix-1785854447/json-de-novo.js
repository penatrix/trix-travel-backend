// O JSON quebrado pede de novo, uma vez (15/10).
//
// O `responseMimeType: "application/json"` de 14/10 não bastou: a trip
// 424 (Lisboa, Sintra e Porto, 15/10) falhou com o mesmo "Expected ','
// or '}' after property value" da 393, no começo do texto, e não por
// corte de tamanho. A mesma entrada gerada de novo saiu certa. Então o
// conserto é pedir outra vez, e só quando o problema é o JSON: erro da
// API, timeout e MAX_TOKENS lançam como antes, porque repetir não muda
// nenhum deles e dobraria a espera.
//
// Uma vez só. Duas falhas seguidas com a mesma entrada dizem que o
// problema não é sorte, e a pessoa precisa do aviso de falha, não de um
// terceiro minuto de espera.

/**
 * Roda `pedir`, e de novo uma vez se ele lançar `SyntaxError`
 * (o `JSON.parse`). `pedir(tentativa)` recebe 1 ou 2.
 *
 * `aoRepetir(erro)` avisa antes da segunda, para quem chama somar o uso
 * da primeira: ela gastou token de verdade.
 */
async function comSegundaTentativa(pedir, aoRepetir = () => {}) {
  try {
    return await pedir(1);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    aoRepetir(e);
    return await pedir(2);
  }
}

/**
 * Soma dois `usageMetadata` do Gemini, campo numérico a campo numérico.
 * O custo da geração lê este objeto, e a tentativa que quebrou no JSON
 * também foi cobrada.
 */
function somarUso(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  const soma = { ...a };
  for (const [chave, valor] of Object.entries(b)) {
    if (typeof valor === 'number' && typeof soma[chave] === 'number') {
      soma[chave] += valor;
    } else if (!(chave in soma)) {
      soma[chave] = valor;
    }
  }
  return soma;
}

module.exports = { comSegundaTentativa, somarUso };
