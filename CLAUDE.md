# Trix — Contexto do Projeto

Este arquivo dá contexto que não pode ser deduzido lendo o código.
Arquitetura, dependências e layout de diretórios: leia o repositório.

## O produto

App de planejamento de viagens com IA. Gera roteiros hiper-personalizados
com **especificidade brutal**: nomes reais de lugares, custos estimados,
logística exata. O oposto de "visite um café local bem avaliado".

Público: viajantes independentes brasileiros, média/alta renda, que fogem
de turismo de massa e valorizam o próprio tempo.

Empresa de tecnologia, **não** agência de viagens. Distinção deliberada e
juridicamente relevante (CNAE de tecnologia, fora do CADASTUR). Nunca
descreva o produto como agência, operadora ou serviço de turismo.

## Idioma

**Todo texto visível ao usuário é pt-BR.** Sem exceção.

Existe um bug conhecido e recorrente de mistura de idiomas — strings em
inglês vazando na interface, e variáveis combinadas sendo traduzidas de
forma inconsistente. Ao tocar em qualquer tela, verifique as strings
daquela tela. Se encontrar inglês, sinalize.

## Paleta oficial

Use estes valores. Qualquer cor fora desta lista é dívida técnica.

| Token | HEX | Uso |
|---|---|---|
| Blue Trix | `#304FFE` | Primária, CTAs |
| Teal Trix | `#00D4C5` | Secundária, sucesso |
| Coral Trix | `#FF5963` | Alerta, destaque |
| Chumbo | `#14181B` | Texto principal |
| Cinza Escuro | `#57636C` | Texto secundário |
| Gelo | `#F1F4F8` | Fundo principal |
| Branco | `#FFFFFF` | Fundo secundário |

Nunca use preto puro (`#000000`) em texto. Chumbo existe por isso:
legibilidade sem cansar a vista em roteiros longos.

O app hoje está visualmente fragmentado e passa por redesign completo.
Ao criar UI nova, use os tokens acima e componentes existentes. Não
introduza novas variantes visuais sem necessidade.

## Regras de IA e alucinação

O motor de roteiros é **Gemini 3.1 Pro**. O "me surpreenda" e as trocas
de atividade usam **Gemini Flash**, por custo.

Princípios inegociáveis:

1. **A IA nunca gera coordenadas de GPS.** Ela devolve strings de busca
   cirúrgicas (Nome + Cidade + País), que abrem via URL Scheme no Google
   Maps do dispositivo. Geolocalização é responsabilidade do Google, não
   do modelo. Isso é arquitetural, não preferência.
2. **Lugares fechados são o pior bug do produto.** Já aconteceu em teste.
   Toda sugestão deve passar por validação de horário e status via Google
   Maps antes de chegar ao usuário.
3. **Dados contextuais devem ser específicos da cidade**, não genéricos do
   país. Já erramos voltagem de tomada por assumir padrão nacional.
4. **Preços precisam declarar se são por pessoa ou totais.** Ambiguidade
   aqui já confundiu usuários.
5. Tags e vibes de viagem devem ser interpretadas literalmente. Termos
   como "maratonista" já geraram interpretações erradas pelo modelo.

Custo importa: a operação é bootstrap. Prefira atividades de backup em
cache a novas chamadas de API. Evite verbosidade no prompt.

## Armadilhas conhecidas

- **Estouro de MAX_TOKENS** quebrava o JSON em roteiros longos. Roteiros
  são limitados por duração por causa disso. Não remova a trava sem
  reavaliar o limite de tokens.
- **Falha de job silenciosa**: quando a geração falha, o usuário precisa
  de retorno claro. Nunca deixe uma row em estado "generating" órfã.
- **Exclusão é permanente** por conformidade com LGPD. Não implemente
  lixeira sem revisar isso.
- **Fluxo de conta**: o onboarding é opcional. Quem já tem conta precisa
  conseguir logar direto, sem repetir preenchimento de dados.
- Não revele, na tela de recuperação de senha, se um e-mail já está
  cadastrado.

## Convenções de produto

- **Home** mostra a viagem atual ou a próxima. **Minhas Viagens** é o
  histórico completo e centro de controle de orçamento. São telas com
  propósitos distintos — não as faça convergir.
- Toda tela precisa tratar quatro estados: carregando, vazio, erro e
  sucesso.
- Ações destrutivas ou irreversíveis exigem confirmação ativa.
- Densidade vertical é inimiga: o usuário precisa alcançar o CTA. Prefira
  abas ou seções expansíveis a empilhar informação.

## O que NÃO fazer

- Não use CNAE, linguagem ou posicionamento de agência de viagens.
- Não gere coordenadas via LLM.
- Não introduza cores, fontes ou espaçamentos fora dos tokens.
- Não adicione dependências pesadas sem justificar — a operação é enxuta.
- Não escreva copy em inglês.

## A confirmar

<!-- Atualize esta seção conforme as decisões forem tomadas. -->

- Data de lançamento da V1 pública: em revisão.
- Convenções de código da stack nova (pós-FlutterFlow): a definir.
- Naming/rebranding: em avaliação.

## Notas específicas deste repositório (serviços Cloud Run)

- As 5 pastas `services-*` são cópias idênticas do mesmo `index.js`/
  `package.json` — cada serviço no Cloud Run usa uma função diferente
  como ponto de entrada. Qualquer correção precisa ser replicada nas 5
  pastas manualmente (não há um módulo compartilhado ainda).
- `generateTrip` e `generateBrainstorming` são acionados por Webhooks do
  Supabase (autenticados via segredo compartilhado no header
  `x-webhook-secret`), não pelo app diretamente.
- `searchPlaces`, `generateMicroActivity` e `updateTravelerMemory` são
  chamados pelo app com o JWT do Supabase no header `Authorization`.
  `searchPlaces` aceita chamadas sem token (usado no funil pré-cadastro),
  mas valida quando um token vem presente.
