# Plano — Extração Universal, Spec-Driven e Provider-Agnostic

**Versão:** 2.1.1 (revisada após duas rodadas adversariais)
**Criado em:** 2026-10-26
**Última atualização:** 2026-10-26
**Status:** Aprovado com ressalvas; ressalvas P0/P1 incorporadas; pendente apenas validação de implementação
**Substitui conceitualmente:** o recorte “adjudicação de cards com Qwen local” descrito em `docs/PLANO_AI_API.md`
**ADRs relacionados:** `docs/ADR-005-extracao-hibrida.md`

---

## 0. Resumo executivo

O serviço deixa de ser um “adjudicador de cards” hardcoded e passa a ser um **executor genérico de tarefas de extração/qualificação**, guiado por **perfis declarativos** e por um **catálogo de modelos**. Todo o comportamento que varia por tarefa — schema de entrada, schema de saída, regras, parâmetros, prompt, exemplos, modelo, limites, cache e fallback — vem do `.env`, sem prompt ou regra de negócio específica de cards hardcoded no código.

**Limite explícito do “tudo no `.env`”:** o `.env` controla 100% do que varia por tarefa. A **semântica** de regras determinísticas complexas continua em código versionado (`rulesVersion`), porque transformar isso em uma DSL arbitrária seria outro projeto. Regras simples (obrigatório, enum, faixa, referência a candidato, unicidade) são declarativas no próprio perfil; regras complexas são namespaced (`custom`) e recebem parâmetros do `.env`. Um perfil novo sem regra nova não exige deploy; uma regra nova exige.

O modelo continua sendo usado apenas como **seletor/classificador/extraidor confinado**:

- em perfis de **seleção**, ele só pode devolver referências a candidatos que já existem no input (letra/índice), nunca valores gerados;
- em perfis de **extração**, todo valor extraído precisa vir com **evidência** (`sourceField` + trecho literal), validada no servidor;
- em perfis de **classificação/score**, a saída é enum/faixa fechada;
- qualquer saída fora do schema, com ID inexistente, evidência falsa, item omitido ou campo extra é rejeitada e cai no determinístico ou em revisão.

O cache é tratado em duas camadas:

1. **cache de prompt do provedor** (prefixo estável: instruções + regras + exemplos + schema; input dinâmico no fim);
2. **cache de aplicação** por `profile + versão + modo + modelo + prompt + hash do input`, com single-flight e TTL.

A pasta `src/LLMS/`, o `.gguf`, o provider nativo `node-llama-cpp` e os prompts/gramáticas estáticos serão removidos. Modelos locais continuam suportados via **llama.cpp server / vLLM / Ollama** no protocolo OpenAI-compatible, sem binário nativo dentro do Node.

---

## 1. Problemas do desenho atual

| Problema | Consequência |
| --- | --- |
| Prompt e gramática hardcoded em `src/providers/llm/prompt.ts` e `grammar.ts` | Mudar regra de negócio exige deploy de código; não é possível extrair “ofertas” ou outro domínio sem novo código. |
| Contrato fixo de cards (`titleCandidates`, `priceCandidates`, `imageCandidates`) | O serviço não é reutilizável para outros tipos de extração/qualificação. |
| Provider `llamacpp` nativo e `.gguf` no repositório | Build nativo, peso de repositório, dependência de CPU da VPS, dificulta trocar de modelo. |
| `HttpProvider` só fala OpenAI Chat Completions | Não aproveita structured outputs, prompt caching e semântica de Anthropic/Gemini. |
| Sem cache de aplicação | Packs repetidos (retries, paginação, reprocessamento) chamam o modelo de novo. |
| Sem cache de prompt explícito | O prefixo é reenviado a cada chunk; o custo/latência de entrada não é otimizado. |
| Validação só de cards | Não há mecanismo genérico de grounding/evidência para extração livre. |
| Configuração espalhada entre env e constantes | Não há uma “fonte única” validada no boot. |
| `FakeProvider` parseia o texto do prompt | A suíte depende do formato hardcoded; quebra quando o prompt vem do `.env`. |
| `AI_REPLAY_PATH` grava pack independentemente de `AI_STORE_PACKS` | Resolvido no novo desenho: replay grava só metadados por padrão; pack exige `AI_REPLAY_STORE_PACK=true`. |

---

## 2. Princípios de arquitetura

1. **Spec-driven**: o que extrair, como qualificar e como responder é um `TaskProfile` declarativo.
2. **Provider-agnostic**: o pipeline não conhece OpenAI/Anthropic/Gemini; conhece capacidades (`json_schema`, `grammar`, `prompt_cache`, `vision` etc.).
3. **Mundo fechado**: o modelo não tem ferramentas, web, memória externa nem permissão para inventar valores.
4. **Referência, não geração**: em seleção, a saída é uma referência a candidato existente; em extração, é valor + evidência verificável.
5. **Falha segura**: com `AI_FAIL_OPEN=true` (default), schema inválido, ID inexistente, evidência falsa ou timeout nunca viram 5xx; caem em determinístico/revisão. Com `AI_FAIL_OPEN=false`, falha de modelo retorna 503 explícito (exceto no adaptador legado, que preserva `mode=fallback`).
6. **Cache por construção**: prefixo estável, input canônico, chave determinística, single-flight e TTL.
7. **Configuração validada no boot**: `.env` é a fonte de verdade; erro de config impede subir, com mensagem clara.
8. **Compatibilidade**: `/v1/adjudicate` continua funcionando como adaptador do perfil `cards` até API/FRONT migrarem.
9. **Regras com fronteira clara**: parâmetros e seleção no `.env`; semântica de regras complexas em código versionado (`rulesVersion`).

---

## 3. Arquitetura-alvo

```
API/FRONT
   │  POST /v1/execute  { profile, input, options }
   ▼
ai-extractor-api
   ├─ config/
   │    ├─ env.ts                 # parse + zod + fail-fast
   │    ├─ profiles.ts            # TaskProfile registry (do .env)
   │    ├─ models.ts              # ModelCatalog (do .env)
   │    ├─ schema.ts              # Ajv 2020-12 + meta-schema
   │    └─ aliases.ts             # compatibilidade de env antiga
   ├─ modules/execution/
   │    ├─ executionController.ts
   │    ├─ executionService.ts    # pipeline genérico
   │    ├─ promptBuilder.ts       # prefixo estável + input canônico
   │    ├─ outputValidator.ts     # schema + grounding + regras
   │    └─ legacyAdjudication.ts  # adaptador /v1/adjudicate
   ├─ providers/llm/
   │    ├─ types.ts               # LlmProvider + capabilities
   │    ├─ openaiProvider.ts      # OpenAI
   │    ├─ openaiCompatibleProvider.ts # vLLM, llama.cpp server, Ollama, OpenRouter
   │    ├─ anthropicProvider.ts
   │    ├─ geminiProvider.ts
   │    ├─ fakeProvider.ts
   │    └─ registry.ts
   ├─ cache/
   │    ├─ appCache.ts            # memory LRU | off
   │    ├─ cacheKey.ts            # hash canônico
   │    └─ singleFlight.ts
   └─ modules/adjudication/       # heurísticas existentes, viram “rules” do perfil cards
```

### 3.1 Fluxo de execução

1. Valida `profile` e `input` contra o schema do perfil.
2. Canoniza o input (ordem de chaves/arrays estável) e calcula `inputHash`.
3. Monta a `cacheKey`; consulta cache de aplicação.
4. Executa regras determinísticas do perfil, separando itens já resolvidos e pendentes.
5. Monta o prompt: **prefixo estável** (system + regras + exemplos + schema) + **sufixo dinâmico** (somente itens pendentes).
6. Chama o provider com structured output, limite de tokens, timeout e cache hint.
7. Valida schema, referências, evidência e regras pós-modelo.
8. Aplica confiança/abstenção; resolve pendentes com fallback determinístico.
9. Persiste auditoria (sem pack por padrão), grava cache de aplicação apenas para resultado válido.
10. Responde com `output`, `meta` (modelo, versões, cache, latência, validação).

---

## 4. Conceitos e contratos

### 4.1 `TaskProfile`

Um perfil descreve **uma tarefa**. Exemplos: `cards`, `offers`, `product_attributes`, `lead_qualification`.

```jsonc
{
  "id": "cards",
  "version": "2.0.0",
  "description": "Escolhe título, preço, preço original e imagem de cards de e-commerce",
  "mode": "selection",                 // selection | extraction | classification | score
  "input": {
    "schema": { "type": "object", "...": "..." },
    "collection": "cards",              // default "items"; cards usa "cards"
    "maxItems": 30,
    "maxChars": 50000
  },
  "output": {
    "schema": { "type": "object", "...": "..." },
    "additionalProperties": false
  },
  "prompt": {
    "system": "Você é um extrator...",
    "rules": ["...", "..."],
    "examples": [
      { "input": { "...": "..." }, "output": { "...": "..." } }
    ],
    "userTemplate": "<INPUT>\n{{input}}\n</INPUT>\nResponda apenas o JSON."
  },
  "validation": {
    "grounding": "candidate_ids",      // none | candidate_ids | source_quotes
    "coverage": "exact",               // exact | partial
    "candidateFields": {
      "titleId": "titleCandidates",
      "priceId": "priceCandidates",
      "originalPriceId": "priceCandidates",
      "imageId": "imageCandidates"
    },
    "rules": [
      { "type": "required", "field": "titleId" },
      { "type": "candidate_ref", "field": "titleId", "collection": "titleCandidates" },
      { "type": "candidate_ref", "field": "priceId", "collection": "priceCandidates",
        "filter": { "kind": "current", "currency": "BRL" } },
      { "type": "custom", "name": "original_gt_current", "params": {} },
      { "type": "custom", "name": "unique_current_price", "params": {} }
    ],
    "fallback": "heuristic",           // heuristic | review | reject
    "minConfidence": 0.6
  },
  "rulesVersion": "1",
  "model": {
    "id": "fast",
    "allowedModels": ["fast"],         // allowlist para options.model; default = [id]
    "temperature": 0,
    "maxTokens": 800,
    "timeoutMs": 30000,
    "batchSize": 10,                   // opcional; default AI_BATCH_SIZE
    "structuredOutput": "json_schema"  // opcional; deve ser suportado pelo modelo
  },
  "cache": {
    "appTtlMs": 86400000,
    "promptPrefix": true,
    "storeQuotes": true,
    "maxPromptCacheBlocks": 1
  }
}
```

**Campos obrigatórios:** `id`, `version`, `mode`, `input.schema`, `output.schema`, `prompt.system`, `validation.grounding`, `validation.coverage`, `model.id`, `rulesVersion`.
**Campos proibidos:** funções, expressões JS, `tools`, `web`, `code execution`, URLs de ferramenta.
**Validação no boot:** Zod + meta-schema JSON Schema; erro aponta caminho exato (`profiles[0].output.schema.properties...`).
**Hash:** `profileHash` cobre `input.schema`, `output.schema`, `prompt`, `validation`, `rulesVersion`, `model` e `cache`; qualquer mudança invalida cache.

### 4.2 Modos de perfil

| Modo | Uso | Regra de ouro |
| --- | --- | --- |
| `selection` | escolher entre candidatos (cards, imagens, variantes) | saída só referencia candidato existente (letra/índice); nunca texto/preço/URL gerado |
| `extraction` | extrair entidades/campos de texto/HTML | cada valor exige `evidence.sourceField` (JSON Pointer) + `quote` literal; sem quote válida, rejeita |
| `classification` | rotular item com enum | saída só enum fechado + confiança; sem texto livre |
| `score` | qualificar/ranquear | número em faixa + `ruleHits` opcional; sem justificativa livre obrigatória |

### 4.3 `ModelCatalog`

```jsonc
{
  "id": "fast",
  "version": "gpt-6-luna@2026-10",       // obrigatório; entra na cacheKey
  "provider": "openai",                  // openai | anthropic | gemini | openai-compatible | fake
  "model": "gpt-6-luna",
  "baseUrl": "https://api.openai.com/v1",
  "apiKeyEnv": "OPENAI_API_KEY",         // nome allowlisted; nunca a chave literal
  "structuredOutput": "json_schema",     // json_schema | tool | grammar | json_object | none
  "promptCaching": "auto",               // auto | explicit | off
  "maxContext": 128000,
  "maxOutput": 2048,
  "cost": { "inputPerM": 0.10, "outputPerM": 0.50 }
}
```

O catálogo é global; o perfil pode **restringir** `temperature`, `maxTokens`, `timeoutMs` e `structuredOutput`, mas não pode trocar segredo nem base URL. O boot falha se o perfil pedir uma capacidade que o modelo não declara.

**Segurança de catálogo:**

- `apiKeyEnv` só pode ser `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` ou `AI_LLM_API_KEY` (allowlist).
- `apiKeyEnv: ""` é permitido **somente** para `provider: "openai-compatible"` com `baseUrl` loopback (llama.cpp/Ollama local sem autenticação). Em qualquer outro caso, falha no boot.
- `baseUrl` deve ser `https://` ou loopback (`http://127.0.0.1`, `http://localhost`); outro host exige `AI_ALLOW_INSECURE_LLM_URL=true` explícito.
- `GET /v1/models` nunca devolve `apiKeyEnv`, `baseUrl` ou segredo.

### 4.4 Capacidades por provider

| Provider | Structured output | Prompt cache | Observações |
| --- | --- | --- | --- |
| OpenAI (GPT-6 Luna) | JSON Schema strict (`response_format`) | automático, mínimo ~1024 tokens; `prompt_cache_key` | usar prefixo estável e `store:false` |
| Anthropic (Claude Haiku 5.5) | `output_config.format` JSON Schema ou strict tool use | `cache_control`, mínimo 512 tokens no Haiku 5.5; TTL 5m/1h | cachear o prefixo estável; 1h se tráfego contínuo |
| Gemini (3.5 Flash Lite) | `responseSchema` + `responseMimeType` | implícito; mínimo varia (1k–4k tokens) | manter prefixo grande e comum no início |
| OpenAI-compatible (vLLM, llama.cpp server, Ollama, OpenRouter) | `response_format` JSON Schema; vLLM `structured_outputs`; llama.cpp `json_schema`/`grammar` | depende do servidor; OpenRouter tem sticky routing | local não tem cache de prompt nativo; cache de aplicação cobre |
| Fake | schema fixo determinístico | n/a | testes |

**Decisão:** não gerar GBNF próprio. Para llama.cpp server, enviar `response_format` com JSON Schema (o servidor converte para gramática). Para servidores antigos, usar `grammar` apenas se o perfil declarar `structuredOutput: "grammar"` e o schema for compatível.

### 4.5 Validação de JSON Schema

- Validador fixo: **Ajv 2020-12** (adicionar dependência).
- Subconjunto suportado: `type`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern` (ancorado), `$ref` local (`#/$defs/...`), `anyOf`/`oneOf` simples.
- Proibido: `$ref` remoto, `format` não suportado, `if/then/else`, `patternProperties`, `uniqueItems` (validar no servidor), `not`.
- O meta-schema é validado no boot; schemas incompatíveis com o provider escolhido falham antes de subir.
- `profileHash` e `schemaHash` são calculados sobre o schema canônico.

### 4.6 Referências de candidatos (fecha a saída sem enum dinâmico)

Para `selection`, o schema é **estático** e independente do input:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["items"],
  "properties": {
    "items": {
      "type": "array",
      "maxItems": 30,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["item", "isProduct", "title", "price", "original", "image", "confidence"],
        "properties": {
          "item": { "type": "integer", "minimum": 1, "maximum": 30 },
          "isProduct": { "type": "boolean" },
          "title": { "type": "string", "enum": ["A","B","C","D","E","F","G","H","I","J","K","L","-"] },
          "price": { "type": "string", "enum": ["A","B","C","D","E","F","G","H","I","J","K","L","-"] },
          "original": { "type": "string", "enum": ["A","B","C","D","E","F","G","H","I","J","K","L","-"] },
          "image": { "type": "string", "enum": ["A","B","C","D","E","F","G","H","I","J","K","L","-"] },
          "confidence": { "type": "integer", "minimum": 0, "maximum": 100 }
        }
      }
    }
  }
}
```

- Máximo de 12 candidatos por campo; `A-L`; `-` = ausente.
- O servidor mapeia letra → ID do candidato e valida contra o input.
- Cobertura `exact`: cada item aparece exatamente uma vez; item omitido/repetido rejeita.
- Nada de enum dinâmico no prefixo cacheável.

---

## 5. Configuração única no `.env`

### 5.1 Formato

O `.env` é a fonte de verdade de deploy. Para suportar prompts multilinha sem quebrar dotenv/PM2:

- **Padrão:** `AI_PROFILES_JSON` em uma linha (JSON canônico, chaves ordenadas).
- **Opt-in:** `AI_PROFILES_B64` para evitar problemas de quebra de linha. **Base64 não é criptografia**; é apenas transporte. Prompts continuam legíveis por quem tem o `.env`.
- **Autoria:** arquivos `profiles/*.json` são opcionais e servem apenas para edição/revisão; `npm run config:encode` gera a linha canônica. O runtime lê **somente** o `.env`. Se os dois divergirem, o `.env` vence e o CI falha com `config:diff`.

```dotenv
# Perfis (JSON array em uma linha)
AI_PROFILES_JSON=[{"id":"cards","version":"2.0.0",...}]

# Alternativa para prompts longos/multilinha (não é criptografia)
AI_PROFILES_B64=eyJpZCI6ImNhcmRzIiwidmVyc2lvbiI6IjIuMC4wIiwicHJvbXB0Ijp7InN5c3RlbSI6Ii4uLiJ9fQ==

# Catálogo de modelos
AI_MODELS_JSON=[{"id":"fast","version":"gpt-6-luna@2026-10","provider":"openai","model":"gpt-6-luna","baseUrl":"https://api.openai.com/v1","apiKeyEnv":"OPENAI_API_KEY","structuredOutput":"json_schema","promptCaching":"auto"}]

# Seleção
AI_DEFAULT_PROFILE=cards
AI_DEFAULT_MODEL=fast
# Rollout seguro: ausente = off; produção entra em shadow antes de assist/on.
AI_MODE=off
AI_FAIL_OPEN=true
```

**Ferramentas de apoio (não são fonte de verdade):**

```bash
npm run config:encode -- --file profiles/cards.json   # imprime AI_PROFILES_JSON one-line canônico
npm run config:encode -- --file profiles/cards.json --b64 # imprime AI_PROFILES_B64=...
npm run config:decode -- --env .env                   # imprime JSON formatado para revisão
npm run config:validate                               # valida .env sem subir o servidor
npm run config:diff -- --a .env.old --b .env         # diff semântico de perfis/modelos
npm run profile:new -- --id ofertas --mode extraction # scaffold validável
```

`config:validate` também:

- estima tokens do prefixo estável e avisa se estiver abaixo do mínimo de cache do provider;
- falha se `profile.version` não mudou mas `profileHash` mudou;
- valida placeholders (`{{input}}`, `{{schema}}`, `{{rules}}`, `{{examples}}`);
- valida `apiKeyEnv`, `baseUrl`, capacidades e limites.

### 5.2 Variáveis globais

| Variável | Default | Função |
| --- | --- | --- |
| `AI_CONFIG_VERSION` | `2` | versão do formato de config; migrações explícitas |
| `AI_ENGINE_VERSION` | `2` | versão do motor; entra na cacheKey |
| `AI_DEFAULT_PROFILE` | `cards` | perfil usado por `/v1/execute` sem `profile` |
| `AI_DEFAULT_MODEL` | `fast` | modelo default do catálogo |
| `AI_MODE` | `off` | `off \| shadow \| assist \| on` (kill switch lido por request; ausente = off) |
| `AI_FAIL_OPEN` | `true` | `true`: falha vira fallback 200; `false`: 503 `MODEL_TIMEOUT`/`MODEL_UNAVAILABLE` |
| `AI_TIMEOUT_MS` | `30000` | deadline do `/v1/execute` |
| `AI_LEGACY_TIMEOUT_MS` | `5000` | deadline próprio do `/v1/adjudicate` |
| `AI_MAX_ITEMS` | `30` | limite global de itens por execução |
| `AI_MAX_INPUT_CHARS` | `50000` | proteção de contexto/custo |
| `AI_MAX_OUTPUT_TOKENS` | `2048` | teto de saída |
| `AI_MAX_CONCURRENT_PROVIDER_CALLS` | `4` | concorrência máxima por processo |
| `AI_BATCH_SIZE` | `10` | itens pendentes por chamada (perfil pode reduzir) |
| `AI_LEGACY_BATCH_SIZE` | `2` | lote do adaptador legado; preserva o comportamento atual |
| `AI_TEMPERATURE` | `0` | determinismo |
| `AI_TOP_P` | `1` | determinismo |
| `AI_SEED` | `42` | quando o provider suportar |
| `AI_MAX_RETRIES` | `1` | retry só para 429/5xx/timeout; nunca para schema inválido |
| `AI_LOG_PROMPTS` | `false` | nunca ligar em produção sem retenção |
| `AI_STORE_PACKS` | `false` | privacidade |
| `AI_APP_CACHE` | `memory` | `memory \| off` |
| `AI_APP_CACHE_TTL_MS` | `86400000` | 24h |
| `AI_APP_CACHE_MAX` | `5000` | LRU |
| `AI_APP_CACHE_STORE_QUOTES` | `true` | `true`: cacheia output completo de `extraction` (inclui quotes); `false`: **não cacheia** perfis `extraction` (evita shape diferente entre hit/miss) |

| `AI_PROMPT_CACHE` | `auto` | `auto \| on \| off`; `auto` liga só se o prefixo atingir o mínimo |
| `AI_PROMPT_CACHE_TTL` | `1h` | `5m \| 1h` quando suportado |
| `AI_PROMPT_CACHE_MAX_BLOCKS` | `1` | orçamento de breakpoints por request |
| `AI_ALLOW_INSECURE_LLM_URL` | `false` | permite `http://` não-loopback |
| `AI_DEBUG` | `false` | logs de diagnóstico sem prompt |
| `AI_REPLAY_PATH` | vazio | replay opt-in; vazio = nada; setado = grava metadados (sem pack) |
| `AI_REPLAY_STORE_PACK` | `false` | opt-in explícito para incluir o pack no replay; não herda `AI_STORE_PACKS` |
| `AI_REPLAY_MAX_BYTES` | `50000000` | limite do replay |
| `VISION_VERSION` | vazio | versão do modelo de visão; entra na cacheKey quando `VISION_PROVIDER != off` |

**Precedência:** global é default; perfil sobrescreve; limite global é teto. `AI_MIN_CONFIDENCE` (legado) é o default de `validation.minConfidence`; o perfil vence. Se `VISION_PROVIDER != off` e `VISION_VERSION` estiver vazio, o boot falha; sem versão não há invalidação de cache confiável.

### 5.3 Compatibilidade com variáveis atuais

| Antigo | Novo | Ação |
| --- | --- | --- |
| `LLM_PROVIDER` | `AI_MODELS_JSON[].provider` / `AI_DEFAULT_MODEL` | alias; `llamacpp` derruba o boot com mensagem de migração |
| `LLM_HTTP_BASE_URL` | `AI_MODELS_JSON[].baseUrl` | alias |
| `LLM_HTTP_API_KEY` | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `AI_LLM_API_KEY` | chave literal antiga: copiar para `AI_LLM_API_KEY` no `.env` e usar `apiKeyEnv:"AI_LLM_API_KEY"`; o boot avisa e nunca aceita chave literal no catálogo |
| `LLM_HTTP_MODEL` | `AI_MODELS_JSON[].model` | alias |
| `LLM_TIMEOUT_MS` | `AI_TIMEOUT_MS` / `AI_LEGACY_TIMEOUT_MS` | alias |
| `LLM_LOAD_TIMEOUT_MS` | — | removido; HTTP provider não carrega modelo |
| `LLM_CHUNK_SIZE` | `AI_LEGACY_BATCH_SIZE` | alias no adaptador legado; `AI_BATCH_SIZE` é o default do `/v1/execute` |
| `LLM_MAX_QUEUE` | `AI_MAX_CONCURRENT_PROVIDER_CALLS` | alias |
| `LLM_MAX_CARDS` | `AI_MAX_ITEMS` | alias |
| `LLM_MAX_TOKENS` | `AI_MAX_OUTPUT_TOKENS` | alias |
| `LLM_TEMPERATURE` | `AI_TEMPERATURE` | alias |
| `LLM_DEBUG` | `AI_DEBUG` | alias |
| `LLM_DEBUG_PROMPT` | `AI_LOG_PROMPTS` | alias; default `false` |
| `AI_MODEL_ID` | `AI_DEFAULT_MODEL` | alias |
| `AI_MODEL_VERSION` | `AI_MODELS_JSON[].version` | alias |
| `AI_MODEL_PATH` | — | removido; boot falha se presente |
| `AI_MODEL_CONTEXT` | `AI_MODELS_JSON[].maxContext` | alias |
| `AI_MODEL_THREADS` | — | removido |
| `AI_MODELS_JSON` (formato antigo com `path`/`contextSize`) | formato novo | boot falha com mensagem de migração; sem parse ambíguo |
| `AI_ADJ_MODE` | `AI_MODE` | alias; lido por request |
| `AI_ADJ_TIMEOUT_MS` | `AI_LEGACY_TIMEOUT_MS` | alias |
| `AI_MIN_CONFIDENCE` | `validation.minConfidence` | default global; perfil vence |
| `PACK_VERSION` / `PROMPT_VERSION` | `profile.version` / `promptHash` | mantidos só no adaptador legado |
| `VISION_*` | mantidos | se ativo, `VISION_VERSION` e `minScore` entram na cacheKey |
| `AI_REPLAY_*` | mantidos | opt-in; pack só com `AI_REPLAY_STORE_PACK=true`; não herda `AI_STORE_PACKS` |

**Regra:** se antiga e nova existirem, a nova vence e o boot emite `warn` com a chave antiga (sem valor). Config antiga incompatível falha com mensagem acionável.

---

## 6. Prompt e cache

### 6.1 Layout do prompt

```
[PREFIXO ESTÁVEL — cacheável]
system: papel, invariantes, proibição de inventar, regra de abstenção
rules: regras determinísticas em texto (sem dados do request)
examples: poucos exemplos fixos (input/output)
schema: JSON Schema de saída (estável)
legenda: como ler candidatos (A, B, C...)

[SUFIXO DINÂMICO — não cacheável]
input canônico do request (somente itens pendentes)
instrução final curta: "Responda apenas o JSON do schema."
```

Regras:

- Nada de timestamp, requestId, UUID, nome de usuário, preço volátil ou ordem não determinística no prefixo.
- Chaves de objeto em ordem canônica; **arrays preservam a ordem** (ordem é semântica e entra no `inputHash`). `stableStringify` não ordena arrays.
- Exemplos fixos; não sortear exemplos por request.
- Um único system prompt por perfil/versão; mudanças incrementam `profile.version` e o hash do prompt.
- `userTemplate` só pode usar placeholders permitidos: `{{input}}`, `{{schema}}`, `{{rules}}`, `{{examples}}`. Placeholders desconhecidos falham no boot.
- **Prompt injection:** o input é dado não confiável. O `userTemplate` deve delimitar o input (`<INPUT>`...`</INPUT>`) e o system deve declarar que instruções dentro do input não são comandos. Nunca concatenar HTML cru sem envelope; remover/escapar delimitadores conflitantes.

### 6.2 Cache de prompt do provider

| Provider | Como habilitar | Chave/escopo |
| --- | --- | --- |
| Anthropic | `cache_control` no bloco do prefixo estável; `ttl: "1h"` se tráfego contínuo | prefixo idêntico; mínimo 512 tokens (Haiku 5.5) |
| OpenAI | automático; enviar `prompt_cache_key` estável por perfil/versão | prefixo ≥1024 tokens; mesmo modelo/provider |
| Gemini | implícito; prefixo comum no início | mínimo varia; `usage.total_cached_tokens` |
| OpenRouter | `session_id`/`prompt_cache_key` para sticky routing | mesmo provider por até 10 min de inatividade |
| vLLM/llama.cpp/Ollama | geralmente sem cache de prompt | cache de aplicação |

**Política:** `AI_PROMPT_CACHE=auto` só envia hints se o prefixo estimado atingir o mínimo do provider. Não inflar prompt artificialmente para “ganhar cache”; medir `cached_tokens` e decidir. `AI_PROMPT_CACHE_MAX_BLOCKS=1` limita o custo de escrita.

### 6.3 Cache de aplicação

```ts
cacheKey = sha256(stableStringify({
  v: AI_CONFIG_VERSION,
  engineVersion: AI_ENGINE_VERSION,
  profileId,
  profileVersion,
  profileHash,
  promptHash,
  rulesVersion,
  modelId,
  modelVersion,
  provider,
  structuredOutput,
  mode,                 // off | shadow | assist | on
  minConfidence,
  fallbackPolicy,
  temperature,
  topP,
  seed,
  maxTokens,
  batchSize,            // lote efetivo; batching determinístico
  inputHash,
  vision: { enabled, version: VISION_VERSION, minScore } // se aplicável
}))
```

- `inputHash` = hash canônico do input validado (não do prompt).
- `profileHash` cobre schema, prompt, regras, exemplos, `userTemplate`, `rulesVersion` e `cache`.
- Cache só guarda resultado **válido**: `fallbackReason === null`, `mode !== 'fallback'`, sem `model_fallback`, sem `invalid_model_output`.
- Timeout/fallback/erro de provider **nunca** entram no cache.
- `single-flight`: duas requisições iguais simultâneas compartilham uma chamada (escopo single-instance).
- TTL e LRU configuráveis; cache exclusivamente em memória, sem Redis.
- Invalidação natural por versão: mudar perfil/prompt/modelo/regra/modo muda a chave.
- Métricas: `app_hit`, `app_miss`, `provider_cached_tokens`, `provider_cache_write_tokens`, `tokens_in`, `tokens_out`, `latency_ms`.
- Privacidade: em `selection`, o resultado são IDs; em `extraction`, contém quotes. `AI_APP_CACHE_STORE_QUOTES=false` **desabilita o cache de aplicação para perfis `extraction`** (não remove quotes do output, para não devolver shape diferente em hit/miss). `AI_STORE_PACKS=false` não guarda o input.

### 6.4 Orçamento de cache por request

Para 1.000 packs/dia, o alvo é:

- ≥60% de hits de cache de aplicação em reprocessamentos/retries;
- cache de prompt medido, não presumido: só vale a pena quando o prefixo atinge o mínimo;
- zero chamadas duplicadas concorrentes para o mesmo `cacheKey`;
- no máximo `AI_PROMPT_CACHE_MAX_BLOCKS` breakpoints e TTL configurado.

---

## 7. Anti-alucinação

### 7.1 Invariantes

1. O modelo nunca gera título, preço, URL, imagem ou ID; só referencia candidatos existentes.
2. Em `extraction`, todo campo não booleano/enum exige `evidence.quote` literal contido no input.
3. `additionalProperties: false` em todos os objetos; todos os campos obrigatórios (null explícito quando aplicável).
4. Enums fechados para rótulos; números com `minimum`/`maximum`; strings com `maxLength`.
5. `temperature=0`, `top_p=1`, sem tools, sem web, sem memória.
6. Saída inválida = rejeita a decisão do modelo; não “corrige” com inferência.
7. Incerteza vira `needsReview`, não descarte silencioso.
8. Toda decisão é revalidada contra o input original no servidor.
9. Cobertura `exact`: cada item de entrada aparece exatamente uma vez na saída.
10. Input é dado não confiável; instruções dentro dele não são comandos.

### 7.2 Grounding de extração

```jsonc
{
  "field": "price",
  "value": 199.9,
  "evidence": {
    "sourceField": "items[3].rawText",
    "quote": "R$ 199,90"
  }
}
```

Validação:

1. `sourceField` é JSON Pointer válido e existe no input.
2. `quote` normalizada (Unicode NFC, HTML entities, espaços colapsados, trim) é substring do texto normalizado do campo, com **mínimo de 8 caracteres ou 3 tokens** e match em limite de token.
3. Para número/data, o valor é parseado de forma canônica (locale, moeda, separador) e comparado ao quote; divergência acima da tolerância rejeita.
4. Para enum, o valor está no enum do perfil.
5. Quote ambígua/repetida com valores conflitantes rejeita.
6. Sem evidência válida → `needsReview` ou rejeição, conforme `validation.fallback`.
7. Cobertura exata: item omitido/repetido rejeita.

Testes adversariais obrigatórios: quote de 1 caractere, quote de outro campo, número divergente, item omitido, texto com “ignore as instruções”.

### 7.3 Regras determinísticas

Regras simples são declarativas no perfil:

- `required`
- `enum`
- `number_range`
- `candidate_ref`
- `unique`
- `coverage`

Regras complexas são `custom` com semântica versionada e parâmetros no `.env`:

- `current_price_brl`
- `original_gt_current`
- `unique_current_price`
- `title_min_length`
- `image_host_allowlist`
- `not_noise_title`

```jsonc
{
  "type": "custom",
  "name": "image_host_allowlist",
  "params": { "hosts": ["m.media-amazon.com", "images.amazon.com"] }
}
```

- Cada regra tem `id`, `params`, `version` e `promptText`; o texto do prompt e o validador vêm do mesmo registro para não divergir.
- `rulesVersion` entra na cacheKey.
- O código não conhece “cards”; conhece o registry de regras. Perfis novos podem reutilizar regras ou declarar `rules: []`.
- Teste dourado compara heurística antiga vs nova antes de remover o legado.

---

## 8. Contratos HTTP

### 8.1 Genérico

`POST /v1/execute` (e `/api/v1/execute`)

```json
{
  "profile": "cards",
  "input": { "marketplace": "amazon", "cards": [] },
  "options": {
    "mode": "assist",
    "model": "fast",
    "cache": true,
    "requestId": "opcional"
  }
}
```

Resposta:

```json
{
  "success": true,
  "data": {
    "profileId": "cards",
    "profileVersion": "2.0.0",
    "promptVersion": "sha256:...",
    "modelId": "fast",
    "modelVersion": "gpt-6-luna@2026-10",
    "provider": "openai",
    "mode": "llm",
    "cache": { "appHit": false, "providerCachedTokens": 1800 },
    "validation": { "ok": true, "rejected": 0, "review": 1 },
    "output": { "decisions": [] },
    "latencyMs": 820
  }
}
```

**Erros:**

| Código | HTTP | Quando |
| --- | --- | --- |
| `UNKNOWN_PROFILE` | 404 | perfil não existe |
| `INPUT_INVALID` | 400 | input viola schema |
| `PACK_TOO_LARGE` | 413 | itens/chars acima do limite |
| `PROFILE_MISCONFIGURED` | 500 | config inválida detectada em runtime |
| `RATE_LIMITED` | 429 | rate limit |
| `MODEL_TIMEOUT` / `MODEL_UNAVAILABLE` | 200 com fallback | `AI_FAIL_OPEN=true` |
| `MODEL_TIMEOUT` / `MODEL_UNAVAILABLE` | 503 | `AI_FAIL_OPEN=false`; sem output aplicado |
| `UNAUTHORIZED` | 401 | chave interna ausente/errada |

`options.cache=false` força bypass; `options.cache=refresh` ignora leitura e regrava. `options.model` só aceita modelos em `model.allowedModels` do perfil; fora da allowlist retorna `400 INPUT_INVALID`.

**Semântica do `AI_MODE`:**

| Modo | `/v1/execute` | `/v1/adjudicate` |
| --- | --- | --- |
| `off` | não chama provider; executa regras determinísticas; se o perfil não tiver fallback, retorna `503 MODEL_DISABLED` | determinístico (`mode=heuristic`) |
| `shadow` | chama provider, mas devolve saída determinística e registra a escolha do modelo | determinístico + `shadow` na auditoria |
| `assist` | aplica modelo acima de `minConfidence`; abaixo, determinístico + `needsReview` | idem |
| `on` | aplica modelo validado (inclusive rejeições acima do limiar) | idem |

O adaptador legado força `AI_FAIL_OPEN=true` para preservar o contrato `mode=fallback`; `AI_FAIL_OPEN=false` só afeta `/v1/execute`.

### 8.2 Legado

`POST /v1/adjudicate` continua com o contrato atual, implementado como:

```ts
execute({ profile: "cards", input: body, options: { mode: AI_MODE, timeoutMs: AI_LEGACY_TIMEOUT_MS } })
  → legacyAdjudication.toLegacyResponse(...)
```

Mapeamento campo a campo:

| Campo legado | Origem |
| --- | --- |
| `packVersion` | `PACK_VERSION` / entrada legada |
| `packHash` | hash canônico do pack legado |
| `promptVersion` | `promptHash` do perfil `cards` |
| `mode` | `llm \| heuristic \| fake \| fallback` |
| `modelId` / `modelVersion` | catálogo |
| `fallbackReason` | erro do provider, sanitizado |
| `decisions` | output genérico convertido para o shape legado; `confidence` 0–100 do schema vira 0–1 no contrato legado |
| `rejected` | rejeições do validador genérico |
| `latencyMs` | tempo total do adaptador |

- Deadline próprio `AI_LEGACY_TIMEOUT_MS=5000`; não herda 30s do `/v1/execute`.
- Teste dourado compara a resposta completa, não só `decisions`.
- Campos novos são aditivos (`profileId`, `profileVersion`, `cache`), sem quebrar o cliente.
- `AI_ADJ_MODE` continua funcionando como alias de `AI_MODE`.

### 8.3 Observabilidade

- `GET /v1/health`: status, `mode`, `defaultProfile`, `defaultModel`, `provider`, `cache`, sem segredos.
- `GET /v1/models`: catálogo + `ready` + capabilities; nunca `baseUrl`/`apiKeyEnv`.
- `GET /v1/profiles`: IDs, versões, descrições; nunca prompts/segredos.
- `POST /v1/models/:id/load|unload`: retornar **410 Gone** (menos quebrador que remover); atualizar o ia-lab da API/FRONT no mesmo release para não chamar esses endpoints.
- Logs por request: `requestId`, `profile`, `model`, `mode`, `tokens`, `cache`, `latency`, `validationFailures`; prompt/raw só com `AI_LOG_PROMPTS=true`.
- Persistência: `ExecutionRecord` com `profileId`, `profileVersion`, `cacheHit`, `provider`, `tokensIn/Out`, `cachedTokens`; campos antigos preservados. O schema Mongoose `tb_aiAdjudications` (enum fixo de `mode` e campos obrigatórios) precisa de migração/índices ou de uma coleção nova `tb_aiExecutions`; teste com memory e Mongo.
- Normalizar usage: OpenAI `prompt_tokens_details.cached_tokens`, Anthropic `cache_read_input_tokens`, Gemini `cachedContentTokenCount`.

---

## 9. Remoção da pasta `LLMS` e do provider nativo

**Decisão:** remover o modelo local empacotado e o `node-llama-cpp`, mas **depois** de extrair as dependências e criar o adaptador legado.

Arquivos/ações:

- remover `src/LLMS/` (`.gitkeep`, `.gguf`);
- remover `src/providers/llm/llamaCppProvider.ts`;
- remover `node-llama-cpp` de `package.json` / lockfile (`npm uninstall`);
- remover `scripts/download-model.mjs` e `model:download`;
- adaptar `scripts/smoke-llm.ts` para endpoint OpenAI-compatible (ou remover);
- remover `AI_MODEL_PATH`, `AI_MODEL_CONTEXT`, `AI_MODEL_THREADS`;
- remover `src/providers/llm/prompt.ts` e `grammar.ts` estáticos **somente após** extrair `candidateRef.ts` e atualizar imports;
- atualizar `.gitignore`, docs, README, `training/README.md` e testes.

**Como usar modelo local depois:**

```dotenv
AI_MODELS_JSON=[{"id":"local","version":"qwen3-8b@2026-10","provider":"openai-compatible","model":"qwen3-8b","baseUrl":"http://127.0.0.1:8080/v1","apiKeyEnv":"","structuredOutput":"json_schema","promptCaching":"off"}]
```

**Produção:** se `LLM_PROVIDER=llamacpp` ou `AI_MODEL_PATH` ainda existir, o boot falha com mensagem de migração. Não degradar em silêncio.

**Vision/replay:** `VISION_*` permanece opcional; se ativo, `VISION_VERSION` é obrigatório e `VISION_VERSION`/`minScore` entram na cacheKey. `AI_REPLAY_PATH` permanece opt-in: vazio = nada; setado = metadados sem pack; pack só com `AI_REPLAY_STORE_PACK=true`; não herda `AI_STORE_PACKS`. Documentar retenção e não ligar em produção sem política.

---

## 10. Migração por fases

### Fase 0 — Congelar contrato e preparar extração de dependências

1. Testes dourados de `/v1/adjudicate` com `fake` (resposta completa).
2. Extrair `candidateRef.ts` (letras/índice/`NONE`, limites) e `canonicalHash`.
3. Atualizar imports de `adjudicationValidators`, `fakeProvider`, `adjudicationService`, `datasetBuilder`.
4. Abstrair o fake para responder por metadados estruturados (`profileMode`, `candidates`), sem regex no prompt.
5. **Não remover** `node-llama-cpp` ainda.

**Critério de saída:** build/test verdes; contrato legado congelado; fake não depende do texto do prompt.

### Fase 1 — Config layer + validação de schema

1. `env.ts` com Zod, aliases, fail-fast, `getMode()` por request.
2. `profiles.ts`/`models.ts`, `config:validate`, `config:encode/decode/diff`, `profile:new`.
3. Ajv 2020-12 + meta-schema + `profileHash`/`schemaHash`.
4. `.env.example` com `cards`, `offers` e `lead`; aliases e limites.

**Critério de saída:** config inválida não sobe; perfil `cards` é parseado; nenhum prompt no código; `config:validate` estima tokens.

### Fase 2 — Pipeline genérico com `fake` + OpenAI-compatible

1. `executionService`, `promptBuilder`, `outputValidator`, `legacyAdjudication`.
2. Modos `selection` e `classification` primeiro; `extraction`/`score` depois.
3. `/v1/execute` e `/v1/profiles`.
4. Paridade `cards` via `/v1/execute` versus `/v1/adjudicate`.
5. OpenAI-compatible cobre OpenAI, OpenRouter, vLLM, Ollama e llama.cpp server.

**Critério de saída:** `cards` com paridade; perfil `offers` de teste; fake por modo.

### Fase 3 — Cache

1. Cache de aplicação, single-flight, chaves completas, TTL/LRU.
2. Testes de hit/miss/invalidação/fallback não cacheado/modo.
3. Só depois hints de prompt cache, opt-in e medidos.

**Critério de saída:** segunda execução idêntica não chama provider; mudar versão/modo/regra invalida; fallback não é cacheado.

### Fase 4 — Extração/score + anti-alucinação

1. Grounding com JSON Pointer, quote mínima, parsing canônico, cobertura exata.
2. Testes adversariais e perfil `offers`.
3. `AI_FAIL_OPEN`/`off`/`shadow` por modo.

**Critério de saída:** quote falsa/curta/de outro campo rejeitada; item omitido rejeitado; perfil `offers` criado só no `.env`.

### Fase 5 — Remoção do modelo local

1. Remover `src/LLMS`, `llamaCppProvider`, `prompt.ts`, `grammar.ts`, `node-llama-cpp`, scripts de download.
2. Atualizar `server.ts`, health, models, docs, training.
3. Typecheck/build/test sem `node-llama-cpp`.

**Critério de saída:** nenhum import de `src/LLMS`/`.gguf`; `/v1/ready` e `/v1/models` coerentes; boot falha com config antiga.

### Fase 6 — Providers adicionais

1. Anthropic/Gemini somente após o pipeline estar estável.
2. Cache permanece em memória; sem Redis.

**Critério de saída:** mesmo perfil executa nos quatro providers; usage/cache normalizados.

### Fase 7 — Eval/rollout

1. Baseline congelada, fixtures `cards`/`offers`/`extraction`.
2. Shadow 24–48h, critérios estatísticos e custo.
3. `assist` e depois `on`.

**Critério de saída:** eval ≥ baseline; 0 IDs inventados; p95 do legado ≤ 3,5 s; custo dentro do orçamento.

---

## 11. Testes e avaliação

### 11.1 Unitários

- parse de `.env` (JSON, base64, aliases, inválido);
- meta-schema de perfil (campo faltando, modo inválido, schema inválido, placeholder desconhecido);
- catálogo de modelos (provider desconhecido, `apiKeyEnv` ausente/fora da allowlist, `baseUrl` inseguro);
- `stableStringify`/`cacheKey` (ordem de chaves, versões, modo, regras);
- `promptBuilder` (prefixo idêntico entre inputs; sufixo muda; sem timestamp; input delimitado);
- `outputValidator` (ID inexistente, campo extra, enum inválido, quote falsa, número divergente, item omitido/repetido);
- cache (hit/miss, single-flight, TTL, invalidação, fallback não cacheado);
- regras (`params`, `rulesVersion`, promptText sincronizado).

### 11.2 Integração

- `/v1/execute` com `fake` para `selection`/`extraction`/`classification`/`score`;
- `/v1/adjudicate` legado com fixture dourada;
- cada provider com `fetch` mockado (headers, body, `response_format`, `cache_control`, usage);
- timeout/abort/erro 5xx → fallback;
- auth interna, rate limit, body limit 413;
- `/v1/helt` e `/v1/health` sem regressão;
- `AI_LOG_PROMPTS=false` não vaza prompt/pack no stdout;
- `AI_REPLAY_PATH` vazio = nada; setado + `AI_REPLAY_STORE_PACK=false` = replay só de metadados (sem pack); setado + `true` = replay com pack; `AI_STORE_PACKS=false` não grava pack na persistência.

### 11.3 Eval

Formato JSONL:

```json
{"id":"card-1","profile":"cards","input":{...},"expect":{"decisions":{"c1":{"titleId":"t2"}}}}
```

Métricas:

- acurácia por campo;
- taxa de `invalid_model_output`;
- taxa de `needsReview`;
- latência p50/p95;
- tokens in/out e cache hit;
- custo estimado por 1.000 packs.

Gate mínimo para `assist`: ≥ baseline atual de acurácia, 0 IDs inventados, 0 valores fora do schema, p95 dentro do orçamento, `offers` end-to-end só via `.env`.

---

## 12. Riscos e mitigação

| Risco | Mitigação |
| --- | --- |
| `.env` com prompts longos quebra parsing/PM2 | JSON one-line canônico; B64 opt-in; `config:validate` no CI/boot; limite por perfil. |
| Prompt em `.env` é difícil de revisar | `config:decode`/`config:diff`; hash; PR de config com revisão; `profiles/*.json` como autoria. |
| Provider não suporta JSON Schema | matriz de capacidades; `structuredOutput` por modelo; fallback `json_object` + validação estrita; nunca confiar no texto. |
| Cache de prompt abaixo do mínimo | `AI_PROMPT_CACHE=auto`; medir `cached_tokens`; cache de aplicação primeiro; não inflar prompt. |
| Cache de aplicação servir resultado velho | chave inclui modo/versões/regras; TTL; invalidação; não cachear fallback. |
| Prompt injection no HTML raspado | input delimitado como dado; system declara hierarquia; validação de referência/cobertura. |
| Exfiltração via catálogo | allowlist de `apiKeyEnv`; HTTPS/loopback; boot warn; nunca logar chave. |
| Modelo pequeno/local erra formato | referências A-L; schema mínimo; validação; fallback determinístico. |
| Remoção do modelo local aumentar custo | modelo local via HTTP; cache; comparação de custo no eval; `shadow` antes de `on`. |
| Regressão no `/v1/adjudicate` | adaptador legado + fixture dourada + rollout shadow. |
| Vazamento de prompt/dados em log | `AI_LOG_PROMPTS=false`; redaction; retenção opt-in. |
| Config antiga em produção | boot falha com mensagem de migração; sem degradação silenciosa. |

---

## 13. Decisões abertas (precisam de aprovação)

1. **Formato do `.env`:** JSON one-line como padrão; B64 opt-in para quebra de linha. Recomendo essa ordem (B64 não é criptografia e é ruim de revisar).
2. **Escopo inicial:** `cards` + `offers` na Fase 2/4; `extraction` genérico e `score` na Fase 4. “Qualquer coisa” via JSON Schema é suportado, mas o primeiro perfil novo precisa de eval.
3. **Cache:** exclusivamente em memória (LRU/TTL), sem Redis. A VPS atual roda uma instância.
4. **Modelo default:** `fake` em dev; catálogo obrigatório em produção. Recomendo `fast` (OpenAI/Anthropic) e local via HTTP como opção.
5. **Compatibilidade:** manter `/v1/adjudicate` até API/FRONT migrarem, com prazo de 2 releases.
6. **Regras:** semântica complexa em código versionado; parâmetros e regras simples no `.env`. Se você quiser 100% declarativo, isso é uma DSL e deve ser um projeto separado.

---

## 14. Referências consultadas

- OpenAI — Structured Outputs: https://platform.openai.com/docs/guides/structured-outputs
- OpenAI — Prompt Caching: https://platform.openai.com/docs/guides/prompt-caching
- Anthropic — Structured Outputs: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- Anthropic — Prompt Caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Google Gemini — Structured Output: https://ai.google.dev/gemini-api/docs/structured-output
- Google Gemini — Context Caching: https://ai.google.dev/gemini-api/docs/caching
- vLLM — Structured Outputs: https://docs.vllm.ai/en/latest/features/structured_outputs.html
- llama.cpp — GBNF / JSON Schema: https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md
- OpenRouter — Prompt Caching / sticky routing: https://openrouter.ai/docs/features/prompt-caching

---

## 15. Registro de revisão

| Data | Revisor | Modelo | Veredito | Bloqueios |
| --- | --- | --- | --- | --- |
| 2026-10-26 | `general` (free) | não exposto | REPROVADO | P0-1 a P0-9 (regras vs `.env`, cache key/modo, schema estático vs referências, ordem de remoção, fake acoplado, JSON Schema, contrato legado, grounding, `modelVersion`) |
| 2026-10-26 | `mimo` (free) | não exposto | APROVADO COM RESSALVAS | P0: `modelVersion`, timeout legado, parâmetros de regras no `.env`; P1: privacidade de quotes, erros, allowlist de chave, concorrência, prompt injection, aliases |
| 2026-10-26 | `general` (re-revisão) | não exposto | APROVADO COM RESSALVAS | P0: nenhum; P1: replay, `AI_MODE=off`, `batchSize`, `VISION_VERSION`, `AI_FAIL_OPEN=false` |
| 2026-10-26 | `mimo` (re-revisão) | não exposto | APROVADO | P0: nenhum; P1: nenhum; P2: status/log, encode one-line, replay metadata, `/v1/adjudicate` com `AI_FAIL_OPEN=false` |
| 2026-10-26 | plano 2.1.1 | — | Ressalvas incorporadas | P0/P1 fechados no documento; falta validação de implementação (typecheck/build/test/eval) |

> Regra: não declarar aprovação sem revisão concluída. Registrar revisor, modelo, veredito e bloqueios. A versão 2.1.1 incorpora as ressalvas finais; a aprovação de implementação depende de typecheck/build/test/eval e da fixture dourada do legado.

---

## 16. Status de implementação (2026-10-26)

| Fase | Status | Evidência |
| --- | --- | --- |
| Fase 0 — contrato/fake/candidateRef | **Concluída** | `candidateRef.ts`, hash genérico, fake com `metadata.fakeOutput`, fixture dourada `/v1/adjudicate`. |
| Fase 1 — config layer | **Concluída** | `config/models.ts`, `config/profiles.ts`, Ajv 2020-12, `config:validate/encode/decode`, `.env.example` v2. |
| Fase 2 — pipeline genérico | **Parcial** | `/v1/execute`, `promptBuilder`, `outputValidator`, provider `fake` e `openai-compatible`; Anthropic/Gemini pendentes. |
| Fase 3 — cache | **Parcial** | cache de aplicação LRU/TTL, hit/miss, single-flight, chave por modo/versões; métricas de prompt cache e política de abort do líder pendentes. |
| Fase 4 — extração/score | **Parcial** | grounding `source_quotes`, cobertura exata, referências A-L, regras declarativas/custom de cards e fallback heurístico genérico para seleção (`off`, `shadow`, falha/invalid output); `score` pendente. |
| Fase 5 — remoção do modelo local | **Concluída** | `src/LLMS`, `node-llama-cpp`, `llamaCppProvider`, scripts de download/smoke e campos `AI_MODEL_PATH/CONTEXT/THREADS` removidos; modelo local via `openai-compatible` HTTP. |
| Fase 6 — providers adicionais | **Concluída** | Anthropic Messages e Gemini generateContent implementados com structured outputs/cache/usage. Cache em memória, sem Redis. |
| Fase 7 — rollout | **Parcial** | `npm run eval:profile` com fixture `cards` (caso válido + fallback); shadow/assist/on com packs reais pendentes. |

**Validação local:** `npm run typecheck`, `npm run build`, `npm run config:validate`, `npm run eval:profile` (2/2) e `npm test` verdes (110 testes) na data acima. O legado `/v1/adjudicate` continua com contrato dourado.

