// O contrato entre os seis serviços e a tabela `eventos`.
//
// =====================================================================
// POR QUE ISTO É VARREDURA DE FONTE, E NÃO TESTE DE VERDADE
// =====================================================================
//
// Nenhum `index.js` deste repositório carrega localmente: eles dependem
// de `@supabase/supabase-js`, e `node_modules` não é versionado (menos
// no update-memory, por acidente). Então não dá para invocar um handler
// e conferir a linha que ele grava.
//
// O que dá para conferir é o texto. As propriedades abaixo são
// exatamente as que já foram quebradas neste repositório e que nada
// mais pega:
//
//   - **um serviço novo esquecer de registrar.** Foi o que aconteceu
//     com o search-places, que gastou Places por meses sem nunca contar
//     uma chamada.
//   - **registrar só o caminho feliz.** Era o estado até 21/09: falha
//     não deixava rastro, e as nove primeiras da história do produto só
//     apareceram por resgate manual do Cloud Logging.
//   - **o nome antigo sobrevivendo numa cópia.** Os cinco `index.js`
//     já carregaram quatro handlers mortos por meses, todos parecendo
//     código válido.
//
// Falha aqui não é "o teste está chato": é um serviço que vai parar de
// contar em produção sem avisar ninguém.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');

/// Os seis serviços e o tipo de evento que cada um grava.
///
/// A lista é escrita à mão de propósito: serviço novo só entra aqui por
/// decisão de alguém, e é justamente isso que faz o teste avisar quando
/// alguém cria um serviço e esquece de contar o que ele gasta.
const SERVICOS = [
  ['services-generate-trip-trix-1785854447', 'geracao_roteiro'],
  ['services-brainstorming-destination-1786628423', 'brainstorming'],
  ['services-generate-micro-activity-1785854365', 'troca_atividade'],
  ['services-classify-conflicts', 'emenda_restricao'],
  ['services-update-memory-1785852020', 'memoria_viajante'],
  ['services-search-places-trix-1785854528', 'busca_lugares'],
];

function fonteDo(servico) {
  return fs.readFileSync(path.join(RAIZ, servico, 'index.js'), 'utf8');
}

/// Onde começa o tratamento de erro do handler.
///
/// O `catch` do handler é o ÚLTIMO recuado em dois espaços: os de
/// dentro (o `verifySupabaseAuth`, o `fetchGemini`, os dois do estorno)
/// ou estão mais fundo ou vêm antes. Procurar só por `} catch` pegava o
/// `catch (dbError)` aninhado no fim do generate-trip, e o teste
/// concluía que o handler não registrava falha quando registrava.
function partesDoArquivo(fonte) {
  const marca = fonte.lastIndexOf('\n  } catch ');
  assert.notEqual(marca, -1, 'handler sem catch no nível do corpo');
  return { antes: fonte.slice(0, marca), depois: fonte.slice(marca) };
}

describe('todo serviço registra o que gasta', () => {
  for (const [servico, tipo] of SERVICOS) {
    describe(servico, () => {
      const fonte = fonteDo(servico);

      test('importa o registrador do lugar certo', () => {
        assert.match(
          fonte,
          /require\('\.\/registra-evento'\)/,
          'o require tem que ser `./registra-evento` -- o arquivo chega ' +
            'na pasta por cópia do cloudbuild, nunca por caminho relativo ' +
            'para fora dela, que o `pack` não enxerga',
        );
      });

      test('não sobrou nada do nome antigo', () => {
        // A `token_usage` foi derrubada. Uma chamada sobrevivente
        // gravaria numa tabela que não existe -- em silêncio, porque o
        // registrador nunca lança.
        assert.doesNotMatch(fonte, /registrarToken|registra-token|token_usage/);
      });

      test(`grava '${tipo}' no caminho feliz`, () => {
        const { antes } = partesDoArquivo(fonte);
        assert.match(antes, new RegExp(`tipo: '${tipo}'`));
      });

      test('grava também quando dá erro', () => {
        // Esta é a propriedade que mais custou: até 21/09 nenhum
        // serviço registrava falha, e o gasto de uma geração que
        // quebra depois do Gemini é real -- a entrada já foi cobrada.
        const { depois } = partesDoArquivo(fonte);
        assert.match(
          depois,
          /registrarEvento\(/,
          'o bloco de erro deste handler não registra evento nenhum',
        );
        assert.match(
          depois,
          /status: statusDoErro\(/,
          'erro e timeout têm que ser distinguidos por `statusDoErro`: ' +
            'erro pede conserto de código, timeout pede folga no teto',
        );
      });

      test('nenhum registro segura a resposta do usuário', () => {
        // `await registrarEvento` transformaria contabilidade em etapa
        // do caminho do usuário: banco lento viraria roteiro lento, e
        // banco fora viraria roteiro perdido.
        assert.doesNotMatch(fonte, /await\s+registrarEvento/);
      });
    });
  }
});

describe('quem chama o Google conta a chamada', () => {
  // Em setembro o Places passou a custar quase o mesmo que o Gemini.
  // Estes três são os que falam com ele.
  for (const servico of [
    'services-generate-trip-trix-1785854447',
    'services-generate-micro-activity-1785854365',
    'services-classify-conflicts',
    'services-search-places-trix-1785854528',
  ]) {
    test(servico, () => {
      // Com dois-pontos ou como atalho de objeto -- o generate-trip
      // passa a variável de mesmo nome.
      assert.match(fonteDo(servico), /chamadasPlaces[,:]/);
    });
  }
});

describe('o cloudbuild leva o módulo para dentro da imagem', () => {
  // O contexto do `pack` é a pasta do serviço (`--path=.`), então nada
  // da raiz entra na imagem. Sem o passo de cópia o build fica VERDE e
  // a revisão quebra em runtime, no require -- que é o modo de falha
  // mais caro deste repositório, porque parece sucesso.
  const DONO = 'services-generate-trip-trix-1785854447';

  for (const [servico] of SERVICOS) {
    if (servico === DONO) continue;
    test(servico, () => {
      const yaml = fs.readFileSync(
        path.join(RAIZ, servico, 'cloudbuild.yaml'),
        'utf8',
      );
      assert.match(yaml, /id: copia-registra-evento/);
      assert.match(yaml, new RegExp(`${DONO}/registra-evento\\.js`));
      assert.match(yaml, new RegExp(`${servico}/registra-evento\\.js`));

      // E o `pretest` copia da MESMA origem, senão o que o teste local
      // exercita não é o que roda em produção.
      const pkg = JSON.parse(
        fs.readFileSync(path.join(RAIZ, servico, 'package.json'), 'utf8'),
      );
      assert.match(pkg.scripts?.pretest ?? '', /registra-evento\.js/);
    });
  }
});
