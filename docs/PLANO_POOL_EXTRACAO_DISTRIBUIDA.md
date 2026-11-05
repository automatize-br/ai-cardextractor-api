# Plano — Pool de Extratores de Ofertas com Balanceamento por CPU

**Versão:** 5.2.0 (conformidade com PLAN2; aprovada por backend e produto com ressalvas)
**Data:** 2026-11-04
**Branch:** `feat/extractor-pool-scheduler` (extractor) + `feat/ia-cars-validation-integration` (API)
**Status:** backend e produto **APROVADOS COM RESSALVAS** (v5.1.0). Pendências P1 antes da Etapa C em §16.16.
**Escopo:** apenas API central ↔ extractors. **Nenhuma mudança no FRONT neste ciclo.**
**Projetos:** `ai-extractor-api` (este), `../API`
**Documento de referência:** `docs/PLAN2/vupia-plano-workers-distribuidos.md` + `docs/PLAN2/DIAGRAMA.png`

---

## 0. Resumo executivo

A API central distribui a extração/validação de cards para um **pool de instâncias dedicadas do `ai-extractor-api`**, cada uma em uma VPS de 2 vCPU. A escolha usa CPU (sinal grosseiro), in-flight real, capacidade, saúde, versão/contrato e plataformas suportadas.

**Validação pós-merge `dev` (API/FRONT, 2026-10-27):** o plano foi reconferido contra o código de `dev` mergeado. Ajustes: `SearchGuard.cacheKey` real inclui `userId|marketplace|query|page|limit`; o pipeline real é `dedupe -> shuffle -> categoria -> relevância -> paginação -> adjudicação (legacy)`; `trustedApiCategory`/`trustedCategorySource` e `categoryNodeAccepts` entram no fluxo; o caminho de API oficial não usa `filterRelevant` quando a categoria é confiável; FRONT ainda não trata 503/`Retry-After` (previsto na Fase 5).

**Decisões fechadas nesta revisão:**

1. **Topologia:** N VPS dedicadas de 2 vCPU por extractor; API central em VPS separada. Se tudo estiver no mesmo host, o pool não é usado (CPU da VPS seria igual para todas as instâncias).
> **Substituído por §16 onde conflitar (v4.2.0).**

2. **Dono da extração:** o `ai-extractor-api` é o dono único da extração determinística. O `offerExtractor` da API é **legado temporário** até a paridade golden; depois é removido. Fallback após a remoção: `503` com `Retry-After` + estado de UI; durante a migração, fallback legado.
3. **HTML:** a API envia HTML **recortado genericamente** com lista fechada: remove `<style>`, `<svg>`, comentários e data-URIs; preserva `<script type="application/ld+json">`, `<script type="application/json">` e scripts cujo conteúdo case o allowlist de estado (`__INITIAL_STATE__`, `__NEXT_DATA__`, `__PRELOADED_STATE__`, `window.__`); remove os demais scripts. O extractor faz o recorte específico por plataforma. Limite: 1 MB descompactado / 512 KB gzip. Se o recorte passar de 1 MB, a página vira vazio/parcial com métrica (nunca 503); **nunca truncar no meio do HTML**.
4. **Grounding:** o extractor devolve `selection` + `candidates` (≤12 por campo) + `evidence` com `{source, pointer|selector, occurrence}`; o central revalida o candidato escolhido e o valor com o **mesmo módulo de normalização/parsing**. Preço é reparseado para cents; imagem é comparada por URL normalizada; título por igualdade/substring. O mínimo de 3 tokens vale só para texto livre.
5. **Fila:** *(substituído por §16.3 D7/§16.8)* o caminho síncrono tem deadline absoluto de 45 s e espera de até 10 s por capacidade; esgotada, 503 + `Retry-After` (nunca 200 vazio). Fila longa é apenas bulk (§16.5–§16.6) e guarda descritor, nunca HTML.
6. **Estado do pool (v3.0.0):** cada extractor grava o próprio estado direto em `tb_aiExtractorInstances` a cada 180s; a API central apenas lê. O heartbeat HTTP de 30s/staleness 90s permanece só como modo legado (`EXTRACTOR_STATE_MODE=central`). No modo direto o staleness default é 300s.
7. **Cache:** memória apenas, sem Redis. Cache de resultado no central por `htmlHashOriginal + htmlHashTrimmed + trimmerVersion + coreVersion + extractorVersion + profile + contractVersion`; `SearchGuard` **não** usa hash na chave pré-fetch.
8. **Persistência:** `AI_EXTRACTOR_MODE=pool` exige Mongo **no central**; reservas são **sempre persistidas no Mongo**, mesmo com `REPLICA_COUNT=1`; o extractor pode usar memory. `pool` vazio não derruba o boot: entra em `degraded`.
9. **Boot:** *(v4.7)* allowlist é semeada com `desiredStatus='auto'`/`observedStatus='offline'`; falha de boot só por config inválida (JSON, chave, persistência), nunca por liveness.
10. **Sem duplicação permanente:** port com paridade golden no subconjunto DOM (JSON-LD atrás de flag, com eval próprio); se a paridade não passar, o pool de extração não é ativado.

---

## 1. Topologia, SLO e gate

### 1.1 Topologia

```
FRONT
  │
  ▼
API central (1 processo; multi-processo exige reserva atômica)
  │  HTTPS + x-internal-key + HMAC de heartbeat
  ├── extractor-a.vupia.com.br  (VPS 2 vCPU)
  ├── extractor-b.vupia.com.br  (VPS 2 vCPU)
  └── extractor-c.vupia.com.br  (VPS 2 vCPU)
```

- Cada extractor: `EXTRACTOR_DNS`, `EXTRACTOR_KEY`, `EXTRACTOR_VERSION`; `bootId` é gerado por processo (`crypto.randomUUID`), não é env estável.
- Central: `AI_EXTRACTOR_POOL_JSON=[{dns,keyEnv}]`.
- Sem browser e sem modelo local no extractor.
- LLM externo via API. Sem provider externo, perfil `cards` cai em heurística.

### 1.2 SLO

| Caminho | Meta |
| --- | --- |
| `/v1/extract` determinístico, HTML ≤1MB | p95 ≤ 800 ms |
| `/v1/extract` com LLM (≤10 cards) | p95 ≤ 3 s |
| Busca completa (scrape + pool) | p95 ≤ 45 s; p99 ≤ 60 s |
| Throughput por instância | ≥ 1,5 req/s (1MB) **somente com capacity=2 + benchmark**; default 1 |
| CPU extractor | ≤ 70% em regime |
| Event loop lag p95 | ≤ 100 ms |
| Fallback por indisponibilidade | ≤ 1% em regime |
| Perda silenciosa de cards | zero |

**Dimensionamento:** capacity=2 requisições em voo; CPU parse=1 por vez; LLM externo em semáforo separado (2). 1,5 req/s × 0,8s = 1,2 em voo, cabe em capacity=2. O caminho com LLM tem orçamento próprio e não entra no p95 determinístico.

### 1.3 Gate go/no-go

Medir na VPS real, por plataforma:

1. CPU/tempo do `offerExtractor` atual (30/100/200 cards);
2. recorte + transferência + parse do HTML;
3. memória de pico do DOM (5–10× HTML);
4. p95 atual da busca.

Se o parse for <20% do custo total e o hop piorar o p95 em >15% sem reduzir CPU da API, **não ativar o pool de extração**; distribuir apenas adjudicação (`/v1/adjudicate`/`/v1/execute`) e registrar a decisão. O modo `adjudicate` permanece suportado.

---

## 2. Contrato `/v1/extract`

### 2.1 Request

`POST /v1/extract`

Body: `application/octet-stream` (HTML UTF-8), opcional `Content-Encoding: gzip`.

Headers:

- `x-internal-key`
- `x-extract-meta`: JSON compacto **sem URL em query**:
  ```json
  {"marketplace":"amazon","url":"https://...","profile":"cards","contractVersion":"1","coreVersion":"offer-extract-core@1.2.0","trimmerVersion":"trim@1","htmlHashTrimmed":"...","htmlHashOriginal":"...","htmlBytes":812345,"maxScanned":200,"maxCards":200,"maxLlmCards":10,"mode":"assist","deadlineAt":1760000000000,"requestId":"req_..."}
  ```
- `x-request-id` (correlação; formato `^[A-Za-z0-9_-]{8,64}$`)
- `x-deadline-at` (epoch ms; também no meta)
- `x-extract-contract` = `1`

Limites:

- `EXTRACTOR_MAX_HTML_BYTES=1048576` (1MB descompactado)
- `EXTRACTOR_MAX_HTML_GZIP_BYTES=524288` (512KB comprimido)
- `EXTRACTOR_BODY_LIMIT_BYTES=1258291` (1,2MB)
- `express.raw` na rota; **não** `express.json`.
- >1,2MB: `413 PAYLOAD_TOO_LARGE` do body-parser; entre 1MB e 1,2MB: `413 HTML_TOO_LARGE` do handler.
- Validar bytes descompactados e proporção gzip (zip bomb).
- Validar `x-extract-meta`: schema estrito, tamanho de header, `sha256(body) == htmlHashTrimmed`, `htmlBytes`; `htmlHashOriginal` é metadado separado; divergência -> `CONTRACT_MISMATCH`.
- `x-extract-meta` é JSON compacto URL-safe/base64 quando houver não-ASCII; limite de 6 KB; nunca colocar URL em query.
- `/v1/extract` autentica com `x-internal-key` + `x-extractor-key` por instância; o HMAC do heartbeat é separado.

### 2.2 Response

```json
{
  "success": true,
  "data": {
    "contractVersion": "1",
    "requestId": "req_...",
    "marketplace": "amazon",
    "extractorVersion": "git-sha",
    "coreVersion": "offer-extract-core@1.2.0",
    "trimmerVersion": "trim@1",
    "promptVersion": "sha256:...",
    "modelId": "fast",
    "modelVersion": "gpt-6-luna@2026-10",
    "mode": "heuristic|llm|fallback",
    "degraded": false,
    "reason": null,
    "htmlHashTrimmed": "...",
    "htmlHashOriginal": "...",
    "cards": [
      {
        "cardId": "c1",
        "externalProductId": "B0...",
        "title": "Fone Bluetooth JBL Tune 510BT",
        "priceCents": 19990,
        "currency": "BRL",
        "originalPriceCents": 24990,
        "imageUrl": "https://m.media-amazon.com/images/I/x.jpg",
        "permalink": "https://www.amazon.com.br/dp/...",
        "extra": { "breadcrumb": "Eletrônicos > Áudio" },
        "confidence": 0.93,
        "needsReview": false,
        "reviewReasons": [],
        "selection": {
          "titleId": "t1",
          "priceId": "p1",
          "imageId": "i1",
          "source": "model|heuristic"
        },
        "candidates": {
          "titles": [{ "id": "t1", "text": "Fone Bluetooth JBL Tune 510BT" }],
          "prices": [{ "id": "p1", "cents": 19990, "currency": "BRL", "kind": "current" }],
          "images": [{ "id": "i1", "url": "https://..." }]
        },
        "evidence": {
          "cardRoot": { "selector": "div[data-asin='B0...']", "occurrence": 0 },
          "title": { "source": "jsonld", "pointer": "/name", "quote": "Fone Bluetooth JBL Tune 510BT" },
          "price": { "source": "dom", "selector": ".a-price .a-offscreen", "occurrence": 0, "quote": "R$ 199,90" },
          "image": { "source": "jsonld", "pointer": "/image", "quote": "https://..." }
        }
      }
    ],
    "rejected": [{ "cardId": "c2", "reason": "not_a_product" }],
    "diagnostics": {
      "scanned": 60,
      "returned": 1,
      "rejected": 1,
      "truncated": false,
      "coverageComplete": true,
      "quality": "ok",
      "htmlBytes": 812345,
      "parseMs": 45,
      "llmCards": 1
    }
  }
}
```

Regras:

- `maxScanned/maxCards=200`; `maxLlmCards=10`.
- `candidates` + `selection` permitem ao central verificar que o escolhido existe no pack; `evidence` permite verificar o quote/path no HTML original.
- `rejected.reason` é enum versionado compatível com `DISCARD_REASONS`; desconhecido -> `needsReview`.
- `scanned` = cards identificados pelo extractor. `truncated=true` quando `scanned > maxCards`.
- Cobertura: se `coverageComplete=true`, `|cards ∪ rejected| == min(scanned, maxCards)`. Se `coverageComplete=false`, o central trata como fallback/qualidade, não como perda.
- HTML válido + zero cards identificados (`scanned=0`): **200** com `cards:[]`, `rejected:[]`, `coverageComplete:false`, `diagnostics.scanned=0`, `diagnostics.quality='no_cards'`, `reason=NO_CARDS_EXTRACTED`, `degraded=false`. O central **não** converte NO_CARDS em 503 e a UI distingue por `reason`/`quality`.
- HTML válido + `scanned>0` e `cards/rejected` incompletos: `coverageComplete=false`, `mode=fallback`; central faz fallback/needsReview.
- `affiliateUrl` é gerado na API, nunca no extractor.
- `degraded` na resposta significa degradação **do extractor** (LLM indisponível → heurística, `coverageComplete=false`); indisponibilidade do pool é `systemStatus=degraded` no **health/admin do central** (não neste campo). `NO_CARDS` usa `diagnostics.quality='no_cards'` e `degraded=false`.
- `systemStatus` do central: `ok|degraded|unavailable`; `degraded` quando pool vazio/stale ou breaker aberto; `unavailable` quando não há fallback legado. O estado é exposto no health/admin e em `x-system-status` na resposta (cache curto); o consumo pela UI é
dependência do FRONT, fora deste ciclo (§16.10.4).
- Matriz `degraded` do extractor: LLM off + cobertura ok → `false` (heurística é normal); LLM off + cobertura parcial → `true`; `NO_CARDS` → `false` (quality).

### 2.3 Erros

| Código | HTTP | Quando |
| --- | --- | --- |
| `UNSUPPORTED_PLATFORM` | 422 | marketplace sem extractor |
| `HTML_TOO_LARGE` | 413 | 1MB–1,2MB |
| `PAYLOAD_TOO_LARGE` | 413 | >1,2MB (body parser) |
| `HTML_INVALID` | 400 | vazio/malformado |
| `HTML_EXPIRED` | 410 | job assíncrono |
| `PROFILE_NOT_FOUND` | 404 | perfil |
| `EXTRACTOR_TIMEOUT` | 504 | deadline |
| `EXTRACTOR_BUSY` | 429 | semáforo cheio; não abre breaker |
| `NO_CARDS_EXTRACTED` | 200 | vazio com `cards:[]`; não é erro de infra |
| `CONTRACT_MISMATCH` | 409 | versão |
| `INTERNAL_ERROR` | 500 | falha |

---

## 3. Registry, reservas e heartbeat

### 3.1 `tb_aiExtractorInstances`

```ts
{
  _id, dns, version, contractVersion, coreVersion, platforms[], profileHashes[],
  capacity,                 // 2
  use, useRaw, cpuMetricSupported,
  reportedInflight, reserved, // campos separados
  queueDepth, eventLoopLagMs, p95LatencyMs,
  status: 'unknown'|'online'|'draining'|'offline',
  saturated: boolean,
  lastSeq, bootId,
  lastSeenAt, lastDispatchedAt, lastError,
  createdAt, updatedAt
}
```

- Índice único `dns`; `{status,saturated,use}`; `{lastSeenAt}`.
- **Sem TTL** na tabela de estado.
- `reserved` no schema, apesar de ser do central.

> **Substituído por §16.5 (ledger por `workerId`).** O texto abaixo descreve a v3.

### 3.2 Reservas

`tb_aiExtractorReservations`: `{reservationId, requestId, dns, expiresAt, createdAt}`.

- `$inc reserved` + insert da reserva; release idempotente.
- TTL index em `expiresAt` remove reserva órfã.
- **Sweep a cada 30s**: `countDocuments({dns, expiresAt>now})`, corrige `reserved`, loga divergência.
- Boot reconcile mantido.
- Admissão: `max(reserved, reportedInflight) < capacity`.
- Alerta `reserved_divergence > 0`.

> **Substituído por §16.3 D5.** O worker não escreve mais `status`; `desiredStatus` é do admin/reaper.

> **Substituído por §16.3 D5.** O worker não escreve `status`; `desiredStatus` é do admin/reaper.

### 3.3 Estado da instância (direto no Mongo — v3.0.0)

Cada extractor publica o **próprio** estado em `tb_aiExtractorInstances`; a API central **só lê**
(consultas de elegibilidade/score). Não há escrita de estado por heartbeat na API.

- `EXTRACTOR_STATE_MODE=mongo` (produção): upsert a cada `EXTRACTOR_STATE_INTERVAL_MS`
  (default `180000` = 3 min) com `dns`, `version`, `contractVersion`, `coreVersion`,
  `trimmerVersion`, `platforms`, `capacity`, `use`, `useRaw`, `cpuMetricSupported`,
  `reportedInflight`, `queueDepth`, `status`, `saturated`, `bootId`, `lastSeq`, `lastSeenAt`.
- `reserved` **não** é escrito pelo extractor: continua sendo propriedade da API (reserva de slot).
- Boot publica `online`; shutdown publica `draining` (a API deixa de escolher a instância).
- Histerese local 75/60 (`EXTRACTOR_SATURATION_THRESHOLD`/`EXTRACTOR_RESUME_THRESHOLD`).
- Falha de Mongo é logada e não derruba a extração; o próximo tick tenta de novo.
- `EXTRACTOR_STATE_MODE=central` mantém o heartbeat HTTP abaixo como caminho legado.

Legado (`central`): `POST /internal/ai-extractors/heartbeat` com:

- `x-extractor-dns`, `x-extractor-boot-id`, `x-extractor-seq`, `x-extractor-ts`, `x-extractor-signature`.
- Corpo: `dns`, `version`, `contractVersion`, `coreVersion`, `platforms`, `profileHashes`, `capacity`, `use`, `useRaw`, `cpuMetricSupported`, `reportedInflight`, `queueDepth`, `eventLoopLagMs`, `p95LatencyMs`, `status`, `measuredAt`.
- HMAC-SHA256 sobre JSON canônico (`dns|bootId|seq|ts|use|useRaw|reportedInflight|capacity|contractVersion|coreVersion|platforms`), chave por instância.
- `bootId` novo reinicia `seq`; `seq` regressivo/repetido com mesmo boot é rejeitado.
- `lastSeq`/`bootId` atualizados na **mesma** `findOneAndUpdate`.
- Janela de `ts` (ex.: ±5 min) para clock skew.
- Allowlist `AI_EXTRACTOR_POOL_JSON` com `keyEnv`.
- Heartbeat 30s; staleness 90s (legado).
- Boot envia `online`; shutdown envia `draining`.
- `draining/offline` manual não é ressuscitado.

### 3.4 CPU

- cgroup v2 (`cpu.stat`/`cpu.max`) e `/proc/stat`; cgroup v1 documentado.
- Windows/dev: `process.cpuUsage` + `os.loadavg` se disponível.
- `cpuMetricSupported=false` -> instância excluída (nunca assume 0%).
- `use = 0.5*anterior + 0.5*atual`; enviar `useRaw`.
- `eventLoopLag` via `monitorEventLoopDelay`.

---

## 4. Scheduler

> **Substituído por §16.5–§16.8 (seleção por heartbeat ≤60 s, ledger por `workerId`, capacity clamp).**

### 4.1 Elegibilidade

`status=online`, `lastSeenAt >= now - AI_EXTRACTOR_POOL_STALENESS_MS` (default **300s** no modo Mongo — cobre o publish de 180s + folga; 90s no heartbeat legado), `cpuMetricSupported`, `saturated=false`, `use<75`, `max(reserved,reportedInflight)<capacity`, `contractVersion`, `coreVersion` compatível (major), `platforms`, `profileHashes`, breaker.

### 4.2 Score

```
load = 100 * max(reserved, reportedInflight) / capacity
score = 0.6*use + 0.4*load + jitter(0..3)
```

Ordenar por score, depois `lastDispatchedAt`. Sem ordenações concorrentes.

### 4.3 Reserva

- Reservas são **sempre persistidas no Mongo**, mesmo com `REPLICA_COUNT=1`; snapshot em memória (1s) serve só para seleção/score. O volume é ~1–3/s, custo irrelevante.
- `findOneAndUpdate` com filtros completos e `$inc reserved`; `capacity` como literal do snapshot.
- Insert da reserva; se insert falhar, decremento compensatório.
- Release em `finally` + reserva TTL + sweep; sweep corrige contador, TTL remove documento.

### 4.4 Histerese

- Heartbeat marca `saturated=true` em `use>=75`; limpa em `use<=60`.
- Persistido; não recalculado por request.
- Enquanto saturada, não recebe tráfego mesmo com amostra 70.

### 4.5 Deadline/retry/breaker

- `x-deadline-at` absoluto; extractor usa `min(deadline-now, EXTRACTOR_REQUEST_TIMEOUT_MS=6000)`.
- `AI_POOL_BUDGET_MS=6000`; `AI_POOL_SYNC_WAIT_MS=2500`.
- **CPU slot liberado durante LLM**; LLM tem semáforo e timeout próprios (`EXTRACTOR_LLM_TIMEOUT_MS=2500`, calibrado por spike do provider).
- Perfil `cards` não usa `timeoutMs=30000` no `/v1/extract`; validação no boot: `profile.timeoutMs` só legado.
- Retry só conexão/502/503/504; 429 -> outra instância sem breaker; sem retry se `remaining < 2×timeout`.
- Abort do cliente propaga; parse em worker thread se >100ms para permitir abort real.

### 4.6 Todas ocupadas e desfechos

- **Infra indisponível** (timeout/transporte/429 esgotado): durante a migração usa fallback legado; após a remoção, `503 Retry-After`.
- **NO_CARDS_EXTRACTED** (HTML válido, zero cards identificados): `200` vazio com `diagnostics`, nunca 503.
- **Revalidação parcial**: cards afetados vão para `needsReview`; o restante segue.
- Síncrono espera ≤2,5s; assíncrono/bulk é interno e não expõe 202 público no MVP.
- Semáforo de fallback local = 1.
- UI mostra “aguardando capacidade”, “extração local” ou “tente novamente” conforme o desfecho.

| Desfecho | Resposta |
| --- | --- |
| Infra (timeout/transporte/429 esgotado) | legado durante migração; 503 `Retry-After` após |
| `NO_CARDS_EXTRACTED` | 200 vazio + diagnostics + alerta de qualidade |
| `coverageComplete=false` / recorte >1MB | parcial + `needsReview`/vazio com métrica; **nunca 503** |
| Revalidação de campo falhou | card `needsReview`; restante segue |

---

## 5. Fila

> **Substituído por §16.4–§16.7.** O modelo abaixo descreve a fila da v3 (`htmlRef`, TTL 15 min,
> `leaseUntil`, `MAX_ATTEMPTS=2`). A v4 usa `tb_aiExtractorJobs` + `tb_aiExtractionResults`, `lockedUntil`,
> `claims`/`attempts`, TTL 6 h e sweeper. Em conflito, §16 prevalece.

`tb_aiExtractorJobs` guarda descritor, nunca HTML:

```ts
{ jobId, requestId, ownerId, marketplace, category, window, url, htmlHashOriginal, htmlRef, htmlBytes,
  profile, options, priority:'bulk', status, attempts, leaseUntil, nextAttemptAt,
  trimmerVersion, coreVersion, contractVersion, idempotencyKey, runId,
  lastError, resultRef, expiresAt, createdAt, updatedAt }
```

- `htmlRef` aponta para `scrapeCache` (TTL 10min) ou re-coleta; expirou -> `HTML_EXPIRED`.
- Limites: `QUEUE_MAX=100`, `QUEUE_MAX_BYTES=64MB`, `QUEUE_TIMEOUT_MS=30000`, `MAX_ATTEMPTS=2`.
- TTL só em jobs terminais; `resultRef` aponta para `tb_aiExtractionResults` (Mongo, TTL 15min, limite de bytes) ou para o cache de resultado; nunca HTML.
- Claim atômico com `leaseUntil`, `attempts` no claim, backoff+jitter, dead-letter.
- Worker com lock; tick 1s; lote 1–5.
- `ownerId`/autorização no `GET /jobs/:id`.
- Fila é apenas assíncrona/bulk; `priority` não é `sync` (sync não entra na fila).
- **Contrato do produtor autoOfertas:** idempotência por `ownerId+marketplace+category+window` para agendado e `ownerId+marketplace+category+runId` para manual; `window` = `YYYY-MM-DDTHH` em `America/Sao_Paulo`; `runId` é uuid explícito; `idempotencyKey` único; `priority=bulk`; timeout/retry próprios; preview agrega resultados por job; 202 existente do autoOfertas, **não** 202 de busca.
- Job guarda `trimmerVersion/coreVersion/contractVersion`; versão nova **reprocessa** o HTML original; `contractVersion` incompatível rejeita.
- Índice único `{idempotencyKey:1}` e `{status:1,nextAttemptAt:1}`.

---

## 6. Extração

### 6.1 Pipeline

```
HTML recortado
  -> normalize (NFC, entidades, whitespace) [módulo único]
  -> platform extractor (JSON-LD, estado embutido, DOM)
  -> candidatos (title/price/image/permalink/externalId)
  -> gates (BRL, preço>0, imagem http(s), host, challenge)
  -> perfil cards (LLM só ambíguo, A-L)
  -> seleção + evidência
  -> revalidação no central
```

### 6.2 Código único e paridade

- O parser/normalizador de evidência é um **artefato compartilhado versionado** (`@vupia/offer-extract-core` privado, ou submódulo/vendored com hash fixo) consumido pela API e pelo extractor. Não duplicar `parseBrlToCents`/normalização.
- Portar `offerExtractor` para `src/modules/extraction` com **golden parity no subconjunto DOM** (JSON-LD off): mesmo HTML -> mesmo conjunto de valores.
- JSON-LD/estado embutido é capacidade nova; fica atrás de `EXTRACTOR_JSONLD_ENABLED=false` por default e tem eval de qualidade próprio. Só liga após paridade DOM e ganho comprovado.
- API mantém extrator antigo apenas durante a migração; após paridade + shadow, remove.
- Fixtures reais anonimizadas por plataforma.

### 6.3 Recorte de HTML

> **Substituído por §16.3 D2.** No contrato v2 o recorte é feito **no extractor**; a API não recorta HTML.

- Lista fechada, idêntica à §0.3: remove `<style>`, `<svg>`, comentários, data-URIs e **scripts fora do allowlist**; preserva `application/ld+json`, `application/json` e scripts com chaves de estado (`__INITIAL_STATE__`, `__NEXT_DATA__`, `__PRELOADED_STATE__`, `window.__`).
- O recorte específico por card é feito **no extractor**, que conhece os seletores.
- Alvo: 200–500KB; máximo 1MB; gzip nível 1 acima de 256KB.
- `trimmerVersion` sofre bump obrigatório ao mudar a lista de recorte; jobs guardam a versão e job com versão antiga é rejeitado/reprocessado.
- Normalização única usada por recorte, evidência e revalidação (evita falso `needsReview`).

### 6.4 Capacidade e semáforos

- `EXTRACTOR_REQUEST_CAPACITY=1` (default); 2 só com benchmark (v4.4).
- `EXTRACTOR_CPU_CONCURRENCY=1` (parse no main; worker thread se >100ms).
- `EXTRACTOR_LLM_CONCURRENCY=2`.
- `EXTRACTOR_LLM_TIMEOUT_MS=2500` (spike obrigatório antes de fixar).
- `EXTRACTOR_MAX_LLM_CARDS=10`.
- `EXTRACTOR_LLM_BATCH_SIZE=5`.
- CPU slot liberado durante await do LLM.
- Cache por `htmlHashTrimmed + trimmerVersion + coreVersion + extractorVersion`; resultado central por `htmlHashOriginal + htmlHashTrimmed + trimmerVersion + coreVersion + extractorVersion + profile + contractVersion`. `htmlHashOriginal` também entra na chave para evitar colisão de recortes.
- `undici.Agent` keep-alive, maxSockets=2, connectTimeout 600ms.
- `--max-old-space-size` e alarme RSS.
- Semáforo de fallback local=1.
- Rate limiter interno separado; rotas internas antes do limiter público.

### 6.5 LLM

- Só seleção A-L; nunca valores livres.
- `maxLlmCards=10`, batches de 5, no máximo 2 batches paralelos.
- Deadline e abort propagados.
- Sem provider externo -> heurística.

---

## 7. Integração com a API

> **Substituído por §16.3 D2/§16.7.** HTML não sai do worker; `ScrapeResult`/`capture`/`pageHealthy`/
> `scrapeCache` não fazem parte da v4.6.

### 7.1 HTML fora do resultado

- `MarketplaceScraper.browseOffers` **não** devolve `html` em `MarketplaceProductSearchResult`; no caminho capture devolve `ScrapeCapture {rawOffers: [], sourceUrl, html, htmlRef, htmlHashOriginal, htmlHashTrimmed, pageHealthy}`. `discarded` é do provider no legacy e do facade no pool; uma única origem por modo.
- `MarketplaceService.browseOffers` consome o `ScrapeResult` via `extractionGateway.extractCardsFromScrape(result, context)` (`legacy|shadow|capture`).
- O HTML é usado em memória para o pool e para a revalidação; o controller nunca serializa HTML ao FRONT.
- O `scrapeCache` passa a ser escrito de forma **awaited e incondicional** quando existe HTML, mesmo com 0 ofertas. `htmlRef` usa um store content-addressed novo (`sha256(htmlOriginal)`) ou a chave de URL atual **acrescida do hash**; não reutilizar cegamente o `sha1(url)`. Jobs assíncronos usam `htmlRef`; se expirou, `HTML_EXPIRED` + re-coleta.
- Se o recorte passar de 1MB, **não truncar e não chamar pool/legado**: vazio/parcial com `quality='html_too_large_after_trim'` + métrica; nunca 503.
- `scrapeCache` tem cap total de bytes (`SCRAPE_CACHE_MAX_BYTES`) e limpeza alinhada ao TTL (10min de leitura, remoção ≤1h); não usar o cleanup de 3h/3×dia sem cap.
- `SearchGuard` cache key (pré-fetch) = chave atual real (`${userId}|${marketplace}|${query.toLowerCase()}|${page}|${limit}`) + `mode + contractVersion + extractorVersion + coreVersion + trimmerVersion`. Hash **não** entra na chave pré-fetch; ele entra na cache de resultado pós-fetch (`htmlHashOriginal + htmlHashTrimmed + trimmerVersion + coreVersion + extractorVersion + profile + contractVersion`).

> **Substituído por §16.6/§16.7.** A ordem do pipeline permanece no provider; a fonte das ofertas no
> pool é o extrato do worker, não `capture` de HTML.

### 7.2 Ordem do pipeline

```
scrape/API
  -> legacy: provider dedupe + shuffle + pós-processamento
  -> pool: capture -> extract -> revalidação -> map
  -> dedupe (externalProductId ?? permalink)
  -> shuffle(seed estável)
  -> categoria (trustedCategorySource dispensa filtro local)
  -> relevância textual (q >=3)
  -> paginação
  -> legacy: adjudicateOffers; pool: já validado
```

- **Seam explícito:** `MarketplaceScraper.browseOffers(mode)` recebe o modo e devolve `ScrapeResult`:
  - `legacy`: `{kind:'legacy', items}` — **caminho atual inalterado**, incluindo extração/cascata/early-exit/pós-processamento/`discarded`; `items` é o `MarketplaceProductSearchResult[]` final (o provider já canonicaliza permalink/afiliado/externalId/categorias). Facade faz **passthrough**.
  - `shadow`: `{kind:'shadow', items, capture}` — roda o caminho legacy **real** e captura o HTML; `items` é o resultado final legado. O facade compara **final × final**: pós-processa o pool e compara com `items`. Único modo com extração local + pool.
  - `pool`: `{kind:'capture', capture}` (`rawOffers` vazio, `html`, `sourceUrl`, `htmlRef`, `htmlHashOriginal/Trimmed`, `pageHealthy`).
- `MarketplaceService.browseOffers` e `autoOfferSearch` chamam o **mesmo facade** `extractionGateway.extractCardsFromScrape(result, context)`.
- `context = {marketplace, sourceUrl, profile, scrapeProfile, mode, userId, credentials, hasAffiliate, affiliateConverter, signal}`. Credenciais **não** entram no `ScrapeCapture`.
- O facade:
  - `legacy`: retorna `items` como estão (passthrough) e aceita `discarded` do provider;
  - `shadow`: usa `items` legados como baseline e chama o pool para a amostra; 1 extração local + 1 pool por amostra; `discarded` final é o do legado;
  - `pool`: usa `capture.html` + `sourceUrl` para chamar o pool, revalidar e pós-processar; **zero extração local**; `discarded` final é do facade.
- `mode` é resolvido **uma vez** (`resolveMode()`) e passado ao provider e ao facade; não há dupla decisão.
- Nenhum caller chama o pool diretamente.
- **Pós-processamento no facade (paridade obrigatória):** host → permalink canônico → conversão de afiliado via `affiliateConverter`/`credentials` → `externalProductId` na convenção da app (`MLB-...`, itemId Shopee) → `classifyCategory`/`isPricePlausible` → gate BRL → `categories`/`categoryReview` → `discarded`. `hasAffiliate` continua na chave do `SearchGuard`.
- Falha de afiliação **não** derruba o card: mantém `permalink`, marca `needsReview`/`affiliateError` quando aplicável.
- Comportamento por modo:
  - `legacy`: facade faz passthrough dos `items` finais do provider; **não reextrai/reprocessa**.
  - `shadow`: legado + pool em 5% amostrado; custo assumido e medido.
  - `pool`: facade chama o pool; **zero chamadas a `extractOffers` local**.
- **Sinal de página boa (`pageHealthy`):** `htmlBytes >= limiar`, `!looksLikeBotChallenge(html)`, e `(!scrapeProfile.requiresBrl || hasBrlSignal(html, probe))`. A sonda JSON/DOM de `"priceCurrency":"BRL"` roda para todos os perfis; `requiresBrl` só torna o sinal obrigatório. Helpers saem de `scrape/index.ts` para módulo compartilhado; limiar `EXTRACTOR_PAGE_MIN_BYTES`.
- **Matriz `pageHealthy` (por fonte, não por busca):**
  - challenge/anti-bot → no máximo 1 render, **pula aquela fonte e continua**; 503 `PROVIDER_UNAVAILABLE` (`ALL_SOURCES_BLOCKED`) quando **nenhuma** fonte respondeu; infra do pool → 503; `NO_CARDS` → 200; testar 2 fontes (uma bloqueada, uma saudável) e ambas bloqueadas;
  - página válida sem sinal de preço BRL **quando `requiresBrl`** → **1 fetch por fonte e para aquela fonte**, vazio + métrica; o loop de fontes continua; em perfis sem `requiresBrl`, a ausência de preço é decidida pelo extractor/facade, não pelo gate;
  - página com preço/cards → segue;
  - budget `EXTRACTOR_PAGE_BUDGET` por fonte e global; primeira fonte vazia não impede a segunda.
- `discarded`/`categoryReview` derivados do `rejected`/gates do pool, com mapeamento dos 8 buckets (`missingTitle`, `missingPrice`, `missingImage`, `invalidLink`, `notAProduct`, `ambiguousPrice`, `currency`, `irrelevant`); `invalidLink`/`irrelevant` são gates locais do facade.
- **Ofertas Automáticas** é o produtor da fila bulk (`priority=bulk`, `ownerId`, orçamento próprio) via o mesmo facade; a Fase 4 só está no MVP com esse produtor e usa o padrão 202 já existente em `autoOfferController`. O FRONT síncrono não usa fila longa.
- Caminho de API oficial (sem HTML) usa `legacy`/`/v1/adjudicate` ou `/v1/execute`; não usa pool de extração.
- `affiliateUrl` gerado no facade após permalink.

> **Substituído por §16.9 (revalidação v2 por schema/host/preço/moeda/imagem/permalink).**

### 7.3 Revalidação central

1. `priceCents>0`, `currency==='BRL'`.
2. `originalPriceCents` null ou `> priceCents`.
3. `imageUrl` http(s) host permitido.
4. `permalink` host do marketplace.
5. `selection` IDs existem em `candidates`; `evidence.cardRoot` resolve no HTML original e `pointer|selector|occurrence` são resolvidos **dentro** dele (não no documento). Título por igualdade/substring normalizada; preço reparseado para cents e comparado; imagem por URL normalizada; texto livre com mínimo de 3 tokens. Gramática versionada (`contractVersion`) e teste golden multi-card (preço do card N não casa com o card 1).
6. `externalProductId` consistente com permalink.
7. `cardId` único; se `coverageComplete=true`, cobertura `|cards ∪ rejected| == min(scanned,maxCards)`; se `false`, tratar como parcial/needsReview, não 503.
8. Falha -> `needsReview`, nunca descarte silencioso.

> **Substituído por §16.4/§16.7** (contrato v2 sem `evidence`/`cardRoot`).

### 7.4 Mapeamento

| API | Origem |
| --- | --- |
| title | card.title |
| price | card.priceCents |
| originalPrice | card.originalPriceCents |
| currency | card.currency |
| image | card.imageUrl |
| permalink | card.permalink |
| externalProductId | card.externalProductId |
| extra | card.extra |
| affiliateUrl | API, após permalink |
| needsReview | card ou falha de revalidação |
| extractionSource | `pool`/`legacy`/`deterministic` |
| aiModelVersion | modelId/modelVersion |

> **Substituído por §16.3 D5** (`desiredStatus`/`observedStatus`, sem `status`, sem `trimmerVersion` da API).

### 7.5 Boot/degraded

- Allowlist semeada com `desiredStatus='auto'` e `observedStatus='offline'` (v4.7; `status` não existe).
- Boot falha só por config inválida; pool vazio -> `degraded`/`legacy` + alerta.
- `AI_EXTRACTOR_MODE=pool` exige Mongo **no central**; extractor pode memory.
- Reservas sempre no Mongo; não há modo “reserva local sem persistência”.
- Se `REPLICA_COUNT>1`, a reserva atômica no Mongo é obrigatória; boot falha se Mongo indisponível.
- Versão/contrato/coreVersion incompatível -> instância não recebe tráfego, sem derrubar o central.
- `trimmerVersion` é do recorte genérico da **API** (não do extractor): vai no meta, é ecoado na resposta e entra no cache/job; não entra no gate de elegibilidade. O extractor valida e ecoa o valor recebido.
- Mudança na gramática de normalização/evidência bumpa `contractVersion`; `coreVersion` compatível é major.

### 7.6 Rollout

- `legacy` default; `shadow` 5% com bucketing estável; `pool` 5%→25%→100%.
- Diff no mesmo HTML/requestId.
- Rollback se fallback >5%/5min ou p95 > budget.
- `draining` sai da seleção e conclui in-flight.
- Gate de qualidade antes de 100%.

---

### 7.7 UX e estados

> **Fora do escopo deste ciclo (D12/§16.10.4).** Nada aqui pode virar critério de aceite desta
> entrega: o FRONT não é alterado. Os itens estão registrados como dependência para o time do FRONT.

- **Busca normal:** skeleton atual.
- **Aguardando capacidade (>2,5s):** feedback discreto “aguardando capacidade de extração” após 500ms; nunca spinner silencioso.
- **Fallback legado durante migração:** badge “extração local” e `needsReview` quando aplicável; não corrigir resultado depois de exibido.
- **NO_CARDS (`reason/quality`):** estado vazio com contadores de `discarded`/`rejected`, distinto de “nenhuma oferta encontrada”; não toast de erro.
- **503 após remoção do legado:** mensagem “tente novamente em instantes”, respeitar `Retry-After`, sem retry cego do react-query. Requisito técnico: `retry: 0` para 503/`Retry-After` nessa mutation/query (o `queryClient` global tem `retry:1`).
- **Jobs assíncronos:** somente Ofertas Automáticas (Fase 4), reutilizando o padrão de polling/202 existente e exigindo `ownerId`; a busca do FRONT não usa 202.
- **Testes de UI:** estados, copy, tempo de feedback, 503/Retry-After, vazio vs erro e ausência de correção silenciosa.
- `systemStatus` do central é propagado na resposta da busca via header `x-system-status` (cache curto) e no health/admin; a UI combina com `quality` do card.
- Adicionar `X-System-Status` a `exposedHeaders` no CORS da API (hoje só `X-Search-Trace-Id`); sem isso o browser não lê o header. Em 503, a UI usa health/admin como fallback.

## 8. Segurança

- Rotas internas fora do limiter público; limiter próprio.
- HMAC por instância, bootId, seq, timestamp; replay rejeitado.
- Allowlist DNS; hostname estrito; HTTPS; bloquear IP privado/loopback; `redirect:'error'`.
- `x-internal-key` + HMAC; rotação documentada.
- HTML sem JS; parser seguro; limite de bytes/profundidade; zip bomb.
- Prompt injection: só candidatos ao LLM; system declara dado não confiável.
- Sem HTML/preço/URL em logs por padrão; `LLM_DEBUG_PROMPT` proibido no pool.
- Jobs com owner/quota.
- Resposta limitada por schema/tamanho.

---

## 9. Observabilidade

- Instância: use/useRaw/reportedInflight/reserved/capacity/queue/eventLoop/p95/stale/saturated.
- Request: requestId/searchId/marketplace/instance/score/wait/parse/llm/total/mode/fallback/truncated.
- Pool: dispatch/retry/queue_age/fallback_busy/fallback_error/breaker/lease_expired/reserved_divergence.
- Alertas: stale >2×; todas >75% por 2min; fila >80%; fallback_error >5%; p95 > budget; HTML_TOO_LARGE >1%; zero-card >1%.

---

## 10. Testes

### 10.1 Unitários

- CPU cgroup/proc/Windows; unsupported exclui.
- Heartbeat HMAC, bootId/seq, canonicalização, replay, allowlist, clock skew.
- Scheduler: score, capacity, max(reserved,reported), histerese, stale, versão, plataformas, breaker, concorrência, reserva órfã, release duplo.
- Fila: claim, lease, attempts, TTL terminal, idempotência, owner, backoff.
- Extração: fixtures, JSON-LD, DOM, BRL, original, imagem, challenge, HTML grande, zero cards, prompt injection, evidência, candidatos.
- Recorte não destrutivo: `extract(original) == extract(recortado)` em **todos** os fixtures (DOM parity, JSON-LD off).
- Revalidação central: quote/path/host/cobertura.
- Regressão `/v1/adjudicate` e `/v1/execute`.

### 10.2 Integração

- 2 extractors mockados; menos ocupado; 75/60; stale; timeout; 429 sem breaker; versão mista; malformado; zero cards -> 200 vazio (nunca 503).
- 1MB/1.2MB/gzip/zip bomb; 200 cards; 10 LLM cards.
- API oficial sem HTML -> legacy.
- `pageHealthy`: challenge (1 render + pula fonte; 400 só se todas bloqueadas), infra (503), página vazia/sem preço (1 fetch e para), página com cards; contar fetches/renders; preço só em JSON para Amazon/ML/Shopee **é extraído**.
- Múltiplas fontes: primeira vazia → segunda é tentada; budget por fonte e global.
- Facade: legacy passthrough byte-idêntico (links/IDs/categorias/8 contadores); shadow 1 extração local + 1 pool por amostra; pool zero `extractOffers`; pós-processamento/afiliado/failure não fatal; `sourceUrl` correto.
- Fila interna (sem 202 de busca; 202 existente do autoOfertas): claim/lease/ownership/idempotencyKey.
- Boot com pool vazio -> degraded; config inválida -> falha.

### 10.3 Carga (2 vCPU)

- 1MB, 1,5 req/s por instância, p95 ≤800ms determinístico; LLM p95 ≤3s; event loop ≤100ms; CPU ≤70%.
- 2 instâncias/20 concurrent: distribuição 40–60%, fallback ≤1%.
- 4 instâncias/50 concurrent: fila/fallback controlados.
- Medir p95 busca completa ≤45s.

### 10.4 Qualidade

- ≥100 cards rotulados/plataforma.
- Preço exato ≥99,5%; título ≥95%; imagem ≥97%; zero valor fora do HTML.
- Paridade legacy vs pool por fixture.
- Regressão >0,5 p.p. falha build.

---

> **Substituído por §16.11** (etapas A–G com provisionamento, fila e rollback).

## 11. Fases

0. Baseline/go-no-go + ADR + contratos.
1. Extração no extractor com paridade golden + `/v1/extract` raw/gzip + recorte.
2. Registry/heartbeat/reservas/CPU.
3. Scheduler/deadline/breaker.
4. Fila/async **somente com Ofertas Automáticas como produtor** (usa o padrão 202 existente); sem esse produtor, Fase 4 fica fora do MVP.
5. Integração API (`htmlRef`, revalidação, cache key, modos, facade `extractionGateway`).
6. Carga/rollout.

---

> **Substituído por §16.14.** `htmlRef`/TTL de HTML não existem na v4.4 (HTML nunca persiste).

## 12. Riscos

| Risco | Mitigação |
| --- | --- |
| CPU 3 min | 30s default + in-flight + reserva + breaker |
| overcommit | reserved/reported/capacity + lease + sweep |
| reserva órfã | TTL + sweep 30s + alerta |
| fila com HTML | descritor + htmlRef + bytes cap |
| perda de cards | NO_CARDS 200 vazio + cobertura + eval |
| duplicação | port + parity golden; sem cópia permanente |
| rate limit | rotas internas fora do limiter |
| 429 tempestade | 429 não abre breaker |
| deadline | deadline absoluto + sem retry sem folga |
| CPU inválida | unsupported exclui |
| Mongo hot path | snapshot em memória para seleção; reserva persistida no Mongo (1–3/s) |
| shadow dobra CPU | 5% + cache/replay |
| HTML grande | trim + 1MB + gzip + 413 |
| segurança | HMAC/bootId/allowlist/revalidação/logs |
| boot vazio | seed `desiredStatus='auto'` + degraded, não fail |
| seq restart | bootId reinicia seq |

---

## 13. Decisões fechadas

1. ~~Heartbeat 30s (180s configurável, grosseiro).~~ **Substituído por §16.8**: liveness 20 s + snapshot 180 s.
2. Sync wait 2,5s + fallback/503; fila só async.
3. HTML recortado 1MB, gzip 512KB.
4. N VPS 2 vCPU + API separada.
5. Dono único da extração = ai-extractor; legado temporário; depois 503 + `Retry-After` (UI é dependência do FRONT, não deste ciclo).
6. Plataformas iniciais: Amazon e Mercado Livre. **Shopee só entra no pool após a Etapa E** (worker precisa de browser ou de unblocker com SLA); até lá permanece no legado (§16.3 D3).
7. LLM externo; sem modelo local.

---

## 14. Critérios de aceite

1. 1MB/gzip 200; 1–1,2MB `HTML_TOO_LARGE`; >1,2MB `PAYLOAD_TOO_LARGE`; zip bomb rejeitado.
2. Grounding: `cardRoot` resolve no HTML original; selection ∈ candidates; quote/path/occurrence dentro do root; fixture multi-card prova que o preço do card N não casa com o card 1; zero valor fora.
3. Scheduler: score; 75/60; `max(reserved, inflight) < capacity`; reserva liberada no terminal (não por TTL de 120 s); histerese. *(v4.4)*
4. Heartbeat HMAC/bootId/seq; spoof/replay rejeitado.
5. 429 -> outra instância sem breaker; timeout -> fallback/503; zero perda.
6. Fila interna: descriptor/claim/lease/attempts/TTL/owner/idempotencyKey; sem 202 **de busca** no MVP (202 existente do autoOfertas permanece).
7. Paridade DOM legacy/pool (JSON-LD off); eval ≥100 cards/plataforma e metas; JSON-LD avaliado separadamente.
8. Carga: 1,5 req/s, p95 800ms, LLM 3s, event loop 100ms, CPU 70%, fallback ≤1%.
9. Shadow 5%→25%→100%, rollback, version gate, drain.
10. Legacy/execute sem regressão.
11. Rotas internas fora do limiter; logs sem HTML/preço.
12. Pool exige Mongo no central; pool vazio -> degraded; config inválida -> fail.
13. HTML fora de `MarketplaceProductSearchResult`; cache key versionada; pipeline ordem fixa.
14. API: `503` com `Retry-After` e `X-System-Status` coerentes; sem correção silenciosa de resultado. Consumo no FRONT é dependência registrada (§16.10.4), **não** aceite desta entrega.
15. `NO_CARDS_EXTRACTED` retorna 200 vazio, nunca 503; `coverageComplete=false`/recorte >1MB não derrubam a busca.
16. Recorte não destrutivo: extração com e sem recorte produz o mesmo conjunto em todos os fixtures (DOM parity, JSON-LD off).
17. Facade: falha de afiliação não remove o card; legacy não reextrai; pool não chama `extractOffers`.
18. Job com `trimmerVersion/coreVersion` antigo é reprocessado; `idempotencyKey` único evita duplicata; `contractVersion` incompatível rejeita.
19. `pageHealthy` com preço só em JSON (sem “R$”) extrai; primeira fonte vazia não impede a segunda.
20. `X-System-Status` exposto no CORS (API); consumo pelo FRONT é dependência registrada, **não** aceite desta entrega (§16.10.4).
21. Shadow compara final×final (legado pós-processado × pool pós-processado) e conta 1 extração local + 1 pool por amostra.
22. `trimmerVersion` entra na chave pré-fetch e no cache de resultado; bump invalida.

---

## 14.1 Notas de implementação (P2, não bloqueiam)

> Itens de reserva/TTL/UX substituídos por §16 (§16.5/§16.10/§16.15).

- `pageHealthy` aplica-se a `shadow`/`pool`; `legacy` mantém a cascata atual.
- `trimmerVersion` valida **formato**, nunca allowlist, para deploy escalonado.
- Em `pool` com versões mistas, `extractorVersion` da chave pré-fetch é a versão-alvo do deploy; a versão real da instância vai no carimbo da resposta/cache.
- Shadow em cache hit: amostrar no hit ou contar o hit como “não amostrado” na métrica de cobertura.
- `NO_CARDS_EXTRACTED` é resposta de qualidade (200), não erro de transporte.

---

## 15. Registro de revisão

| Data | Revisor | Modelo | Veredito | Bloqueios |
| --- | --- | --- | --- | --- |
| 2026-10-27 | `general` (free) | não exposto | REPROVADO | P0.1 inflight; P0.2 fila HTML; P0.3 cap 30 vs 200; P0.4 contrato/limites; P0.5 CPU/topologia |
| 2026-10-27 | `revisor-backend` | Muse Spark 1.3 | REPROVADO | rate limit; body; inflight; seleção; ADR-005; HTML; POOL_LIMIT; vazio |
| 2026-10-27 | `revisor-produto` | Claude Haiku 5.5 | REPROVADO | 3min/fila; limites; invariante; scheduler; performance; deadline |
| 2026-10-27 | `revisor-backend` (v2) | Muse Spark 1.3 | REPROVADO | recorte×JSON-LD/grounding; capacity/SLO/deadline; reserved sweep; URL na query; NO_CARDS |
| 2026-10-27 | `revisor-produto` (v2) | Claude Haiku 5.5 | REPROVADO | boot fail-closed; seq/bootId; reserved sweep; fallback/duplicação; HTML no retorno/pipeline |
| 2026-10-27 | `revisor-backend` (v2.1) | DeepSeek V4.1 Flash | REPROVADO | evidence/path+quote; NO_CARDS×cobertura; HTML via cache best-effort; extração dupla em pool; htmlHash na cache key |
| 2026-10-27 | `revisor-produto` (v2.1) | DeepSeek V4.1 Flash | REPROVADO | NO_CARDS→503; htmlHash na cache key; reserved local vs sweep; UX/503 sem escopo |
| 2026-10-27 | `revisor-backend` (v2.2) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | recorte §0.3×§6.3; hash/versão nos caches; controle de fluxo do scrape em pool |
| 2026-10-27 | `revisor-produto` (v2.2) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | seam provider/autoOfertas/fila sem produtor; desfechos de qualidade ainda viram 503; recorte §0.3×§6.3 |
| 2026-10-27 | `revisor-backend` (v2.3) | DeepSeek V4.1 Flash | REPROVADO | seam/facade indefinido; `occurrence` sem `cardRoot` |
| 2026-10-27 | `revisor-produto` (v2.3) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | pós-processamento do seam; pageHealthy em página vazia; cardRoot |
| 2026-10-27 | `revisor-backend` (v2.4) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | facade sem contexto de usuário/afiliado; coreVersion fora do gate; recorte >1MB contraditório |
| 2026-10-27 | `revisor-produto` (v2.4) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | contexto de afiliado/rawOffers; budget página×fonte; escopo da Fase 4 |
| 2026-10-27 | `revisor-backend` (v2.5) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | legacy regression no seam; versões/idempotência no job; degraded/requiresBrl |
| 2026-10-27 | `revisor-produto` (v2.5) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | pageHealthy BRL em perfis sem requiresBrl; capture/context sem sourceUrl; trimmerVersion×cardTrimmerVersion |
| 2026-10-27 | `revisor-backend` (v2.6) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | rawOffers `[]`×populado; degraded com duas definições; trimmerVersion formatos/dono |
| 2026-10-27 | `revisor-produto` (v2.6) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | legacy inalterado×pós-processamento; challenge 400×503; window da idempotência |
| 2026-10-27 | `revisor-backend` (v2.7) | DeepSeek V4.1 Flash | REPROVADO | trimmerVersion formatos/dono; degraded duplicado; shadow sem baseline legado |
| 2026-10-27 | `revisor-produto` (v2.7) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | shadow baseline; challenge por fonte; runId manual |
| 2026-10-27 | `revisor-backend` (v2.8) | DeepSeek V4.1 Flash | APROVADO COM RESSALVAS | CORS x-system-status; fronteira pós-processamento legacy/shadow; trimmerVersion na chave pré-fetch |
| 2026-10-27 | `revisor-produto` (v2.8) | DeepSeek V4.1 Flash | APROVADO | sem bloqueios; notas P1 de CORS/shadow cache hit/vocabulário |
| 2026-10-27 | `revisor-backend` (final) | DeepSeek V4.1 Flash | **APROVADO** | nenhum |
| 2026-10-27 | `revisor-produto` (final) | DeepSeek V4.1 Flash | **APROVADO** | nenhum; notas P2 de implementação |

**Correções v2.2.0:** evidência com `source/pointer|selector|occurrence` + validação por campo; `coverageComplete` e NO_CARDS 200; HTML lateral + cache awaited; pool sem extração local; SearchGuard sem hash; reservas no Mongo; UX; sem 202 público; paridade DOM.

**Correções v2.3.0:** lista única de recorte + teste não destrutivo; hash/versão nos caches; seam no provider + Ofertas Automáticas como produtor da fila + `pageHealthy`; matriz de desfechos; `occurrence` relativo ao cardRoot; cap de disco; retry 0; artefato compartilhado; aceites 15/16.

**Correções v2.4.0:** facade explícito `extractionGateway`; `ScrapeCapture`; pós-processamento canônico; `pageHealthy`; `cardRoot`; versões no heartbeat/cache; store content-addressed; Fase 4 condicionada; `degraded` no NO_CARDS.

**Correções v2.5.0:** contexto do facade; `rawOffers` sempre vazio; `coreVersion` no meta/gate; `trimmerVersion`; recorte >1MB vazio/parcial; budget por fonte; Fase 4 no MVP via autoOfertas; `cardRoot`; `NO_CARDS` com `quality`; caches versionados.

**Correções v2.6.0:** legacy mantém extração/cascata no provider; job guarda versões/idempotência; `degraded` × `systemStatus`; `requiresBrl` + sonda JSON; `sourceUrl`; `trimmerVersion` unificado; `discarded` por modo.

**Correções v2.7.0:** `ScrapeResult` explícito (`legacy` passthrough × `capture` shadow/pool); `rawOffers` só no legacy; `mode` resolvido uma vez; challenge 400 vs infra 503; `window`/`runId`; `systemStatus`; legacy byte-idêntico; `discarded` por modo.

**Correções v2.8.0:** `trimmerVersion` único `trim@1`, dono API/extractor ecoa, fora do gate; `degraded` com definição única e matriz; `shadow` devolve `items` legados reais + capture; challenge por fonte (400 só se todas bloqueadas); `runId` no descritor/idempotência; `systemStatus` via header/health; aceites atualizados.

**Correções v2.9.0:** CORS `X-System-Status`; legacy final/passthrough e shadow final×final; `trimmerVersion` na chave pré-fetch; `ScrapeResult` com `legacy|shadow|capture`; `systemStatus` em header/health; aceites 20-22.

**Pendente:** revisão final de confirmação. Não implementar antes da aprovação.

**Correções v3.0.0 (adendo):** estado do pool publicado **pelo próprio extractor** em `tb_aiExtractorInstances` (upsert a cada 180s com CPU/in-flight/capacidade/plataformas/versões/`lastSeenAt`); a API central apenas consulta e mantém a posse de `reserved`/reservas; `draining` no shutdown; config de IA lida direto de `tb_aiextractorconfigs` (`AI_CONFIG_SOURCE=mongo`) com `CREDENTIALS_ENC_KEY` compartilhada e polling de 30s; staleness default 300s; heartbeat HTTP vira modo legado (`EXTRACTOR_STATE_MODE=central`); `LLM_PROVIDER=fake` segue proibido em produção apenas quando `AI_CONFIG_SOURCE=env`.

**Correções v3.1.0 (contrato v2 — coleta no extractor):** a API não busca/renderiza/recorta HTML no modo `pool`/`direct`; ela resolve as URLs e chama `POST /api/v1/extract-offers` do extractor com `{marketplace, urls, query, profile, mode, deadlineAt}`. O extractor faz fetch (unblocker Decodo → proxy → HTTP), challenge/trim, extração determinística e revalidação, devolvendo `RawOffer` já validado. `SCRAPE_UNBLOCKER_AUTH`/`SCRAPE_PROXY_URL` migram para cada instância; `AI_EXTRACTOR_POOL_SCRAPE_TIMEOUT_MS=120s` e `AI_EXTRACTOR_RESERVATION_TTL_MS=180s`. O endpoint legado `/api/v1/extract` permanece para rollback.

## Estado da implementação (MVP, 2026-10-27)

> **Fotografia histórica.** Não representa o alvo da v4; onde divergir de §16, prevalece §16.

Implementado e testado:

- **Extractor (`ai-extractor-api`)**: `POST /api/v1/extract` com corpo binário/gzip, `x-extract-meta`, validação de `contractVersion`/`htmlHashTrimmed`/`htmlBytes`, tetos de 1 MB/512 KB/1,2 MB; extração determinística por plataforma (Amazon, Mercado Livre, Shopee, AliExpress, Shein) por JSON-LD + DOM; adjudicação opcional via perfil `cards`; `no_cards` = 200; **contrato v2 `POST /api/v1/extract-offers`**: busca a página (unblocker/proxy/HTTP), resolve challenge, recorta, extrai e revalida; estado do pool publicado direto no Mongo com `draining` no shutdown.
- **API central**: schemas `tb_aiExtractorInstances`/`tb_aiExtractorReservations`; registry com saturação 75/60, elegibilidade por CPU+contrato+plataforma+stale, score `0.6*CPU + 0.4*ocupação`, reserva atômica (`max(reserved,reportedInflight) < capacity`), release e sweep de 30 s com TTL; allowlist semeada no boot; endpoints internos de heartbeat/health/instances/eligible/sweep com `x-internal-key` (tempo constante) + HMAC.
- **Cliente do pool**: recorte genérico `trim@1` antes do envio (nunca trunca; >1 MB = vazio autoritativo `html_too_large_after_trim`), gzip, retry em conexão/429/502/503/504 (máx. 2 instâncias), timeout de busca síncrona de 2,5 s (bulk 15 s), espera curta por capacidade quando todas estão saturadas, cache de resultado por hash+versões e revalidação central (preço/moeda/imagem/permalink/ID/evidência → `needsReview`, nunca descarte silencioso).
- **Modos**: `legacy` default (caminho atual preservado), `pool` (zero extração local, `no_cards` autoritativo) e `shadow` (amostra estável de 5%, pool em paralelo ao legado, sem latência adicional).
- **Pipeline**: `MarketplaceService` e `autoOfferSearch` usam o mesmo hook; challenge continua por fonte (400 só quando todas bloqueiam); `discarded` do pool é mesclado ao do provider.
- **Observabilidade/UX**: header `X-System-Status` em `/api/v1` + `/api/v1/health` (`ok|degraded|unavailable`, cache de 5 s com single-flight e escopo por plataforma); CORS expõe o header e `Retry-After`; FRONT lê o header, trata 503/`Retry-After` sem retry cego (queryClient e mutations), mostra estado degradado, estado vazio próprio para `no_cards`/`all_rejected`/HTML grande e feedback “aguardando capacidade” após 500 ms.
- **Fila (MVP)**: o job 202 de Ofertas Automáticas é o produtor assíncrono; quando o pool está saturado, a chamada espera até o orçamento bulk (15 s) por capacidade da PLATAFORMA e, esgotado, cai no legado (migração). Não há fila durável nova no MVP — o FRONT síncrono nunca espera além de 2,5 s (aproximado pelo deadline).
- **Reserva**: locks por slot `(dns, slot)` com índice único (admissão nunca depende de contador lido/escrito); índices do pool falham o boot se não puderem ser criados; `reserved` é métrica reconciliada por CAS no sweep. Extractor tem admissão local (`EXTRACTOR_CAPACITY` → 429 `EXTRACTOR_BUSY` + `Retry-After`) e mantém a vaga até o trabalho real terminar (timeout devolve 504 sem liberar CPU fantasma).
- **Config de IA (admin)**: tabela `tb_aiExtractorConfigs` (singleton) editável em **Admin → IA Lab**; provider/modelo/baseUrl/apiKey (cifrada), modo e limites. O `ai-extractor-api` aplica no boot (`GET /api/v1/internal/ai-extractor/config`), no ACK do heartbeat (30 s) ou por push do botão “Testar modelo”, sem reiniciar e sem `.env`.
- **Modo `direct`**: `AI_EXTRACTOR_MODE=direct` chama `AI_EXTRACTOR_URL` sem pool/Mongo (dev/local) e, nesse modo, a API nunca cai no extrator local (falha → 503 com `Retry-After`). `pool` continua escolhendo a instância menos ocupada.
- **Page health**: `no_cards` do pool só encerra a cascata quando a página é saudável (fora do cache, ≥ `AI_EXTRACTOR_PAGE_MIN_BYTES`, sem challenge, sinal BRL quando `requiresBrl` e sinal de listagem — JSON-LD/âncora de produto/`productId`); shell JS (mesmo >20 KB) continua para fetch/render.
- **Sem fallback legado** (`AI_EXTRACTOR_LEGACY_FALLBACK=false`): erro/indisponibilidade do pool vira `503` com `Retry-After`; challenge continua `400`; `shadow` + fallback desligado falha o boot.

Diferenças conscientes em relação ao desenho completo: o facade ainda é o hook `extractRemote` do provider (não existe `ScrapeResult` formal); a fila bulk é a espera limitada acima (sem coleção de jobs nova); a evidência valida os quotes no DOCUMENTO (não no escopo estrito do `cardRoot`) para não invalidar layouts sem container estável — o risco residual é um valor do card N existir em outro card; shadow compara contagens (não diff final×final), então não serve como gate de rollout; SSRF bloqueia IPs literais (IPv4/IPv6, mapeados inclusive hex) e exige HTTPS em produção, mas DNS rebinding depende do resolver do host.



## 16. Conformidade com o PLAN2 (workers distribuídos) — v5.2.0

Esta seção responde ao `docs/PLAN2/vupia-plano-workers-distribuidos.md` (e ao `DIAGRAMA.png`) sem
reescrever a arquitetura existente. É normativa a partir de 2026-11-04.

**Escopo deste modelo:** extractor + API central. **O FRONT não é alterado neste ciclo** (decisão de
2026-11-04). Os itens de experiência que dependem do FRONT ficam registrados como dependência (§16.10.4),
não como etapa deste plano.

**Consolidação normativa (N1).** Onde esta seção conflitar com o texto anterior, **§16 prevalece** e as
seções antigas ficam marcadas como substituídas: §0 itens 2/5 (503 + UI, 2,5 s), §3.2–§3.4 (reserva por
`dns`, heartbeat/estado), §4.1–§4.6 (budgets, release em `finally`), §5 (fila com `htmlRef`/TTL 15 min),
§6.3/§7.1–§7.5 (ScrapeResult/capture/pageHealthy/scrapeCache/trimmer), §7.7 (estados de UI), §11, §13
item 6 (plataformas iniciais) e §14 itens 14/20 (aceites de FRONT). Permanecem normativos **apenas** o
contrato v2 `POST /extract-offers` e o rollback `/v1/extract`. O
bloco “Estado da implementação (MVP)” descreve o estado de 2026-10-27, não o alvo desta versão.

### 16.0 Leitura do diagrama

O `DIAGRAMA.png` desenha: `FRONTEND` ↔ `API` (usuário, planos, plataformas, administrativo, disparos) e,
dentro da API, um **HUB/SWITCH** que “identifica o servidor de serviço menos ocupado e direciona a
chamada”; `API-SERVIÇO(0..n)` executam busca/scraping. Não há banco, cache, Chromium ou fila no desenho.

Portanto: **o caminho síncrono continua push (HUB/SWITCH)**. O modelo **pull** do PLAN2 entra apenas
onde há trabalho assíncrono com recuperação necessária: **Ofertas Automáticas (bulk)**.

### 16.1 Diagnóstico do código real (corrigido após revisão)

| # | Pergunta do PLAN2 | Resposta verificada |
| --- | --- | --- |
| 1 | Chromium por requisição ou persistente? | `API/src/providers/marketplace/scrape/browser.ts` faz `chromium.launch` (Playwright) e cria contexto/página por render. O **worker não tem browser**: `ai-extractor-api/package.json` não traz `playwright`/`puppeteer`. |
| 2 | URLs em série ou paralelo? | Em série: `marketplaceService.ts` (`for (const [sourceIndex, source] of urls.entries())`), com orçamento global de **35 s** (`SCRAPE_BROWSE_BUDGET_MS`) checado **entre** fontes; o abort **não** é propagado ao pool. |
| 3 | Biblioteca de Chromium | Playwright, importado dinamicamente, só no `legacy`/render da API. |
| 4 | Formato devolvido ao FRONT | JSON `MarketplaceProductSearchResult[]`; HTML nunca é serializado. |
| 5 | FRONT precisa de HTML? | Não. Contrato v2 devolve ofertas validadas. |
| 6 | Cache por usuário/plataforma/busca? | `SearchGuard`: `userId\|marketplace\|query\|page\|limit` + modo/versões (10 min). HTML em arquivo: TTL **10 min**. Cache de resultado do pool v1: **memória do processo, 5 min** (`poolClient.ts`). |
| 7 | O que define 5/30 min? | Não existe 30 min no código. Existem 10 min (HTML/pool de busca), 5 min (cache de resultado v1) e 6 h (`tb_autoOfferSearchCache`). O PLAN2 usa números antigos; o plano adota a tabela de §16.7. |
| 8 | Credencial individual? | Só na busca por API oficial (usuário/global). Scraping não usa credencial; credencial nunca entra no job. |
| 9 | Links de busca? | `tb_scrapeRoutes` + `SCRAPE_SOURCES`/`buildScrapeUrl`, editáveis no admin. |
| 10 | Mesmo Mongo? | Sim (Atlas). Worker abre conexão própria e lê `tb_aiextractorconfigs`; API usa `tb_aiExtractor*`. |
| 11 | Volume de HTML | Recorte máximo 1 MB (gzip 512 KB); páginas reais ~0,6–1,3 MB antes do recorte. |
| 12 | Tempo por plataforma | Busca completa p95 ~17–45 s; `extract-offers` 2–36 s (AliExpress/unblocker é o pior caso). O **bulk v1** tem timeout de 6 s e não cabe nesse pior caso. |
| 13 | Concorrência entre URLs? | Não; sequencial. |
| 14 | FRONT em demora/erro? | **Não há tratamento de 503/`Retry-After` no `FRONT/src`**; `queryClient` tem `retry:1` e a busca é `useMutation` com toast usando `data.message`. Nada de `X-System-Status`. A copy do 503/429 é, portanto, responsabilidade da **API** (§16.9.1 P4). |
| 15 | Worker no mesmo repo? | Repositório próprio, processo HTTP separado, sem browser hoje. |

**Fatos que a v4.0.0 errava e agora estão corrigidos**

- O caminho síncrono do contrato v2 **não** tem orçamento de 2,5 s: `extractOffersViaPool` usa
  `AI_EXTRACTOR_POOL_SCRAPE_TIMEOUT_MS` (120 s) por fonte e não recebe `signal`/`waitMs`. O 2,5 s pertence
  ao fluxo v1 (bulk/shadow). O teto real de uma busca com 5 fontes pode chegar a ~10 min.
- O bulk v1 usa 6 s de timeout HTTP (`AI_EXTRACTOR_POOL_TIMEOUT_MS`), não 15 s.
- `capacity` real do extractor e do schema é **2** (`EXTRACTOR_CAPACITY=2`), não 1.
- `x-extractor-key` por instância **não existe** hoje; só há `x-internal-key` compartilhada.
- O estado no modo Mongo é **auto-reportado sem assinatura**; `status` é escrito pelo worker e sobrescreve
  qualquer `draining` administrativo.
- `assertInternalKey` do control plane é **no-op com chave vazia**; não há fail-closed no boot da API.
- O caminho v2 **não revalida** as ofertas do worker (só `Array.isArray`).

### 16.2 Gap analysis (atualizado)

| # | Requisito PLAN2 | Estado atual | Ação v4.1.0 | Etapa |
| --- | --- | --- | --- | --- |
| G1 | Fila pull durável (§6) | Inexistente | `tb_aiExtractorJobs` com claim/lease/attempts | C |
| G2 | HUB/SWITCH no síncrono (§DIAGRAMA) | Implementado | Manter (ADR-006) | A |
| G3 | Claim atômico (§6.2) | Não existe | `findOneAndUpdate` com filtro completo (§16.6) | C |
| G4 | Lease/renovação/recuperação (§6.4) | Só TTL de reserva | Lease 180 s renovado a cada 20 s + watchdog | C |
| G5 | Idempotência/posse (§6.5) | Release de slot | CAS por `workerId+leaseToken` em **toda** transição | C |
| G6 | `workerId` estável (§7.2) | `dns` é identidade | UUID persistido em arquivo; `dns` vira metadado | B |
| G7 | Heartbeat 15–30 s (§9.2) | Snapshot 180 s | Heartbeat 20 s (parcial) + snapshot 180 s | B |
| G8 | Concorrência por benchmark (§9.3) | `capacity=2` fixo | Default 1, clamp 2, benchmark com N≥30/plataforma | B |
| G9 | Cache/entrega do resultado (§8) | HTML nunca sai do worker; resultado só em memória | `tb_aiExtractionResults` (Mongo) + TTL coerente (§16.7) | C |
| G10 | Freshness (§8.1) | 10 min HTML/pool; 5 min resultado; 6 h autoOfertas | Tabela única de TTL + `fetchedAt` no payload | C |
| G11 | `draining` (§13) | Só no shutdown, sobrescrito | `desiredStatus` (admin) × `lastHeartbeatAt` (worker) + reaper | B |
| G12 | Logs `jobId/workerId` (§13.1) | `requestId` | Campos novos já na Etapa C | C |
| G13 | Segurança (§11/§16) | Chave global, sem fail-closed, `redirect:'follow'` | Chave por instância, fail-closed, redirect manual, RBAC Mongo | B |
| G14 | 20 testes obrigatórios (§15) | 0 de fila; 1402 testes existentes (não auditados aqui) | 53 cenários (§16.12) | C/E |
| G15 | Restart não prende job (§15.18/19) | Sem jobs | Lease expira; API relê do Mongo | C |
| G16 | Rollback por flag (§18) | `AI_EXTRACTOR_MODE` + fallback | `AI_EXTRACTOR_QUEUE_ENABLED` + drenagem (§16.13) | C |
| G17 | Sem infra nova (§1.8) | Mongo | Manter | A |
| G18 | API sem Chromium no fluxo padrão (§4/§19) | `autoOfferSearch` renderiza na API; worker não tem browser | Etapa E: browser opcional no worker **ou** plataforma fora do pool; gate por capability | E |
| G19 | Gate de contrato correto (§6.4) | Elegibilidade exige `contractVersion='1'`, mas o pool usa v2 | Publicar `offersContractVersion='2'` e gatear por ele; 404/409 → drain + próxima | B |
| G20 | Revalidação central no v2 (§7.3) | Ausente | Validar schema/host/preço/moeda/imagem/permalink no cliente v2 | C |
| G21 | Deadline único e cancelável (§4.5) | 120 s por fonte, sem `signal` | `deadlineAt` absoluto por busca + `signal` propagado + N URLs numa chamada | C |
| G22 | Ledger único de capacidade (§6.2/§9.3) | Reserva (`dns`) × `activeExtractions` × lease | Invariante único por `workerId` (§16.5) | C |

### 16.3 Decisões

**D1 — Híbrido (ADR-006).** Síncrono = push pelo HUB/SWITCH; bulk = pull. O síncrono **não** ganha
polling. Correção da justificativa: o ganho do push é não duplicar a seleção e não adicionar fila ao
caminho interativo — **não** um orçamento de 2,5 s que hoje não existe; o orçamento passa a ser único e
absoluto (§16.8).

**D2 — HTML continua no worker; resultado vira artefato.** O extractor busca (unblocker/proxy/HTTP),
recorta, extrai e revalida. Resultado é `RawOffer[]` validado, persistido em `tb_aiExtractionResults`
para o bulk. Não há endpoint de leitura de arquivo; o HTML é descartado após a extração.

**D3 — O worker não renderiza hoje.** `WORKER_BROWSER_ENABLED=false` por default; plataformas que só
funcionam com browser (ex.: Shopee) **não** entram na capability até a Etapa E decidir: (a) embarcar
Playwright no worker com benchmark próprio, ou (b) manter essas plataformas no legado da API. O plano
não afirma “API sem Chromium” antes disso.

**D4 — Identidade.** `workerId` = UUID gerado no primeiro boot e persistido em arquivo
(`EXTRACTOR_WORKER_ID_FILE`, default `/var/lib/ai-extractor/worker-id`). Env **não** é persistência.
`dns`/`host` são metadados; `bootId` é do processo.

**D5 — Status tem dono.** `desiredStatus` (`auto|online|draining|offline`) é escrito por admin/reaper;
`lastHeartbeatAt`, `activeJobs` e métricas são escritos pelo worker. O worker **nunca** escreve
`desiredStatus` **nem `status`** (campo `status` deixa de existir; o snapshot só atualiza métricas e
`lastHeartbeatAt`); o snapshot não ressuscita drenagem. Reaper (tick 30 s, CAS sobre `lastHeartbeatAt` lido): heartbeat
>60 s ⇒ `observedStatus='offline'` (campo derivado, não destrutivo); heartbeat válido e
`desiredStatus='auto'` ⇒ volta a `online`. `offline`/`draining` **manuais** (admin) não são revertidos
automaticamente e exigem `resume`. Seleção exige `observedStatus='online'`, heartbeat ≤60 s,
`offersContractVersion='2'`, `marketplace ∈ capabilities` e `coreMajor` compatível — o
**mesmo predicado** do claim; CPU de snapshot >300 s vira penalidade (não exclusão silenciosa).

**D6 — Capacidade.** `EXTRACTOR_CAPACITY=1` default, clamp **no boot do worker e na leitura do central**
(`EXTRACTOR_CAPACITY_MAX=2`); valor acima do teto é descartado em ambos os lados.
O boot normaliza documentos existentes para `capacity=1` até existir benchmark. Claim de job **adquire
reserva** no mesmo ledger (§16.5). Para proteger o interativo: bulk só faz claim quando
`fleetHealthy ≥ 3` e admissão de frota **atômica**: `bulkLeases` é uma **coleção de leases**
`{workerId, jobId, expiresAt}` com CAS garantindo `count(leases não expirados) < fleetHealthy − 1`
(deixando ≥1 instância livre para o síncrono). Lease liberado em terminal/cancel/abandono, por TTL de
**60 s** renovado com o heartbeat e por sweeper de 30 s; crash não trava o bulk. Após o claim, re-checar e
fazer rollback se o limite estourar. O gate `activeJobs + reserved == 0` é **métrica** (auto-reportada e
stale), não condição de admissão. `capacity=2` só com
benchmark anexado (N≥30 por plataforma).

**D7 — Orçamento.** Um único `deadlineAt` por busca (`AI_EXTRACTOR_BROWSE_DEADLINE_MS=45000`), calculado
antes do loop de fontes, propagado como `remaining` ao pool (dividido entre as fontes na ordem, com `min(5 s, remaining/nº de fontes restantes)` antes do
corte (teto de 8 fontes por busca)); `AI_EXTRACTOR_POOL_SCRAPE_TIMEOUT_MS` **300 s** (§16.8) é teto do **job**, nunca do síncrono;
`SCRAPE_BROWSE_BUDGET_MS` passa a **45000**
(hoje 35000) para não vencer antes do deadline; `signal` do request aborta fetch/parse. Espera por
capacidade no síncrono: até `min(10 s, deadline − 15 s)` (`AI_EXTRACTOR_POOL_SYNC_WAIT_MS` default
**10000**); esgotada, a resposta é **503 `PROVIDER_UNAVAILABLE` + `Retry-After`** (429 fica interno: o
cliente tenta outra instância, nunca chega ao FRONT). Nunca 200 vazio por falta de capacidade. As N URLs
vão numa chamada (`urls[]`).

**D8 — Retry.** Conexão/502/503/504 e 429 (outra instância, sem breaker); 404/409 = instância
inelegível (marca `observedStatus='draining'`, tenta a próxima, alerta), não falha terminal. Erro
permanente (parâmetro, credencial, plataforma) não repete.

**D9 — Resultado e idempotência.** Resultado em `tb_aiExtractionResults` (TTL 6 h), chave
`{jobId, claim}`. Job terminal retido 7 dias. `idempotencyKey` base =
`marketplace|window|categoriesHash|runId|freshnessEpoch|urlsHash|query|profile|optionsHash`
(**sem `ownerId`**; `runNowRequestId` entra no lugar de `runId` no run-now). Coleta owner-agnostic com
`participants[]`; atribuição e filtros por owner **na leitura**.
(`freshnessEpoch` é numérico em `strict` e vazio em `window`). `query`/`profile`/`options` entram na chave
para dois pedidos com as mesmas URLs e parâmetros diferentes não colidirem. Duplicata (E11000) **lê o job existente** (nunca 500) e faz `$addToSet:{participants: ownerId}`
(idempotente); `participants[]` é calculado para a rodada inteira no insert. **Run-now é sempre fresco:** usa `freshnessPolicy=strict` + `runNowRequestId` na chave — nunca reusa
a `window` do agendado. "Uma coleta por janela" vale só para gatilhos agendados. Se o resultado expirou, novo job com `supersedes` e **a chave recebe o sufixo `:r{n}`**
(determinístico: `n = maior sufixo existente + 1`), senão o índice único bloquearia a re-coleta.

**D10 — Freshness.** Tabela única em §16.7; `fetchedAt` no payload do resultado. O “30 min” do PLAN2 não
é adotado; o comportamento de nova coleta em <10 min é preservado por `freshnessPolicy=strict` (chave
inclui época de 10 min).

**D11 — Sem infra nova.** Mongo resolve fila, lease, resultado, estado e idempotência.

**D12 — Frontend fora deste ciclo.** A API garante contrato, `X-System-Status`, 503 + `Retry-After` e
`fetchedAt`. Consumo no FRONT é dependência registrada (§16.10.4), não etapa deste modelo.

### 16.4 Modelo de dados

`tb_aiExtractorJobs` (novo):

```ts
{
  jobId, requestId, idempotencyKey,          // únicos
  ownerId, participants: string[],            // criador + owners que compartilham
  marketplace, categories: string[], window, runId, runNowRequestId, priority: 'bulk',
  urls: string[], query, profile, options, maxScanned, maxCards,
  offersContractVersion, coreVersion,        // gate de execução (contrato de OFERTAS = '2')
  coreMajor: number,                          // derivado de coreVersion (após '@'), imutável
  freshnessPolicy: 'strict'|'window',
  status: 'pending'|'processing'|'completed'|'failed'|'cancelled',
  claims, attempts, maxAttempts,             // claims no claim (monotônico); attempts na falha
  workerId, leaseToken, slot,                // posse + slot do ledger
  abandonedBy: string[], abandonedReason,    // abandono por participante
  firstStartedAt, startedAt, lockedAt, lastLeaseAt, lockedUntil, nextAttemptAt,
  queueDeadlineAt, deadlineAt,                // fila vs. execução (por tentativa)
  freshnessEpoch, completedAt, cancelRequestedAt, supersedes,
  durationMs, errorCode, errorMessage,
  resultRef: { jobId, claim, expiresAt }|null,    // metadados; nunca HTML
  expiresAt                                  // só terminal (sweeper)
}
```

**Invariante de inserção (obrigatório):** `status='pending'`, `priority='bulk'`, `marketplace`,
`offersContractVersion`, `coreVersion`, `coreMajor` (derivado, imutável), `nextAttemptAt = now`, `queueDeadlineAt = now +
AI_EXTRACTOR_QUEUE_DEADLINE_MS` (600000), `maxAttempts = 3`, `claims = 0`, `attempts = 0`, `deadlineAt = null`,
`cancelRequestedAt = null`, `resultRef = null`, `lockedUntil = null`, `ownerId`, `urls`, `freshnessPolicy`
e `freshnessEpoch` e **`expiresAt` ausente** (só terminal o grava). Sem isso, `$lte`/`$expr` não casam documento ausente e o
job nunca é claimado (ou nunca termina). Validar no schema (`default`/`required`) + teste de documento mínimo.

Índices: `{idempotencyKey:1}` único com `partialFilterExpression: {status:{$in:['pending','processing','completed','failed']}}`; `{participants:1,createdAt:-1}`;
`{status:1,nextAttemptAt:1,createdAt:1}`;
`{status:1,lockedUntil:1}`; `{ownerId:1,createdAt:-1}`. **Sem TTL index** em campo que possa existir
antes do estado terminal: a limpeza é um **sweeper** (`deleteMany` em terminais com `expiresAt<now`),
testado para não apagar job ativo.

`tb_aiExtractionResults` (novo): `{jobId, claim, leaseToken, ownerId, staged, offers[], discarded, bytes,
fetchedAt, createdAt, expiresAt}`; único `{jobId, claim}`; TTL 6 h (só resultado terminal); payload de
ofertas ≤1 MB (documento ≤2 MB); leitura autorizada para qualquer `participants[]` do job **e** com
`result.claim === job.resultRef.claim` (o `resultRef` só existe após o CAS, então não há leitura
prematura). `staged` é **auditoria**, não filtro de leitura. **Fan-out lazy e idempotente:** `tb_autoOfferDeliveries` com único `{jobId, claim, ownerId}` e estado
`pending → debited → delivered`; o débito de quota é idempotente pela delivery key e a retomada usa
checkpoint de categoria (retry/crash não debita 2× nem perde owner). Participante adicionado depois entra
na varredura lazy (`participants` é a fonte), sem fan-out eager. Ao consumir, a API grava o resultado no
`tb_autoOfferSearchCache` de **cada** participante/categoria aplicando `excludeKeys`, `criterion`,
`offersPerCategory` e afiliação daquele owner. **Quota antiabuso é debitada na leitura/consumo por
participante** (não na coleta), e `optionsHash` cobre apenas parâmetros de coleta (nunca filtros por
owner). **Publicação em duas fases** via endpoint central
`POST /internal/ai-extractors/jobs/:id/result` (valida `workerId+leaseToken+claim` do documento da
instância): (1) `insert` do resultado com `staged:true`; (2) CAS do job
`{_id, workerId, leaseToken, claim, status:'processing'}` gravando `completed` + `resultRef`; (3) marcar
`staged:false` (opcional; falha aqui não esconde o resultado, pois a leitura usa `resultRef.claim`).
Se (1) falhar, o job permanece `processing` e o lease expira (retry). Se (2) falhar, o
worker remove **a própria** chave `{jobId, claim}` e registra `lease_lost_continued`. `claim` (contador
monotônico) identifica a execução — `attempt` só incrementa em falha reportada.

`tb_aiExtractorInstances` (alterações): `workerId` (único, `partialFilterExpression: {workerId:{$type:'string'}}`),
`host`, `name`, `desiredStatus` (`auto|online|draining|offline`), `observedStatus`, `lastHeartbeatAt`,
`activeJobs`, `memoryAvailableMb`, `startedAt`, **`offersContractVersion`** e **`capabilities: string[]`**
(plataformas efetivamente executáveis, derivadas de self-test). `dns` deixa de ser único **só na fase 2**
da migração (§16.11 B). Nenhum `process.exit(1)` por índice enquanto o backfill não estiver concluído.

`tb_aiExtractorReservations` (alterado): chave **única** `(workerId, slot)` (`unique:true` no índice
parcial), `jobId`, `claim`, `expiresAt`; renovação junto com o lease; TTL no boot
(`RESERVATION_TTL = max(AI_EXTRACTOR_LEASE_MS, AI_EXTRACTOR_POOL_SCRAPE_TIMEOUT_MS) + folga`). No terminal (conclusão/falha/cancelamento) a reserva é
**liberada no mesmo caminho** (`deleteOne({workerId, slot, jobId, claim})`), não apenas por TTL; compensação
do perdedor usa a mesma chave e não apaga o slot do vencedor.
**Migração (rolling-safe):** a coleção atual é efêmera (TTL ≤180 s) e quem escreve é a **API** (não a
frota). Ordem obrigatória na Etapa C: (1) pausar a admissão por **flag no Mongo** (`pool.admissionPaused=true`, checada antes de reservar — env
não cobre réplicas antigas) e esperar `expiresAt` de todas as reservas; (2) na mesma release, remover a declaração do índice antigo do
schema, executar `dropIndex({dns:1, slot:1})` e criar `{workerId:1, slot:1}` **com
`partialFilterExpression: {workerId:{$type:'string'}}`** (documentos antigos sem `workerId` não entram no
índice); (3) trocar o `process.exit(1)` por um **gate programático**: o central verifica a existência do índice
único `(workerId, slot)` no boot e recusa `AI_EXTRACTOR_QUEUE_ENABLED=true` se ele não existir; (4) só
então habilitar o claim bulk. Nunca criar índice
único sem filtro com `workerId` ausente (colapsaria tudo em um slot global).

### 16.5 Ledger único de capacidade

Invariante por worker, verificado numa única **view lógica** (reservas como fonte da verdade; jobs só
apontam o `slot`):

```
max(reservedSlots(workerId), inflightSlots(workerId)) <= capacity(workerId)
```

`reservedSlots` é a fonte da verdade (cada reserva **é** um slot); `inflightSlots` é a métrica do
extractor e serve só para detectar divergência (nunca soma — somar contaria o mesmo trabalho duas vezes).

- O claim roda no **endpoint central** (`POST /internal/ai-extractors/jobs/claim`, autenticado por
  instância) e **insere** a reserva `(workerId, slot, jobId, claim)` com
  `expiresAt = now + AI_EXTRACTOR_LEASE_MS + folga` (não derivar de `lockedUntil`, que só existe depois);
  renovar o lease **e** a reserva acontece no mesmo passo (`jobId+claim` é o elo; a reserva **é** o slot);
se qualquer um falhar, o worker para (teste 37). O valor de `claim` na
reserva é `claims` atual **+ 1** (o mesmo que o `$inc` do claim produzirá); se o CAS do job falhar, a
reserva é liberada. O worker não escreve
  jobs/resultados direto no Mongo.
- O push síncrono reserva slot pelo **mesmo repositório in-process** do central (não há credencial de
  instância para a API chamar a si mesma), com `jobId=null` + `requestId`; libera por
  `{workerId, slot, requestId}` **somente após o ACK de conclusão** do extractor. **504 não é ACK**: o
  extractor pode continuar trabalhando; a reserva permanece até o TTL (ou até um `x-extraction-running`
  explícito).
- Ordem do claim: **reservar slot primeiro**, de forma atômica: para `slot` de `0..capacity-1`,
  `findOneAndUpdate({workerId, slot, $or:[{expiresAt:{$lt:now}},{expiresAt:null}]},
  {$set:{jobId, claim, expiresAt}}, {upsert:true, returnDocument:'after'})`; `E11000` ⇒ próximo slot. **Nunca** usar `countDocuments` como guarda (TOCTOU). Sem slot livre, o job
  não é tocado (não incrementa `claims` nem altera `nextAttemptAt`). Só depois vem o `findOneAndUpdate`
  do job; se ele devolver `null`, libera o slot.
- `capacity` é clampada (`EXTRACTOR_CAPACITY_MAX`); valor auto-reportado acima do teto é rejeitado.
- Timeout do cliente não libera o slot imediatamente: o extractor devolve 504 mas mantém
  `activeJobs>0`; a reserva expira no TTL se o ACK não vier.
- Sweep de 30 s reconcilia reserva × job; divergência vira alerta.

### 16.6 Claim, lease e posse

Filtro do claim (uma query, `sort: {nextAttemptAt:1, createdAt:1}`):

```js
{
  $and: [
    { nextAttemptAt: { $lte: now } },
    { $expr: { $lt: [{ $ifNull: ['$claims', 0] }, '$maxAttempts'] } },
    { offersContractVersion: requiredOffersContract },
    { coreMajor: requiredCoreMajor },   // campo derivado (major), não comparação literal
    { marketplace: { $in: workerCapabilities } },
    { cancelRequestedAt: null },
    { $or: [
      // pending: respeita o orçamento carimbado; vencido é encerrado pelo sweeper (b)
      { status: 'pending',
        queueDeadlineAt: { $gt: now },
        $or: [{ deadlineAt: null }, { deadlineAt: { $gt: now } }] },
      // reclaim de worker morto: o deadline é recarimbado no claim
      { status: 'processing', lockedUntil: { $lt: now } },
    ] },
  ],
}
```

`deadlineAt` é carimbado **no claim** (`now + jobBudgetMs`), não no enqueue; `queueDeadlineAt` limita a
espera na fila. `$or` explícito para recuperar job de worker morto; `$expr` compara campos do documento (não variável
JS); `claims` limita crash-loop (worker que morre sem reportar falha) e `attempts` limita falha
reportada. O sweeper tem duas rotinas independentes: (a) `status='processing'` **CAS em `{_id, status, workerId, leaseToken, claim, lockedUntil:{$lt:now}}`**
com (`claims >= maxAttempts` **ou** `deadlineAt < now`) ⇒ `failed/LEASE_EXPIRED`/`DEADLINE_EXCEEDED`
(nunca atropela um reclaim recente); (b) job **não-terminal** com (`status='pending'` e (`queueDeadlineAt < now`, `cancelRequestedAt != null`
ou `claims >= maxAttempts`)) **ou** (`status='processing'` com `lockedUntil < now` e `cancelRequestedAt !=
null`) ⇒
`failed/DEADLINE_EXCEEDED` ou `cancelled`, com `expiresAt`; (c) `completed` com `resultRef` cujo documento está ausente **e** `resultRef.expiresAt > now` ⇒
re-coleta `:r{n}` **herdando** `ownerId/participants/categories/marketplace/profile/options` (quota isenta
na re-coleta) + alerta `RESULT_MISSING`; ausência após `expiresAt` é expiração normal (sem alerta nem
re-coleta automática). Nunca deixa job zumbi segurando a `idempotencyKey`; toda transição terminal feita pelo sweeper executa
`deleteOne({workerId, slot, jobId, claim})` no mesmo passo.

Update: `$set {status:'processing', workerId, leaseToken, slot, lockedAt,
lockedUntil: now + LEASE_MS, deadlineAt: now + AI_EXTRACTOR_JOB_BUDGET_MS, lastLeaseAt,
startedAt(first), firstStartedAt(first)}`, `$inc {claims:1}`; na conclusão gravar `completedAt` e
`durationMs`. Quando o claim devolve `null`, libera o
slot e encerra o ciclo (fila vazia ou corrida perdida) — sem laço extra que triplica leitura.
`workerId`, `capabilities`, `offersContractVersion` **e `coreMajor`** vêm do **documento da instância
autenticada** (nunca do corpo da requisição). Derivação de `coreMajor`: parte numérica após o último `@`
de `coreVersion` (ex.: `offer-extract-core@1.2.0` → `1`), `number`.

- Renovação a cada 20 s: `updateOne({_id, workerId, leaseToken, status:'processing'},
  {$set:{lockedUntil, lastLeaseAt}})`. Falha de renovação (Mongo) → para de trabalhar e não conclui.
- Conclusão/falha/cancelamento: **CAS** em `{_id, workerId, leaseToken, status:'processing'}`.
  `matchedCount=0` ⇒ descarta resultado e registra `lease_lost_continued` (se o trabalho continuou).
- Watchdog entre fontes: se `lockedUntil < now` **ou `deadlineAt < now`**, aborta o fetch em andamento; o
  CAS de conclusão exige `deadlineAt > now` (deadline é *hard*).
- Falha transitória (CAS `{_id, workerId, leaseToken, claim, status:'processing'}`): `attempts+1`,
  `status:'pending'`, `workerId/leaseToken/slot/lockedAt/lockedUntil/lastLeaseAt/**deadlineAt**` limpos,
  `nextAttemptAt = now + backoff(jitter)`, reserva liberada; `failed` (com `expiresAt`) quando o valor
  pós-incremento `>= maxAttempts`.
- Cancelamento: **só admin/rollback** grava `cancelRequestedAt` (job compartilhado). Abort do consumidor
  (timeout de um owner) grava `abandonedBy[]` e **não** terminaliza o job; o job só vira `cancelled` quando
  todos os participantes abandonarem ou por ação administrativa. `cancelled` libera a chave: índice único
  parcial **exclui** terminais cancelados e a re-coleta usa `:r{n}` (varredura ancorada `^base(:r[0-9]+)?$`); `jobId`/`requestId` são UUID.
- Clock skew: o job envia `deadlineAt` absoluto **e** `budgetMs` relativo; worker rejeita skew > 60 s.
- **Multi-fonte (N URLs):** o extractor percorre as fontes em série e devolve `sources[]`. Regra de
  `quality`: pelo menos uma fonte **respondeu** ⇒ `ok`/`partial` (bloqueadas entram em `errors[]`,
  mesmo que saudáveis estejam vazias); `blocked` só quando **nenhuma** fonte respondeu (503 `PROVIDER_UNAVAILABLE`,
  `reason=ALL_SOURCES_BLOCKED`, retry habilitado); todas com página saudável e zero cards ⇒ `no_cards` (200 vazio). O agregado preserva os 8 contadores de
  `discarded` e nunca descarta oferta de fonte saudável por causa de outra bloqueada.

### 16.7 Resultado, TTL e freshness

| Item | TTL | Dono | Regra |
| --- | --- | --- | --- |
| HTML em memória/arquivo do worker | descartado após extrair | worker | nunca persiste além do job |
| Resultado (`tb_aiExtractionResults`) | 6 h | worker (escrita condicionada a `leaseToken`); leitura pela API | expirou → novo job `:r{n}` |
| Job terminal | 7 d (sweeper) | API | imutável em `completed` |
| Pool de busca (`SearchGuard`) | 10 min | API | in-memory; multi-processo não compartilha |
| `tb_autoOfferSearchCache` | 30 min (frescor) / 6 h (fallback) | autoOfertas | consumidor do resultado |

`fetchedAt` sempre no payload e `freshnessEpoch` explícito no job (`floor(now/600000)` quando
`strict`; `window` quando não). Resultado expirado **nunca** é servido como atual. O sufixo `:r{n}` é
calculado por varredura ancorada com **escape do `base`** (`^escaped-base(:r[0-9]+)?$`, maior `n` + 1) e
também é aplicado a job terminal `failed` (re-coleta). Gatilho explícito de re-coleta: (a) `POST
/admin/ai-extractor/jobs/:id/retry` (admin), ou (b) produtor em E11000 com job terminal `failed` cria
`:r{n}`. Órfãos de resultado (`staged:true` cujo `jobId` não existe em `tb_aiExtractorJobs`) são removidos por
varredura diária + TTL. `staged` é auditoria; a leitura usa **somente** `resultRef.claim`.

### 16.8 Números (tabela única)

| Parâmetro | Valor | Papel |
| --- | --- | --- |
| `AI_EXTRACTOR_BROWSE_DEADLINE_MS` | 45000 | deadline absoluto da busca (todas as fontes) |
| `AI_EXTRACTOR_POOL_SYNC_WAIT_MS` | 10000 | espera por capacidade no síncrono (`≤ deadline−15s`) |
| `AI_EXTRACTOR_POOL_SCRAPE_TIMEOUT_MS` | 300000 | teto do job no extractor (= `JOB_BUDGET + folga`) |
| `AI_EXTRACTOR_JOB_MAX_CATEGORIES` | 5 | categorias por job de lote |
| `EXTRACTOR_CAPACITY` / `_MAX` | 1 / 2 | concorrência (2 exige benchmark) |
| `EXTRACTOR_HEARTBEAT_MS` | 20000 | liveness/lease (update parcial) |
| `EXTRACTOR_STATE_INTERVAL_MS` | 180000 | snapshot de métricas |
| `AI_EXTRACTOR_SELECTION_MAX_AGE_MS` | 60000 | heartbeat máximo para seleção |
| `AI_EXTRACTOR_LEASE_MS` | 180000 | lease do job (renovado a cada 20 s) |
| `AI_EXTRACTOR_JOB_BUDGET_MS` | 285000 | `maxCategorias(5) × p95(45 s) + folga(60 s)`, carimbado no claim |
| `AI_EXTRACTOR_QUEUE_DEADLINE_MS` | 600000 | idade máxima na fila |
| `AI_EXTRACTOR_CONSUMER_TIMEOUT_MS` (= `searchTimeoutMs`) | 1635000 | `queueDeadline(600)+maxAttempts(3)×jobBudget(285)+backoff(120)+folga(60)`; validado no boot (< engine 1800 s) |
| `AI_EXTRACTOR_RETRY_AFTER_S` | 60 | `Retry-After` do 503 síncrono |
| `AUTO_OFFER_ENGINE_LEASE_MS` / `_RENEW_MS` | 1800000 / 300000 | lease do engine + renovação (CAS) |
| `AI_EXTRACTOR_QUEUE_POLL_MS` | 2000 → backoff 10000 | polling quando vazio |
| `AI_EXTRACTOR_QUEUE_MAX` | 200 | fila cheia → 429 no produtor |
| `AI_EXTRACTOR_MAX_ATTEMPTS` | 3 | dead-letter |
| `AI_EXTRACTOR_RESULT_TTL_MS` | 6 h | resultado |
| `AI_EXTRACTOR_JOB_RETENTION_MS` | 7 d | job terminal |
| p95 busca completa | ≤45 s | SLO de produto (todos os desfechos contam) |
| p95 `/health` sob carga | ≤300 ms | isolamento da API |

### 16.9 Segurança

- **Chave por instância**: `x-extractor-key` (allowlist `AI_EXTRACTOR_POOL_JSON[].keyEnv`) + `x-internal-key`
  para o control plane; comparação em tempo constante. Remover o bypass de chave vazia e **falhar o boot**
  fora de dev/CI se `AI_INTERNAL_KEY` estiver vazia.
- O `/internal/ai-extractor/config` devolve a `apiKey` **decifrada**; passa a exigir chave de instância e
  allowlist, e a resposta é escopada (sem expor de outros workers).
- Estado no modo Mongo é auto-reportado: **MongoDB não restringe escrita por documento**, então a defesa
  é (a) claim/conclusão/resultado via **endpoint central autenticado por instância** (o worker não escreve
  jobs/resultados direto), (b) sanidade no central (`capacity ≤ MAX`, `use ∈ [0,100]`, `workerId` na
  allowlist, heartbeat ≤60 s) e (c) `EXTRACTOR_STATE_MODE=central` como opção com HMAC para quem exigir
  estado assinado. Documentar o raio de exposição do estado auto-reportado.
- `redirect:'manual'` no fetch do worker + revalidação de cada hop contra a allowlist de hosts (hoje é
  `follow` com validação só do host inicial).
- Payload: 1 MB de ofertas, 6 KB de meta; job sem credencial/HTML; logs sem segredos; `SCRAPE_DEBUG_DUMP`
  proibido em produção (fail-closed).
- Revalidação central no v2 (G20): schema estrito, host do permalink, `priceCents` inteiro > 0, moeda BRL,
  imagem http(s); falha → `needsReview` (nunca descarte silencioso).
- Resposta v2 sem `quality`/`sources[]` ou de contrato diferente ⇒ `CONTRACT_MISMATCH` (nunca fonte vazia
  silenciosa); 404/409 ⇒ instância inelegível, próxima tentada.

### 16.9.1 Decisões de produto/operação (resposta à revisão de produto)

**P1 — Demanda × capacidade do bulk.** **Decisão: coleta owner-agnostic em lote.** O enqueue valida `categories.length ≤ JOB_MAX_CATEGORIES`
(422) e grava `maxlength` no schema. A chave de
idempotência **não inclui `ownerId`** e o job cobre **`categories[]`** de um marketplace/janela; vários
usuários compartilham um job (`participants[]`) e a atribuição/filtros são aplicados na leitura por owner.
Com lotes de até **5 categorias** (`JOB_MAX_CATEGORIES`), a demanda cai de 80–480 buscas (8 usuários ×
2 automações × categorias) para **~2–6 jobs/rodada** (sobreposição de categorias entre usuários).
Concorrência real: **frota ≥3**, `bulkLeases = fleetHealthy−1` (2 jobs em voo com 3 workers). Um job leva ~2–5 min
(5 × 20–45 s + folga). **Fórmula de dimensionamento:** `slots_bulk ≥ ceil(jobs_rodada × duração_job /
janela)`; com 6 × 5 min / 60 min = 0,5 ⇒ **1 slot** basta para 6 jobs/hora; a frota 3 dá 2 slots para
absorver bursts. Se `jobs_rodada` crescer ou
`queueAge p95 > 5 min`, subir frota/dedicar instância **antes** de E. `QUEUE_DEADLINE` de 600 s cobre
fila de ~2 jobs de 5 categorias; acima disso o excedente vira `SKIPPED` (métrica `expirados/100 ≤2`).

Decisão operacional: (a) a Etapa E mede `queueAge p95`, `jobs expirados/100` e `ofertas entregues/rodada`
vs. legado; (b) com **frota <3 saudável** o bulk fica pausado, **o produtor não cria job** e a engine
marca `SKIPPED` com motivo (sem `DEADLINE_EXCEEDED` após 600 s); a Etapa E exige ≥3 workers saudáveis (1 reservado ao síncrono);
(c) `failed/DEADLINE_EXCEEDED` e `QUEUE_FULL` (429) mapeiam para `SKIPPED/SEARCH_TIMEOUT` + **uma
notificação agregada por usuário/rodada** (`dedupeKey=userId+runId`, com nº de automações/categorias e
motivo); `SKIPPED` por frota <2 tem copy própria (“coleta temporariamente limitada; tentaremos na próxima
janela”).
**P2 — "Executar agora" continua fresco.** O run-now **não** reusa a `window` do agendado: usa escopo
próprio (`freshnessPolicy=strict` + `runNowRequestId` na `idempotencyKey`). "Uma coleta por janela" vale
só para gatilhos agendados. `window` é definido como `YYYY-MM-DDTHH` em `America/Sao_Paulo` (bucket
horário) e `freshnessEpoch = floor(now/600000)` no modo `strict`. Resultado terminal de 6 h só é servido
se `freshnessPolicy=window` e `window` bater; caso contrário, nova coleta.

**P3 — Escopo de plataformas e Chromium.** Ofertas Automáticas mantêm no **legado** as plataformas
JS-only (Shopee) até a Etapa E decidir: (a) Playwright no worker ⇒ **redimensionar VPS e refazer o
benchmark antes** (a topologia “2 vCPU, capacity=1” deixa de valer), ou (b) aceitar que essas
plataformas seguem na API. Critério de sucesso passa a incluir **CPU da API durante uma rodada bulk
≤ baseline + 10 p.p.** (medido antes/depois), além da paridade de ofertas. O plano não declara “API sem
Chromium” sem essa medição.

**P4 — Copy do 503/429 é da API.** Como o FRONT não muda, a mensagem exibida é a do `message` da API:
503 ⇒ “Alta demanda na coleta de ofertas. Tente novamente em alguns segundos.” + `Retry-After`; 429
interno nunca chega ao FRONT. Não prometer estado de UI que não existe.

**P5 — Timeout do consumidor × fila × lote.** Cadeia derivada do lote (5 categorias):
`jobBudget = 5×45 s + 60 s = 285 s`; `scrapeTimeout = 300 s`; `queueDeadlineAt = 600 s`;
`searchTimeoutMs = 600 + 3×285 + 120 + 60 = 1635 s` (pior caso de reclaims); engine 1800 s cobre.
`AbortSignal` do consumidor grava `abandonedBy[]` (não cancela job compartilhado; ver §16.6). Se `JOB_MAX_CATEGORIES` mudar, os quatro valores
são recalculados pela mesma fórmula (validado no boot).

**P6 — Lease do engine (30 min).** Decisão: `AUTO_OFFER_ENGINE_LEASE_MS=1800000` com renovação a cada
`AUTO_OFFER_ENGINE_LEASE_RENEW_MS=300000` por CAS em `runningSince`; takeover só após expiração do lease
(sem renovação); falha de renovação ⇒ aborta o ciclo (fail-closed, `PARTIAL` com motivo + alerta). O limite
real da rodada é `searchTimeoutMs=1635 s` (§16.8) por automação, então a renovação cobre o ciclo mesmo com fila
saturada. Teste 44 cobre saturação **e** falha de renovação. Teste “fila saturada não gera segunda execução da
mesma automação” em §16.12.

**P7 — Orçamento por fonte no síncrono.** O deadline é dividido entre as fontes na ordem, com mínimo de
5 s; fontes lentas são medidas (`sourceMs`) e ordenadas por desempenho; `sourcesCut` vira métrica com
alerta (>10% das buscas). `quality=partial` não é exibido ao usuário (FRONT inalterado), então a perda é
tratada como métrica, não como copy.

**P8 — Operação.** `drain/resume` e `GET /instances` passam para a **Etapa B**; runbook “adicionar/remover
worker” (drain → restart → smoke por plataforma) entra em B; alertas com **canal** (NotificationService)
e responsável, antes de E; rollback de E restaura o produtor ao caminho síncrono/legado quando
`QUEUE_ENABLED=false`; checklist de VPS (OS, Node, deps, firewall, TZ, logrotate, disco, auto-restart) e
`reboot → worker claimado em ≤2 min` como aceite.

### 16.10 Observabilidade e administração

1. **Logs por job:** `jobId`, `workerId`, `attempt`, `marketplace`, `queueAgeMs`, `fetchMs`, `extractMs`,
   `totalMs`, `cards`, `rejected`, `errorCode`, `leaseLost`.
2. **Admin:** `GET /admin/ai-extractor/instances` (Etapa B), `POST .../instances/:workerId/{drain,resume}` (Etapa B),
   `GET .../jobs?status=`, `POST .../jobs/:id/cancel`, `GET .../jobs/:id`. Autorização admin (não
   `x-internal-key`); `cancel` usa CAS e, para `processing` com lease válido, **só grava
   `cancelRequestedAt`** (não terminaliza nem libera slot; o worker aborta entre fontes e o terminal vem
   pelo CAS dele).
3. **Alertas** com severidade/destino: worker sem heartbeat >60 s (P1, e-mail/WhatsApp do admin via
   `NotificationService` + `dedupeKey`, **não** “página admin”); fila `pending` >80%
   por 5 min (P2); `attempts=maxAttempts` ≥1 job (P2); `lease_expired`/`lease_lost_continued` (P2);
   503 síncrono >1% em 10 min (P1). Amostra mínima de 20 eventos para evitar alarme com 8 usuários.
4. **Dependência de FRONT (fora deste ciclo):** consumir `X-System-Status`, `Retry-After` e `fetchedAt`;
   estados “aguardando / indisponível / vazio real / parcial”; tela de jobs do autoOfertas. Registrado
   para o time do FRONT — **não** é etapa deste plano.

### 16.11 Etapas

| Etapa | Objetivo | Entrega | Aceite |
| --- | --- | --- | --- |
| A (feito) | Diagnóstico + ADR | esta seção + ADR-006 | 2 revisores sem P0 aberto |
| B | Identidade, status, contrato e infra | `workerId` em arquivo (**fail-closed** se não puder ler/gravar; reconcilia `dns` antigo), `desiredStatus='auto'` default + `observedStatus` + reaper com auto-resume, `GET /instances` +
`drain/resume` (endpoints e runbook), **flag `pool.admissionPaused`** (release anterior a C), `offersContractVersion`/`capabilities` no schema, normalização de `capacity` das linhas existentes, chave por instância, fail-closed, systemd/TLS/DNS, runbook de VPS | deploy **extractor → central** (o campo `offersContractVersion` é tolerado ausente por 7 dias no central, senão a frota inteira fica inelegível); 1 linha legada + 1 worker novo; drain/offline manual não é ressuscitado; nenhum boot falha por índice |
| C | Fila pull + resultado + deadline | coleções de job/resultado, claim/lease/CAS, sweeper, migração de reservas documentada (drenar → TTL → drop → índice `(workerId,slot)`), `deadlineAt`+`signal`, N URLs por chamada, revalidação v2, logs de job | todos os 53 cenários de §16.12 verdes; nenhum job 2×; job de worker morto recuperado; nenhum slot vazando |
| D | Ledger único + benchmark | clamp, benchmark N≥30/plataforma, `capacity` documentada (o **índice** `(workerId,slot)` é entregue em C) | invariante testada; benchmark anexado antes de qualquer capacity=2 |
| E | Ofertas Automáticas no pull | `autoOfferSearch` cria job (sem render na API) + browser opcional no worker **ou** plataformas JS-only fora do pool | paridade por plataforma (contagem/preço/permalink/needsReview) em amostra ≥100 ofertas antes de 100% |
| F | Observabilidade e operação | alertas, runbooks (fila/drain/rotação/incidente), custo mensal e teto, drill de rollback | alerta dispara em teste; rollback executado em homologação |
| G | Carga e rollout | 5%→25%→100%, rollback por flag | **Gate de entrada de E:** frota e teto de custo aprovados; **execução de G após E** | interativo: 8 usuários, pico 3 concorrentes, slots ≥ pico; p95 **de todos os desfechos** ≤45 s e 503 ≤1%. Bulk: `queueAge p95 ≤5 min`, `expirados/100 ≤2`, `ofertas entregues/rodada ≥ legado`, tempo até 1ª mensagem ≤ janela e **tempo total da rodada** ≤ janela. Rollout em **% de automações** (5→25→100) |

### 16.12 Testes (PLAN2 §15 + extensões)

| # | Cenário | Onde |
| --- | --- | --- |
| 1 | Worker adquire job | integração |
| 2 | Dois workers, só um vence | concorrência (Promise.all) |
| 3 | Conclusão com sucesso | integração |
| 4 | Falha permite retry com backoff | integração |
| 5 | Worker cai, lease expira | integração (relógio fake) |
| 6 | Worker antigo não sobrescreve | CAS com `leaseToken` velho |
| 7 | Máximo de tentativas → failed | integração |
| 8 | Todos ocupados (sync e fila) | síncrono → 503 + `Retry-After`; 429 só interno (API↔extrator); fila cresce sem overcommit |
| 9 | Worker offline pelo reaper | heartbeat expirado → `observedStatus=offline` |
| 10 | API lê resultado do job correto | `resultRef` + owner |
| 11 | Resultado expirado | nova coleta `:r{n}`, nunca resultado velho |
| 12 | Sweeper não apaga job ativo | `processing` com `expiresAt` no passado continua |
| 13 | Resultado ausente/corrompido | nova coleta, sem 500 |
| 14 | Contrato do FRONT inalterado | `MarketplaceProductSearchResult[]` |
| 15 | Duas solicitações equivalentes | E11000 → lê job existente |
| 16 | Freshness | `strict` não reutiliza janela anterior |
| 17 | Scraping não afeta API | health/auth com fila cheia |
| 18 | Restart da API não perde job | jobs no Mongo |
| 19 | Restart do worker não prende job | lease expira e outro assume |
| 20 | Segredos fora de logs | varredura nos testes de erro |
| 21 | 3+ workers disputando 10 jobs | nenhuma dupla execução |
| 22 | Falha de renovação (Mongo blip) | worker não conclui; job recuperado |
| 23 | Perda de lease durante scrape | aborta entre fontes; `lease_lost_continued` |
| 24 | Cancelamento concorrente com conclusão | CAS decide; sem estado inconsistente |
| 25 | Job fora de `participants[]` | 404/403 (participante lê; estranho não) |
| 26 | Payload/URLs acima do limite | 413/422 |
| 27 | Fila cheia | produtor recebe 429 com `Retry-After` |
| 28 | Manual × agendado na mesma janela | agendado deduplica por `window`; run-now usa `strict + runNowRequestId` e **nunca** recebe resultado da janela |
| 29 | Contrato incompatível | instância drenada, próxima tentada |
| 30 | Paridade autoOfertas legado × pull | amostra ≥100 ofertas |
| 31 | Claim sem slot | `claims` **não** incrementa; job segue elegível |
| 32 | Crash entre reserva e claim | reserva órfã expira; slot volta ao ledger |
| 33 | Migração rolling de reservas | índice parcial + `dropIndex`; nenhum slot global |
| 34 | `:r{n}` concorrente | varredura ancorada + E11000 lê existente |
| 35 | Reaper × heartbeat vivo | CAS em `lastHeartbeatAt` não derruba worker saudável |
| 36 | Compensação com lease velho | resultado do vencedor permanece; perdedor não apaga |
| 37 | Renovação de reserva falha, lease ok | worker para de trabalhar (sem overcommit) |
| 38 | `quality`/`sources[]` ausentes no v2 | `CONTRACT_MISMATCH` (não fonte vazia) |
| 39 | Duas reservas concorrentes no mesmo worker | `unique (workerId, slot)` impede overcommit |
| 40 | Deadline de fila vencido | job vira `failed/DEADLINE_EXCEEDED` e libera a chave |
| 41 | `completed` com resultado ausente | detector + re-coleta `:r{n}` |
| 42 | Conclusão de job | slot liberado no mesmo caminho (não só por TTL); `slot`/`deadlineAt` gravados no claim |
| 43 | Sweeper (b) com lease válido | **não** cancela nem libera slot de `processing` vivo |
| 44 | Fila saturada no ciclo do engine | lease renovado a cada 5 min; sem 2ª execução da mesma automação |
| 45 | Dois owners na mesma categoria/janela | **um** job (`participants[]`); atribuição e filtros individuais no fan-out |
| 46 | Fan-out com quota esgotada | participante sem quota não recebe ofertas (sem debitar os demais) |
| 47 | Fan-out com `excludeKeys`/afiliação distintos | cada owner recebe apenas o que lhe cabe |
| 48 | Frota <3 saudável | produtor não cria job; execução `SKIPPED` com motivo + notificação |
| 49 | Boot com cadeia de tempos inválida | recusa subir (`searchTimeout ≥ queueDeadline+maxAttempts×jobBudget+folga`, `scrapeTimeout ≥ jobBudget`) |
| 50 | Abandono de 1 participante | job continua; os demais recebem; `abandonedBy[]` registra |
| 51 | Admissão de frota concorrente | `workersComBulk ≤ fleetHealthy−1` sempre; síncrono acha slot |
| 52 | Reclaim além do consumidor | `searchTimeout` cobre 3 tentativas; nenhum abort com job saudável |
| 53 | Fan-out parcial/crash | retry não debita quota 2× e não perde owner |

### 16.13 Rollback

1. `AI_EXTRACTOR_QUEUE_ENABLED=false`: produtor para de inserir; jobs `pending/processing` são
   **cancelados em massa** com motivo (`queue_disabled`), liberando `idempotencyKey`.
2. `AI_EXTRACTOR_MODE=legacy`: semáforo legado = 1 (não repete o cenário de 2 scrapings/70–80% de CPU).
3. Rollback da identidade: `workerId` permanece (não destrutivo); `dns` volta a ser único apenas se
   `countDocuments({dns})` não tiver duplicata; script idempotente e testado com 1 linha legada.
4. Runbooks: `docs/RUNBOOK_FILA_E_DRAIN.md`, `docs/RUNBOOK_ROTACAO_SEGREDOS.md`,
   `docs/BENCHMARK_WORKERS.md`, `docs/RUNBOOK_WORKER_ADD_REMOVE.md` (novos, Etapa B/F). Remover worker:
   `drain` → esperar in-flight → `purge` de `tb_aiExtractorInstances`/reservas órfãs → remover da allowlist.

### 16.14 Riscos

| Risco | Mitigação |
| --- | --- |
| Duas admissões (reserva × lease) | ledger único por `workerId` (§16.5) |
| Overcommit com `capacity` auto-reportada | clamp + credencial restrita + invariante |
| Resultado expirado × idempotência | TTL 6 h + `:r{n}` + E11000 lê existente |
| Job apagado por TTL | sweeper só em terminal |
| Worker sem browser | capability por self-test; Shopee fora do pool até Etapa E |
| Migração quebrar boot | backfill + índice parcial + `dropIndex` explícito |
| Fila zumbi no rollback | cancelamento em massa |
| Bulk faminto / sync na fila | bulk só com fleet ≥2 e 0 ativos |
| Estado auto-reportado | claim/resultado via endpoint autenticado por instância + sanidade + allowlist; modo `central` com HMAC como opção |

### 16.15 Critérios de aceite adicionais

23. Claim/renovação/conclusão validam `workerId` + `leaseToken`; job nunca 2×.
24. Resultado em `tb_aiExtractionResults` (nunca HTML); TTL e `:r{n}` testados.
25. `workerId` estável entre reinícios (arquivo), `dns` é metadado.
26. Reaper marca `offline` em 60 s; drain não é ressuscitado; seleção ignora >60 s.
27. `capacity=1` default, clamp 2, benchmark N≥30/plataforma anexado antes de subir.
28. Bulk não faz claim com fleet <2 ou worker ocupado; sync nunca espera fila.
29. Contrato publicado `offersContractVersion=2`; 404/409 drenam e tentam a próxima.
30. Deadline único de 45 s com `signal`; N URLs numa chamada; 200 vazio só para qualidade real.
31. Revalidação central v2 ativa (host/preço/moeda/imagem/permalink).
32. Rollback por flag com cancelamento em massa e semáforo legado = 1.
33. `offersContractVersion`/`capabilities` publicados e usados na elegibilidade e no claim.
34. Resultado gravado por `{jobId, claim}` com CAS de `leaseToken`; perdedor não sobrescreve.
35. Migração de reservas: drenar → expirar TTL → drop → índice `(workerId, slot)`; sem overcommit na janela.
36. Claim usa `$or` (pending|lease expirado) + `$expr` (`claims < maxAttempts`) + `nextAttemptAt ≤ now`;
   crash-loop termina em `failed`.
37. `workerId` em arquivo com fail-closed e reconciliação de `dns` duplicado.
38. Nenhum critério deste plano exige alteração no FRONT; contrato público preservado.
39. Claim exige `offersContractVersion='2'` e `capabilities`; worker v1 nunca é elegível.
40. `cancelRequestedAt` não é claimável; claim exige `deadlineAt` nulo ou futuro; sweeper exige
`lockedUntil < now` para `processing` e `queueDeadlineAt < now` para `pending`.
41. Reserva é renovada junto do lease; falha de renovação interrompe o trabalho.
42. Resultado só é publicado via endpoint central após CAS do job; compensação restrita à própria chave.

### 16.17 Estado da implementação (2026-11-04)

**Etapa A (feito):** diagnóstico, gap analysis, ADR-006 e revisões.

**Etapa B (feito e validado ao vivo):** `workerId` persistido em arquivo (fail-closed), heartbeat de
liveness de 20 s + snapshot de 180 s, `offersContractVersion=2`/`coreMajor`/`capabilities`,
`desiredStatus` × `observedStatus` com reaper CAS, drain/resume admin, gate por capability (Shopee fora
até haver browser), `capacity` default 1 (clamp 2), coleção canônica `tb_aiextractorinstances`.
Validado: `eligible` por plataforma, drain/resume e busca AliExpress (60 ofertas, BRL) via pool.

**Etapa C (feito, em validação):** `tb_aiExtractorJobs` + `tb_aiExtractionResults`, claim atômico
(reserva de slot → job), lease + CAS em toda transição, `claims`/`attempts`/backoff, sweeper
(lease vencido, fila vencida, cancelamento, resultado ausente, retenção), cancel/retry admin, worker
poller no extractor (`EXTRACTOR_JOBS_ENABLED`). Testes: 17 cenários de fila na API + 158 no extractor.
Validação real: job enfileirado → claim → extração (60 ofertas) → `completed` com `resultRef` e slot
liberado. Pendente na C: `attempt`/`claim` no CAS de conclusão com deadline estrito, fan-out por
participante (`tb_autoOfferDeliveries`), endpoint de leitura para o owner e migração rolling do índice de
reservas.

**Etapas D–G:** pendentes (benchmark, autoOfertas no pull, observabilidade/runbooks, carga/rollout).

### 16.16 Registro de revisão

| Data | Revisor | Modelo | Veredito | Bloqueios |
| --- | --- | --- | --- | --- |
| 2026-11-04 | `general` (free) | não exposto | REPROVADO (v4.0.0) | deadline 2,5 s inexistente; dois ledgers; `resultRef` sem store; migração `dns`; claim incompleto; status sobrescrito; chave por instância inexistente; worker sem browser |
| 2026-11-04 | `revisor-backend` (OpenCode Go) | Muse Spark 1.3 | REPROVADO (v4.0.0) | P0.1–P0.9: deadline N×120 s; ledger triplo; resultado/TTL/idempotência; claim/CAS; gate de contrato v1×v2; migração/boot; fronteira sem revalidação e chave global; capability mentirosa |
| 2026-11-04 | `revisor-produto` (OpenCode Go) | Claude Haiku 5.5 | REPROVADO (v4.0.0) | Etapa E sem renderizador/paridade; orçamento 2,5 s × p95 45 s; UX de falha fora de etapa; rollback sem drenagem; autoOfertas sem UX; provisionamento/runbook ausentes |
| 2026-11-04 | `general` (free) | não exposto | REPROVADO (v4.1.0) | N1 duas camadas normativas (v3×v4); N2 migração do índice de reservas; N3 `offersContractVersion`/`capabilities` sem campo; N4 resultado gravável por worker sem lease; N5 aceites ainda exigiam FRONT |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | REPROVADO (v4.2.0) | claim consumia `claims` sem slot; `{jobId, attempt}` não isola execução (perdedor apagava resultado); migração de reservas não era rolling-safe; N1/N3 parciais |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | REPROVADO (v4.3.0) | P0-A deadline sem transição terminal; P0-B slot não atômico/sem `unique`; P0-C CAS antes de persistir (job `completed` sem resultado); N1/N3 parciais; slot não liberado no terminal |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | REPROVADO (v4.4.0) | P0-1 fase 3 pós-CAS (resultado invisível); P0-2 defaults de inserção ausentes; P0-3 deadline/retry contraditórios; drift ADR/§3.3/§7.2; coreVersion fora do claim |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | REPROVADO (v4.5.0) | claim não recuperava worker morto (deadline); aceite 34 com `attempt`; invariante de inserção incompleto; sweeper (c) re-coletava após TTL; §6.3/§7.1–§7.5 ainda normativos |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | REPROVADO (v4.6.0) | `coreMajor` exigido no claim sem campo no schema/invariante; P1 de queueDeadline, cancel/slot, staged, teste 8/28, valor do `claim` na reserva, seed `status` |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | **APROVADO COM RESSALVAS** (v4.7.0) | sem P0; obrigatório antes de C: `$set` do claim com `slot`/`deadlineAt`, tipo/derivação de `coreMajor`, cancel admin só com `cancelRequestedAt`, testes 43 |
| 2026-11-04 | `revisor-produto` | Claude Haiku 5.5 | REPROVADO (v4.7.1) | P0-1 demanda×capacidade (1 job bulk, fila 200 decorativa, sem desfecho do job no autoOfertas); P0-2 run-now deixava de ser fresco; P0-3 Sem Chromium sem escopo/medição; P0-4 ciclo do engine pode exceder lease de 30 min; P1 copy 503, timeout consumidor×fila, alertas sem canal, drain em F |
| 2026-11-04 | `revisor-produto` | Claude Haiku 5.5 | REPROVADO (v4.8.0) | capacidade do bulk (1 slot vs 80–480), run-now ainda contraditório em D9/teste 28, lease do engine sem mecanismo, gate G não media o bulk; P1 (Retry-After, agregar notificação, drain em B, purga no runbook, alertas sem canal) |
| 2026-11-04 | `revisor-produto` | Claude Haiku 5.5 | REPROVADO (v4.9.0) | owner-agnostic sem `participants[]`/fan-out (testes 25×45); D6 (1 job) × throughput declarado; quota/afiliação/antirrepetição por owner ignoradas; P1 doc drift, lease sem números, frota <2, cache 30 min |
| 2026-11-04 | `revisor-produto` | Claude Haiku 5.5 | REPROVADO (v5.0.0) | P0-1 `JOB_BUDGET` 120 s < lote (3–7,5 min); P0-2 frota 2 × 10–30 jobs > janela; P0-3 `searchTimeoutMs` 540 s < fila+execução; P1 teste 25 por `ownerId`, frota <2 sem gate no produtor, drift CONFIG/ADR |
| 2026-11-04 | `revisor-produto` | Claude Haiku 5.5 | REPROVADO (v5.0.1) | consolidação de números: `SCRAPE_TIMEOUT` 120×300 s; `searchTimeoutMs` 825×540×600 s; modelo de demanda duplicado (2–6 × 10–30 jobs) |
| 2026-11-04 | `revisor-produto` | Claude Haiku 5.5 | **APROVADO COM RESSALVAS** (v5.0.2) | sem P0; antes de C: contagem 49, cláusula de burst (~2 jobs), alias `searchTimeoutMs`=`CONSUMER_TIMEOUT`, CONFIG v5.0.3 |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | REPROVADO (v5.0.3) | P0-1 cancelamento de job compartilhado (um owner cancela todos; `cancelled` retém a chave); P0-2 admissão de frota não atômica (2 bulk com frota 2); P1 reclaim > consumidor, deadline no CAS, fan-out idempotente, `participants` no E11000, `JOB_MAX_CATEGORIES` |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | **APROVADO COM RESSALVAS** (v5.1.0) | sem P0; antes de C: ciclo de vida do `bulkLeases`, drift 480/600 s, CAS do sweeper, ordem do fan-out, `maxlength` de array (usar `validate`), `abandonedBy/lockedAt` no schema, mínimo de 5 s por fonte |
| 2026-11-04 | `revisor-backend` | Muse Spark 1.3 | — | v5.2.0 aplica os P1 acima; sem nova rodada |
| 2026-11-04 | `revisor-produto` | Claude Haiku 5.5 | **APROVADO COM RESSALVAS** (v5.0.2) | sem P0; correções numéricas aplicadas até v5.0.3/v5.2.0 |

**Correções v5.1.0 (backend, job compartilhado):** cancelamento só por admin/rollback (abort de owner
grava `abandonedBy[]`); `cancelled` excluído do índice único e re-coleta `:r{n}`/`:c{n}`; admissão de frota
atômica (`bulkLeases` CAS, `< fleetHealthy−1`, rollback pós-claim) e E com ≥3 workers; watchdog aborta em
`deadlineAt` e CAS exige deadline vivo; renovação de reserva no mesmo passo; fan-out idempotente
(`tb_autoOfferDeliveries`); `$addToSet participants` no E11000; `JOB_MAX_CATEGORIES` validado; índice
`{participants,createdAt}`; tempos `queueDeadline=600 s`/`consumer=1635 s`; testes 50–53 e contagem 53.

**Correções v5.2.0 (P1 de fechamento):** `bulkLeases` como coleção de leases com TTL/renovação/sweeper
(crash não trava o bulk); `QUEUE_DEADLINE=600 s` único; CAS do sweeper com posse (`workerId/leaseToken/
claim/lockedUntil`); fan-out lazy/estado por participant; índice parcial `$in` (não `$ne`); `:r{n}` único;
re-coleta herda dono/participants e isenta quota; `abandonedBy/lockedAt` no schema; mínimo por fonte
`min(5 s, remaining/fontes)` e teto de 8 fontes.

**Correções v5.0.3 (fechamento):** contagem 49 em G14/C; cláusula de burst corrigida (~2 jobs no
deadline); alias `searchTimeoutMs` ≡ `AI_EXTRACTOR_CONSUMER_TIMEOUT_MS`; CONFIG com a cadeia completa e
v5.0.3.

**Correções v5.0.2 (consolidação):** valor único em §16.8 (`SCRAPE_TIMEOUT=300 s`,
`CONSUMER_TIMEOUT=825 s`) referenciado por D7/P5/P6/CONFIG; removido o parágrafo duplicado de demanda
(fica 2–6 jobs + fórmula de slots); `SKIPPED` por frota <2 com copy própria; teste 49 (boot valida cadeia);
gate de entrada de E (frota/custo) separado de G.

**Correções v5.0.1 (produto, 4ª rodada):** cadeia de tempos derivada do lote (`JOB_MAX_CATEGORIES=5`,
`JOB_BUDGET=285 s`, `SCRAPE_TIMEOUT=300 s`, `searchTimeoutMs=825 s`, lease 1800 s); fórmula de
dimensionamento `slots_bulk ≥ ceil(jobs×duração/janela)`; correção 480 s e “20–40 buscas”; frota <2 ⇒
produtor não cria job (`SKIPPED`); teste 25 por `participants[]`; testes 46–48 (quota/afiliação/
antirrepetição/frota); contagem 48; ADR/CONFIG sincronizados.

**Correções v5.0.0 (produto, 3ª rodada):** job em **lote** (`categories[]`) com `participants[]`, leitura
autorizada por participante e fan-out para o cache de cada owner (quota debitada no consumo, filtros por
owner); dedupe sem `ownerId` e `runNowRequestId` no schema; throughput reconciliado (1 job bulk/worker,
2–6 jobs/rodada); frota <2 pausa o bulk + alerta e E exige ≥2 saudáveis; cache 30 min/6 h; `Retry-After`
60 s; números do lease do engine e takeover; notificação por usuário/rodada com texto de `QUEUE_FULL`;
rollout em % de automações e tempo total da rodada no gate.

**Correções v4.9.0 (produto, 2ª rodada):** coleta **owner-agnostic** (dedupe entre usuários; atribuição na
leitura) reduzindo a demanda para ~10–30 jobs/rodada; run-now sempre `strict + runNowRequestId` (D9 e
teste 28 corrigidos); engine renova o lease a cada 5 min por CAS (fail-closed); `QUEUE_DEADLINE` 480 s +
`Retry-After=30 s`; notificação agregada por rodada e `QUEUE_FULL` mapeado; alertas com canal; `drain/
resume` na Etapa B; purga no runbook; gate G mede bulk (queueAge, expirados, ofertas/rodada) e frota/custo
antes de E; `searchTimeoutMs` do agendado; testes 44–45.

**Correções v4.8.0 (produto):** §16.9.1 com demanda×capacidade (80–480 buscas/rodada, instância
dedicada/frota ≥3 se `queueAge p95 > 5 min`), desfecho de job expirado no autoOfertas via
`NotificationService`; run-now com escopo de idempotência próprio (`strict` + `runNowRequestId`) e
`window`/`freshnessEpoch` definidos; escopo de plataformas JS-only e métrica de CPU da API para a Etapa E;
copy do 503/429 na API; `queueDeadlineAt` 480 s + `AbortSignal` → `cancelRequestedAt`; renovação do lease
do engine (30 min) e teste de fila saturada; orçamento/ordenação de fontes + `sourcesCut`; drain/resume e
runbook de worker na Etapa B; alertas com canal antes de E; rollback do produtor para o caminho legado;
perfil de carga do gate G e checklist de VPS; espera do síncrono até 10 s.

**Correções v4.7.1 (fechamento backend):** `$set` do claim grava `slot` e `deadlineAt`; `coreMajor:
number` com derivação explícita e leitura do documento autenticado; cancel admin só grava
`cancelRequestedAt` com lease válido; invariante de inserção com `ownerId/urls/freshnessPolicy/
freshnessEpoch/lockedUntil`; regra manual×agendado em D9; marcadores em §6.3/§7.3–§7.5; teste 43.

**Correções v4.7.0 (7ª rodada):** `coreMajor` no schema e no invariante; claim exige
`queueDeadlineAt > now`; sweeper (b) só age em `pending` ou `processing` com lease expirado; `staged` sem
dupla semântica (leitura por `resultRef.claim`); teste 8 (503 no síncrono) e teste 28 (manual reusa
`runId`); valor do `claim` na reserva; marcadores em §6.3/§7.1/§7.2; seed `desiredStatus='auto'`;
flag `admissionPaused` na Etapa B.

**Correções v4.6.0 (6ª rodada):** deadline dentro do ramo `pending` (reclaim de worker morto não é
bloqueado) e sweeper (a) encerra `processing` com `deadlineAt` vencido; aceite/D9 com `{jobId, claim}`;
invariante de inserção completo (`status`, `priority`, `marketplace`, contrato, sem `expiresAt`);
sweeper (c) só antes do TTL do resultado; §6.3/§7.1–§7.5 explicitamente substituídos; 504 não é ACK;
sweeper libera slot; `coreMajor`; TTL de reserva único; `options/maxScanned/maxCards` no schema; bulk
reserva uma instância para o síncrono; budget por fonte; sweeper de `pending` com `claims` esgotado;
gatilho de retry/limpeza de órfãos; ordem de deploy extrator→central; pausa por flag no Mongo; teste 28
com regra; posse do índice em C.

**Correções v4.5.0 (5ª rodada):** leitura do resultado por `resultRef.claim` (fase 3 vira auditoria) e
sweeper (c) para `completed` sem resultado; invariante de inserção do job; `deadlineAt` limpo no retry e
aceite 40 separado (`pending` × `processing`); números `JOB_BUDGET_MS`/`QUEUE_DEADLINE_MS`; reserva com
`expiresAt` absoluto, filtro literal e liberação por `claim`; reserva síncrona in-process; gate
programático do índice; `coreVersion` no claim; `query/profile/optionsHash` na idempotência; regex de
`:r{n}` com escape e também para `failed`; contagem 42; ADR/CFG/§2.2/§3.3/§7.2/§14.3 sincronizados.

**Correções v4.4.0 (4ª rodada):** slot atômico por `unique (workerId, slot)` + `findOneAndUpdate`
(remove `countDocuments`); reserva liberada no terminal; invariante com `max(reserved, inflight)`;
`deadlineAt` carimbado no claim + `queueDeadlineAt` + sweeper terminal (`DEADLINE_EXCEEDED`/`cancelled`);
publicação de resultado em duas fases (`staged` → CAS com `claim` → visível) com compensação e leitura só
`staged:false`; `freshnessEpoch` na chave e no schema; `blocked` = 503 `PROVIDER_UNAVAILABLE` com retry;
transição de falha com `status='pending'`, limpeza de posse e liberação de slot; `workerId`/`capabilities`
lidos do documento autenticado; seleção com gate completo (contrato v2, capability, core major);
marcadores em §12/§14; testes 39–42.

**Correções v4.3.0 (3ª rodada):** reserva **antes** do claim (recusa por capacidade não queima `claims`);
resultado com chave `{jobId, claim}` (não `attempt`), publicação somente via endpoint central após CAS e
compensação restrita à própria chave; migração de reservas rolling-safe (pausa + `partialFilterExpression`
+ `dropIndex` + sem `process.exit` no pool); job/claim gateados por `offersContractVersion='2'`;
`cancelRequestedAt`/`deadlineAt`/`$ifNull` no filtro; sweeper só com `lockedUntil < now`; reaper com CAS em
`lastHeartbeatAt` e worker sem escrever `status`; clamp de `capacity` no worker **e** no central;
`quality`/`sources[]` obrigatórios no v2 (`CONTRACT_MISMATCH`); multi-fonte `blocked` só se nenhuma
respondeu; `freshnessEpoch` explícito; testes 31–38 e aceites 39–42; marcadores inline em §0.2, §3.2–3.3,
§4.1, §11 e §13.1/§13.5.

**Correções v4.2.0 (2ª rodada):** consolidação normativa (§16 prevalece; §0.5, §5, §7.7, §13.6, §14.14/20 e
MVP marcados como substituídos/fora de escopo); claim com `$or` (pending|lease expirado) + `$expr`
(`claims < maxAttempts`) + `nextAttemptAt`; `claims` como gate de crash-loop; ledger sem contagem dupla
(slot único por `jobId`); resultado com chave `{jobId, attempt}` e CAS de `leaseToken` + compensação;
migração de reservas (drenar → TTL → drop → índice `(workerId,slot)`); `offersContractVersion` e
`capabilities` no schema e no claim; `workerId` fail-closed; reaper com `observedStatus` e auto-resume;
`capacity=1` normalizado nas linhas existentes; `:r{n}` **na chave** de idempotência; N URLs com regra de
`quality` multi-fonte; 429 interno e 503+`Retry-After` no síncrono; aceites 33–38; nenhum aceite de FRONT.

**Correções v4.1.0 (resposta às revisões):** deadline único + `signal` + N URLs por chamada; ledger
único por `workerId` com reserva no claim; `tb_aiExtractionResults` com TTL/idempotência/`:r{n}`;
claim com filtro completo, `claims`×`attempts`, CAS em todas as transições e watchdog de lease;
`desiredStatus` × heartbeat + reaper; `workerId` em arquivo e migração em 2 fases; contrato v2 publicado
e gateado; revalidação central no v2; chave por instância + fail-closed + `redirect:'manual'` + RBAC
Mongo; capability por self-test; browser no worker só na Etapa E; FRONT declarado fora do escopo com
dependências registradas; etapa de provisionamento/runbooks; rollback com cancelamento em massa;
testes ampliados para 30.
