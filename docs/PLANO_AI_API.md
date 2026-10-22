# Plano de Implementação — `ai-extractor-api`

**Versão:** 1.0.10
**Criado em:** 2026-10-21
**Última atualização:** 2026-10-21
**Status:** Em implementação
**Plano macro:** `docs/PLANO_INTEGRACAO_IA_EXTRACAO.md`

---

## Histórico de alterações

| Data | Versão | Alteração |
| --- | --- | --- |
| 2026-10-21 | 1.0.0 | Criação do plano. Define estrutura de pastas espelhando `../../API`, contrato, providers, persistência, scripts e fases. |
| 2026-10-21 | 1.0.1 | Serviço renomeado de `ai-api` para `ai-extractor-api`; este plano passou a viver em `ai-extractor-api/docs/`. |
| 2026-10-21 | 1.0.2 | Porta padrão alterada de 3010 para 5555 (evita conflito com outros serviços locais). |
| 2026-10-21 | 1.0.10 | F7: relatório de rollout (`npm run rollout:report`) sobre os replays, com gates de packs/validade/cobertura shadow/p95; replay passou a registrar `fallbackReason`. Kill switch operacional fica no proxy admin da API. |
| 2026-10-21 | 1.0.9 | F6: replay opt-in (`AI_REPLAY_PATH`) com pack+decisões+shadow; `npm run dataset:build` gera train/valid/test (messages SFT), `test.eval.jsonl` e `stats.json`, com split por marketplace (fallback hash), rótulo humano > shadow > modelo; `training/train_qlora.py` com engine `hf` (Windows/CPU) e `sft` (Linux/GPU), máscara só na resposta e `--merge`. 8 testes novos. |
| 2026-10-21 | 1.0.8 | F5: provider de visão OPCIONAL (`VISION_PROVIDER=off|fake|http`) que reordena as imagens já extraídas por score CLIP/SigLIP antes da heurística (contrato `POST {VISION_HTTP_URL}/score` → `{scores}`); best-effort, nunca cria imagem. HTTP provider passou a usar o id do catálogo quando `LLM_HTTP_MODEL` está vazio. 14 testes novos. |
| 2026-10-21 | 1.0.7 | F4: harness de avaliação offline (`scripts/eval-adjudication.ts`, `npm run eval:adjudication`) com dataset JSONL, comparação por IDs e latência p95; `--mode` permite avaliar `shadow`/`on` com o provider `fake` ou `llamacpp`. |
| 2026-10-21 | 1.0.6 | Terceira rodada de revisão: filtro de ruído por título inteiro (não substring), `missing_title`/`missing_price` corretos, `p=0` preserva `cf`, `assist` respeita `AI_MIN_CONFIDENCE` e nunca descarta (só `on` com confiança alta remove), decisões carregam `source` (heuristic/model), `context` opcional no pack, abort checado pós-load, timeout de load (`LLM_LOAD_TIMEOUT_MS`) com geração invalidada, upsert diário com retry E11000. 36 testes. |
| 2026-10-21 | 1.0.5 | Abstenção do modelo não descarta oferta; shadow grava `shadow` (evidência); modo vivo no `/health`; fila limitada (`LLM_MAX_QUEUE`); unload drena antes de remover. 28 testes. |
| 2026-10-21 | 1.0.4 | Correções da revisão adversarial: fallback preserva decisões determinísticas (só pendentes caem); `AI_ADJ_MODE` aplicado por request (off/shadow/assist/on); `fake` bloqueado em produção; fila + single-flight no provider; abort do cliente cancela inferência; timeout 12000; `needsReview`/`reviewReasons`; stats com `heuristic` e `modelCalls`; body 1mb; 25 testes. |
| 2026-10-21 | 1.0.3 | Adjudicação híbrida: heurísticas resolvem preço/imagem/original e o modelo só decide título ambíguo. Modelo passou a responder LETRAS (A-L) por card, em lotes de 2. `LLM_TIMEOUT_MS`=120000. Corrigido vazamento de sequence do `node-llama-cpp`. Suíte com 20 testes. |

> Toda alteração de arquitetura, endpoint, variável de ambiente ou fase deve ser registrada aqui com data.

---

## 1. Objetivo

Construir o microserviço HTTP que adjudica packs de candidatos de ofertas, com arquitetura espelhada da API Vupia:

- Express 5 + TypeScript + ESM (`NodeNext`), TS estrito.
- Módulos no padrão `controller/service/repository/router/validators`.
- Schemas Mongoose em `src/domain/schemas/tb_*.ts`.
- Acesso a modelo por `src/providers` (desacoplado, múltiplos modelos).
- Configuração centralizada em `src/config/env.ts`.
- Testes com `node:test` + `tsx`, sem modelo real.

---

## 2. Estrutura

```
ai-extractor-api/
├── package.json
├── tsconfig.json
├── tsconfig.test.json
├── .env.example
├── .gitignore
├── scripts/
│   ├── free-port.mjs
│   ├── run-tests.mjs
│   └── download-model.mjs
├── src/
│   ├── server.ts
│   ├── defaultRouter.ts
│   ├── config/
│   │   ├── env.ts
│   │   ├── cors.ts
│   │   └── timezone.ts
│   ├── constants/
│   │   └── prompt.ts
│   ├── domain/schemas/
│   │   ├── tb_aiModels.ts
│   │   ├── tb_aiAdjudications.ts
│   │   └── tb_aiUsage.ts
│   ├── enums/
│   │   └── adjudication.ts
│   ├── exceptions/
│   │   └── ApiError.ts
│   ├── helpers/
│   │   ├── apiResponse.ts
│   │   ├── constantTime.ts
│   │   ├── packHash.ts
│   │   └── safeParseJson.ts
│   ├── middleware/
│   │   ├── error.middleware.ts
│   │   ├── internalAuth.middleware.ts
│   │   └── requestId.middleware.ts
│   ├── modules/
│   │   ├── health/healthRouter.ts
│   │   ├── models/modelController.ts
│   │   ├── models/modelRouter.ts
│   │   ├── models/modelService.ts
│   │   ├── adjudication/adjudicationController.ts
│   │   ├── adjudication/adjudicationRepository.ts
│   │   ├── adjudication/adjudicationRouter.ts
│   │   ├── adjudication/adjudicationService.ts
│   │   └── adjudication/adjudicationValidators.ts
│   ├── providers/
│   │   ├── mongoose.ts
│   │   ├── persistence/
│   │   │   ├── index.ts
│   │   │   ├── mongoPersistence.ts
│   │   │   ├── memoryPersistence.ts
│   │   │   └── types.ts
│   │   └── llm/
│   │       ├── fakeProvider.ts
│   │       ├── grammar.ts
│   │       ├── httpProvider.ts
│   │       ├── index.ts
│   │       ├── llamaCppProvider.ts
│   │       ├── prompt.ts
│   │       └── types.ts
│   ├── types/
│   │   └── adjudication.ts
│   └── models/
│       ├── .gitkeep
│       └── (modelo .gguf)
├── tests/
│   ├── setup.ts
│   ├── unit/
│   └── integration/
└── models/            (opcional: caminho externo configurável)
```

Notas:
- `src/models` guarda o `.gguf` versionado por download, fora do git.
- `AI_MODEL_PATH` pode apontar para qualquer caminho absoluto/relativo.
- `models/` externo é suportado para volumes em produção.

---

## 3. Endpoints

| Método | Rota | Auth | Descrição |
| --- | --- | --- | --- |
| GET | `/api/v1/health` | pública | liveness (sem detalhes sensíveis) |
| GET | `/api/v1/ready` | interna | readiness (modelo carregado?) |
| POST | `/api/v1/adjudicate` | interna | adjudica um pack |
| GET | `/api/v1/models` | interna | lista modelos configurados e estado |
| POST | `/api/v1/models/:modelId/load` | interna | carrega modelo |
| POST | `/api/v1/models/:modelId/unload` | interna | descarrega modelo |
| GET | `/api/v1/stats` | interna | métricas agregadas do dia |

Autenticação interna: header `x-internal-key`, comparação em tempo constante.
`AI_INTERNAL_KEY` vazio em `ENVIRONMENT=dev|TEST` = auth desabilitada (com aviso).
Fora de dev/teste, chave vazia derruba o boot (fail-closed).

---

## 4. Variáveis de ambiente

| Variável | Default | Descrição |
| --- | --- | --- |
| `PORT` | `5555` | porta HTTP |
| `HOST` | `127.0.0.1` | bind (nunca `0.0.0.0` por padrão) |
| `ENVIRONMENT` | `` | `dev` / `TEST` / `production` |
| `TRUST_PROXY` | `` | hops confiáveis |
| `CORS_ORIGINS` | `` | allowlist (vazio = sem CORS) |
| `AI_INTERNAL_KEY` | `` | chave do header interno |
| `AI_PERSISTENCE` | `memory` | `memory` / `mongo` |
| `MONGO_URI` | `` | URI completa (tem prioridade) |
| `MONGO_USER`, `MONGO_PASSWORD`, `MONGO_URL`, `MONGO_ENVIRONMENT` | `` | composição estilo Atlas |
| `LLM_PROVIDER` | `fake` | `fake` / `llamacpp` / `http` |
| `LLM_TIMEOUT_MS` | `12000` | orçamento total por pack (soma dos lotes) |
| `LLM_LOAD_TIMEOUT_MS` | `60000` | teto para carregar o GGUF (load travado não ocupa a fila) |
| `LLM_CHUNK_SIZE` | `2` | cards por chamada ao modelo (0.5B não emite N itens) |
| `LLM_MAX_QUEUE` | `8` | requisições aguardando o modelo (acima disso: 503) |
| `LLM_MAX_CARDS` | `30` | limite de cards por pack |
| `LLM_MAX_TOKENS` | `700` | teto de geração |
| `AI_MODEL_ID` | `qwen2.5-0.5b-instruct-q4_k_m` | id lógico |
| `AI_MODEL_PATH` | `src/models/qwen2.5-0.5b-instruct-q4_k_m.gguf` | arquivo GGUF |
| `AI_MODEL_CONTEXT` | `2048` | contexto |
| `AI_MODEL_THREADS` | `` | threads (vazio = auto) |
| `AI_MODELS_JSON` | `` | catálogo extra `[{id,provider,path,contextSize}]` |
| `AI_MODEL_MAP_JSON` | `` | mapa de aliases por marketplace |
| `AI_STORE_PACKS` | `false` | persistir pack completo |
| `AI_ADJ_MODE` | `off` | lido por request: `off`/`shadow`/`assist`/`on` (kill switch) |
| `AI_MIN_CONFIDENCE` | `0.6` | abaixo disso: `needsReview`; no `assist` a escolha do modelo não prevalece; no `on` só descarta `p=0` acima do limiar |
| `VISION_PROVIDER` | `off` | visão opcional (F5): `off` / `fake` / `http`; lido por request |
| `VISION_HTTP_URL` | `` | base do serviço CLIP/SigLIP (`POST /score`) |
| `VISION_HTTP_API_KEY` | `` | Bearer opcional do serviço de visão |
| `VISION_TIMEOUT_MS` | `1500` | teto por card com mais de 1 imagem |
| `VISION_MIN_SCORE` | `0` | score mínimo para reordenar (abaixo disso mantém a ordem) |
| `AI_REPLAY_PATH` | `` | F6: JSONL de replays para o dataset (vazio = desligado; contém dados de produto) |
| `AI_REPLAY_MAX_BYTES` | `50000000` | teto do arquivo de replay; ao atingir, a captura pausa |

---

## 5. Providers de modelo

Interface única:

```ts
interface LlmProvider {
  readonly name: string
  readonly modelId: string
  readonly modelVersion: string
  isReady(): Promise<boolean>
  complete(input: CompletionInput): Promise<CompletionResult>
  dispose(): Promise<void>
}
```

Implementações:
- `fakeProvider`: determinístico, usado em testes e em `LLM_PROVIDER=fake`.
- `llamaCppProvider`: `node-llama-cpp`, carregamento preguiçoso, gramática GBNF, abort por `signal`.
- `httpProvider`: endpoint OpenAI-compatible (llama.cpp server, vLLM, GPU remota).

Registro em `providers/llm/index.ts` resolve por `provider` + `modelId`, mantém instâncias e expõe `listModels()`. O `httpProvider` usa `LLM_HTTP_MODEL`; vazio cai para o id lógico do modelo.

### 5.1 Visão (F5, opcional)

`providers/vision` expõe `VisionProvider` (`score({text, images})` → `number[]`):
- `httpVisionProvider`: `POST {VISION_HTTP_URL}/score` com `{text, images}` → `{scores}` (CLIP/SigLIP+FastAPI, GPU remota).
- `fakeVisionProvider`: determinístico para testes.
- `off` (default): nenhuma chamada de rede.
A reordenação (`modules/adjudication/visionRanking.ts`) só altera a ordem dos candidatos de imagem já extraídos; falha/timeout mantém a ordem determinística.

---

## 6. Pipeline de adjudicação (híbrido)

1. Validar pack (shape, limites, IDs únicos, moeda, cents).
2. Calcular `packHash` e comparar com o informado (quando presente).
2.1. **Visão (opcional)**: com `VISION_PROVIDER != off`, reordena as imagens de cada card (best-effort) antes da heurística.
3. **Heurísticas determinísticas** (`adjudicationHeuristics.ts`):
   - preço atual BRL único (centavos distintos) → escolhido;
   - preço ausente/estrangeiro → `missing_price`/`currency_mismatch`;
   - >1 preço atual BRL distinto → `ambiguous_price`;
   - imagem: primeira; ausente → `missing_image`;
   - título: descarta ruído (`patrocinado`, `frete grátis`, `cupom`, ...);
     - 0 plausíveis → `not_a_product`;
     - 1 plausível → resolve sem modelo;
     - 2+ plausíveis → **pendente** para o modelo;
   - original: BRL com `cents > price.cents`, maior valor.
4. Pendentes vão ao modelo em lotes de `LLM_CHUNK_SIZE` (2), com mini-pack
   (apenas títulos plausíveis + preço/imagem já escolhidos). O modelo responde
   `{"d":[{"c":1,"p":1,"t":"A","pr":"A","o":"-","i":"A","cf":90}]}` — LETRAS,
   nunca IDs/textos. Preço/imagem/original do modelo são ignorados.
5. Parsear e revalidar contra o mini-pack (letra -> candidato existente).
6. Mesclar: decisão do modelo só substitui `titleId`/produto; o resto vem da
   heurística. Sem decisão válida -> título mais longo com `confidence=0.4`.
7. Serializar resposta canônica.
8. Persistir metadados (nunca valores de preço/título por padrão).

Erro do provider (passos 4-5): decisões já resolvidas são PRESERVADAS; apenas os cards pendentes recebem título determinístico com `confidence=0.4`, `needsReview=true`, `reviewReasons=["model_fallback"]` e `mode="fallback"` + `fallbackReason`. Nenhum card é perdido.

---

## 7. Testes

- Unitários: `packHash`, validação de IDs/moeda, parser da resposta do modelo, heurísticas híbridas.
- Integração: rota `adjudicate` com `fake` (válido, inválido, timeout, pack grande), auth, health, models.
- Sem download de modelo e sem chamada de rede.

Comandos:

```
npm run typecheck
npm test
npm run dev
npm run eval:adjudication            # avaliação offline (fake por padrão)
npm run eval:adjudication -- --mode shadow
npm run dataset:build                # F6: replays → data/dataset (treino)
npm run rollout:report               # F7: gates do shadow sobre os replays
```

Treino (F6): detalhes em `training/README.md`. O serviço é testado no Windows e
roda no Ubuntu; o treino aceita ambos (engine `hf` no Windows/CPU, `sft` no
Linux/GPU). O GGUF final usa o mesmo `node-llama-cpp`.

---

## 8. Fases

| Fase | Entrega | Data | Status |
| --- | --- | --- | --- |
| F1.1 | Scaffold (config, exceptions, helpers, middleware) | 2026-10-21 | Concluída |
| F1.2 | Providers LLM + persistência | 2026-10-21 | Concluída |
| F1.3 | Schemas + módulos + server | 2026-10-21 | Concluída |
| F1.4 | Testes + typecheck | 2026-10-21 | Concluída |
| F1.5 | Download do modelo base | 2026-10-21 | Concluída (script; download manual se necessário) |
| F2 | Integração na API Vupia | — | Pendente |
| F3 | Front | — | Pendente |
| F4 | Eval/shadow | — | Pendente |

---

## 9. Critérios de aceite

1. `npm run typecheck` sem erros.
2. `npm test` verde, sem rede e sem modelo.
3. `POST /api/v1/adjudicate` rejeita pack inválido com 400 estruturado.
4. Decisão com ID inexistente é descartada, não propagada.
5. Timeout do provider retorna 200 com `mode="fallback"`.
6. `GET /api/v1/health` não expõe caminho de modelo nem segredos.
7. Nenhum `0.0.0.0` como bind padrão.
