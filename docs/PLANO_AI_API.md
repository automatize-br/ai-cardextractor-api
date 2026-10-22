# Plano de Implementação — `ai-extractor-api`

**Versão:** 1.0.1
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
| `PORT` | `3010` | porta HTTP |
| `HOST` | `127.0.0.1` | bind (nunca `0.0.0.0` por padrão) |
| `ENVIRONMENT` | `` | `dev` / `TEST` / `production` |
| `TRUST_PROXY` | `` | hops confiáveis |
| `CORS_ORIGINS` | `` | allowlist (vazio = sem CORS) |
| `AI_INTERNAL_KEY` | `` | chave do header interno |
| `AI_PERSISTENCE` | `memory` | `memory` / `mongo` |
| `MONGO_URI` | `` | URI completa (tem prioridade) |
| `MONGO_USER`, `MONGO_PASSWORD`, `MONGO_URL`, `MONGO_ENVIRONMENT` | `` | composição estilo Atlas |
| `LLM_PROVIDER` | `fake` | `fake` / `llamacpp` / `http` |
| `LLM_TIMEOUT_MS` | `3500` | orçamento por pack |
| `LLM_MAX_CARDS` | `30` | limite de cards por pack |
| `LLM_MAX_TOKENS` | `700` | teto de geração |
| `AI_MODEL_ID` | `qwen2.5-0.5b-instruct-q4_k_m` | id lógico |
| `AI_MODEL_PATH` | `src/models/qwen2.5-0.5b-instruct-q4_k_m.gguf` | arquivo GGUF |
| `AI_MODEL_CONTEXT` | `2048` | contexto |
| `AI_MODEL_THREADS` | `` | threads (vazio = auto) |
| `AI_MODELS_JSON` | `` | catálogo extra `[{id,provider,path,contextSize}]` |
| `AI_MODEL_MAP_JSON` | `` | mapa de aliases por marketplace |
| `AI_STORE_PACKS` | `false` | persistir pack completo |
| `AI_ADJ_MODE` | `off` | espelho do modo (informativo) |

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

Registro em `providers/llm/index.ts` resolve por `provider` + `modelId`, mantém instâncias e expõe `listModels()`.

---

## 6. Pipeline de adjudicação

1. Validar pack (shape, limites, IDs únicos, moeda, cents).
2. Calcular `packHash` e comparar com o informado (quando presente).
3. Montar prompt compacto (somente IDs + textos normalizados).
4. Chamar provider com gramática estática e `AbortSignal.timeout`.
5. Parsear JSON compacto.
6. Revalidar cada decisão contra o pack (IDs, moeda, original > atual).
7. Serializar resposta canônica.
8. Persistir metadados (nunca valores de preço/título por padrão).

Qualquer erro nos passos 3-6 → `mode="fallback"`, `decisions=[]`, HTTP 200.

---

## 7. Testes

- Unitários: `packHash`, validação de IDs/moeda, parser da resposta do modelo, prompt.
- Integração: rota `adjudicate` com `fake` (válido, inválido, timeout, pack grande), auth, health, models.
- Sem download de modelo e sem chamada de rede.

Comandos:

```
npm run typecheck
npm test
npm run dev
```

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
