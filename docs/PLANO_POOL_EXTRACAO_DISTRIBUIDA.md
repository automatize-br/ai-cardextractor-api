# Plano — Pool de Extratores de Ofertas com Balanceamento por CPU

**Versão:** 2.9.0 (revisada após rodada 10)
**Data:** 2026-10-27
**Branch:** `feat/extractor-pool-scheduler`
**Status:** **APROVADO** (revisão final dos dois revisores)
**Projetos:** `ai-extractor-api` (este), `../API`, `../FRONT`

---

## 0. Resumo executivo

A API central distribui a extração/validação de cards para um **pool de instâncias dedicadas do `ai-extractor-api`**, cada uma em uma VPS de 2 vCPU. A escolha usa CPU (sinal grosseiro), in-flight real, capacidade, saúde, versão/contrato e plataformas suportadas.

**Validação pós-merge `dev` (API/FRONT, 2026-10-27):** o plano foi reconferido contra o código de `dev` mergeado. Ajustes: `SearchGuard.cacheKey` real inclui `userId|marketplace|query|page|limit`; o pipeline real é `dedupe -> shuffle -> categoria -> relevância -> paginação -> adjudicação (legacy)`; `trustedApiCategory`/`trustedCategorySource` e `categoryNodeAccepts` entram no fluxo; o caminho de API oficial não usa `filterRelevant` quando a categoria é confiável; FRONT ainda não trata 503/`Retry-After` (previsto na Fase 5).

**Decisões fechadas nesta revisão:**

1. **Topologia:** N VPS dedicadas de 2 vCPU por extractor; API central em VPS separada. Se tudo estiver no mesmo host, o pool não é usado (CPU da VPS seria igual para todas as instâncias).
2. **Dono da extração:** o `ai-extractor-api` é o dono único da extração determinística. O `offerExtractor` da API é **legado temporário** até a paridade golden; depois é removido. Fallback após a remoção: `503` com `Retry-After` + estado de UI; durante a migração, fallback legado.
3. **HTML:** a API envia HTML **recortado genericamente** com lista fechada: remove `<style>`, `<svg>`, comentários e data-URIs; preserva `<script type="application/ld+json">`, `<script type="application/json">` e scripts cujo conteúdo case o allowlist de estado (`__INITIAL_STATE__`, `__NEXT_DATA__`, `__PRELOADED_STATE__`, `window.__`); remove os demais scripts. O extractor faz o recorte específico por plataforma. Limite: 1 MB descompactado / 512 KB gzip. Se o recorte passar de 1 MB, a página vira vazio/parcial com métrica (nunca 503); **nunca truncar no meio do HTML**.
4. **Grounding:** o extractor devolve `selection` + `candidates` (≤12 por campo) + `evidence` com `{source, pointer|selector, occurrence}`; o central revalida o candidato escolhido e o valor com o **mesmo módulo de normalização/parsing**. Preço é reparseado para cents; imagem é comparada por URL normalizada; título por igualdade/substring. O mínimo de 3 tokens vale só para texto livre.
5. **Fila:** o fluxo síncrono do FRONT espera no máximo 2,5s e cai no fallback legado (durante migração) ou 200 vazio/503 com UI (após remoção). Fila longa é interna/assíncrona; não há endpoint público 202 no MVP. A fila guarda descritor, nunca HTML.
6. **Heartbeat:** 30s operacional, staleness 90s; 180s configurável, mas declarado insuficiente para o threshold de 75%.
7. **Cache:** memória apenas, sem Redis. Cache de resultado no central por `htmlHashOriginal + htmlHashTrimmed + trimmerVersion + coreVersion + extractorVersion + profile + contractVersion`; `SearchGuard` **não** usa hash na chave pré-fetch.
8. **Persistência:** `AI_EXTRACTOR_MODE=pool` exige Mongo **no central**; reservas são **sempre persistidas no Mongo**, mesmo com `REPLICA_COUNT=1`; o extractor pode usar memory. `pool` vazio não derruba o boot: entra em `degraded`.
9. **Boot:** allowlist é semeada com `status='unknown'`; falha de boot só por config inválida (JSON, chave, persistência), nunca por liveness.
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
| Throughput por instância | ≥ 1,5 req/s (1MB, capacity=2) |
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
- `systemStatus` do central: `ok|degraded|unavailable`; `degraded` quando pool vazio/stale ou breaker aberto; `unavailable` quando não há fallback legado. A UI lê esse estado no health/admin e combina com `quality` do card; a busca também recebe `x-system-status` na resposta (cache curto).
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

### 3.2 Reservas

`tb_aiExtractorReservations`: `{reservationId, requestId, dns, expiresAt, createdAt}`.

- `$inc reserved` + insert da reserva; release idempotente.
- TTL index em `expiresAt` remove reserva órfã.
- **Sweep a cada 30s**: `countDocuments({dns, expiresAt>now})`, corrige `reserved`, loga divergência.
- Boot reconcile mantido.
- Admissão: `max(reserved, reportedInflight) < capacity`.
- Alerta `reserved_divergence > 0`.

### 3.3 Heartbeat

`POST /internal/ai-extractors/heartbeat` com:

- `x-extractor-dns`, `x-extractor-boot-id`, `x-extractor-seq`, `x-extractor-ts`, `x-extractor-signature`.
- Corpo: `dns`, `version`, `contractVersion`, `coreVersion`, `platforms`, `profileHashes`, `capacity`, `use`, `useRaw`, `cpuMetricSupported`, `reportedInflight`, `queueDepth`, `eventLoopLagMs`, `p95LatencyMs`, `status`, `measuredAt`.
- HMAC-SHA256 sobre JSON canônico (`dns|bootId|seq|ts|use|useRaw|reportedInflight|capacity|contractVersion|coreVersion|platforms`), chave por instância.
- `bootId` novo reinicia `seq`; `seq` regressivo/repetido com mesmo boot é rejeitado.
- `lastSeq`/`bootId` atualizados na **mesma** `findOneAndUpdate`.
- Janela de `ts` (ex.: ±5 min) para clock skew.
- Allowlist `AI_EXTRACTOR_POOL_JSON` com `keyEnv`.
- Heartbeat 30s; staleness 90s; 180s configurável (grosseiro).
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

### 4.1 Elegibilidade

`status=online`, `lastSeenAt >= now - AI_EXTRACTOR_STALENESS_MS` (central; default 90s, validado ≥3× heartbeat), `cpuMetricSupported`, `saturated=false`, `use<75`, `max(reserved,reportedInflight)<capacity`, `contractVersion`, `coreVersion` compatível (major), `platforms`, `profileHashes`, breaker.

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

- Lista fechada, idêntica à §0.3: remove `<style>`, `<svg>`, comentários, data-URIs e **scripts fora do allowlist**; preserva `application/ld+json`, `application/json` e scripts com chaves de estado (`__INITIAL_STATE__`, `__NEXT_DATA__`, `__PRELOADED_STATE__`, `window.__`).
- O recorte específico por card é feito **no extractor**, que conhece os seletores.
- Alvo: 200–500KB; máximo 1MB; gzip nível 1 acima de 256KB.
- `trimmerVersion` sofre bump obrigatório ao mudar a lista de recorte; jobs guardam a versão e job com versão antiga é rejeitado/reprocessado.
- Normalização única usada por recorte, evidência e revalidação (evita falso `needsReview`).

### 6.4 Capacidade e semáforos

- `EXTRACTOR_REQUEST_CAPACITY=2`.
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

### 7.1 HTML fora do resultado

- `MarketplaceScraper.browseOffers` **não** devolve `html` em `MarketplaceProductSearchResult`; no caminho capture devolve `ScrapeCapture {rawOffers: [], sourceUrl, html, htmlRef, htmlHashOriginal, htmlHashTrimmed, pageHealthy}`. `discarded` é do provider no legacy e do facade no pool; uma única origem por modo.
- `MarketplaceService.browseOffers` consome o `ScrapeResult` via `extractionGateway.extractCardsFromScrape(result, context)` (`legacy|shadow|capture`).
- O HTML é usado em memória para o pool e para a revalidação; o controller nunca serializa HTML ao FRONT.
- O `scrapeCache` passa a ser escrito de forma **awaited e incondicional** quando existe HTML, mesmo com 0 ofertas. `htmlRef` usa um store content-addressed novo (`sha256(htmlOriginal)`) ou a chave de URL atual **acrescida do hash**; não reutilizar cegamente o `sha1(url)`. Jobs assíncronos usam `htmlRef`; se expirou, `HTML_EXPIRED` + re-coleta.
- Se o recorte passar de 1MB, **não truncar e não chamar pool/legado**: vazio/parcial com `quality='html_too_large_after_trim'` + métrica; nunca 503.
- `scrapeCache` tem cap total de bytes (`SCRAPE_CACHE_MAX_BYTES`) e limpeza alinhada ao TTL (10min de leitura, remoção ≤1h); não usar o cleanup de 3h/3×dia sem cap.
- `SearchGuard` cache key (pré-fetch) = chave atual real (`${userId}|${marketplace}|${query.toLowerCase()}|${page}|${limit}`) + `mode + contractVersion + extractorVersion + coreVersion + trimmerVersion`. Hash **não** entra na chave pré-fetch; ele entra na cache de resultado pós-fetch (`htmlHashOriginal + htmlHashTrimmed + trimmerVersion + coreVersion + extractorVersion + profile + contractVersion`).

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
  - challenge/anti-bot → no máximo 1 render, **pula aquela fonte e continua**; 400 `OFFERS_UNAVAILABLE` só quando **todas** as fontes estão bloqueadas; infra do pool → 503; `NO_CARDS` → 200; testar 2 fontes (uma bloqueada, uma saudável) e ambas bloqueadas;
  - página válida sem sinal de preço BRL **quando `requiresBrl`** → **1 fetch por fonte e para aquela fonte**, vazio + métrica; o loop de fontes continua; em perfis sem `requiresBrl`, a ausência de preço é decidida pelo extractor/facade, não pelo gate;
  - página com preço/cards → segue;
  - budget `EXTRACTOR_PAGE_BUDGET` por fonte e global; primeira fonte vazia não impede a segunda.
- `discarded`/`categoryReview` derivados do `rejected`/gates do pool, com mapeamento dos 8 buckets (`missingTitle`, `missingPrice`, `missingImage`, `invalidLink`, `notAProduct`, `ambiguousPrice`, `currency`, `irrelevant`); `invalidLink`/`irrelevant` são gates locais do facade.
- **Ofertas Automáticas** é o produtor da fila bulk (`priority=bulk`, `ownerId`, orçamento próprio) via o mesmo facade; a Fase 4 só está no MVP com esse produtor e usa o padrão 202 já existente em `autoOfferController`. O FRONT síncrono não usa fila longa.
- Caminho de API oficial (sem HTML) usa `legacy`/`/v1/adjudicate` ou `/v1/execute`; não usa pool de extração.
- `affiliateUrl` gerado no facade após permalink.

### 7.3 Revalidação central

1. `priceCents>0`, `currency==='BRL'`.
2. `originalPriceCents` null ou `> priceCents`.
3. `imageUrl` http(s) host permitido.
4. `permalink` host do marketplace.
5. `selection` IDs existem em `candidates`; `evidence.cardRoot` resolve no HTML original e `pointer|selector|occurrence` são resolvidos **dentro** dele (não no documento). Título por igualdade/substring normalizada; preço reparseado para cents e comparado; imagem por URL normalizada; texto livre com mínimo de 3 tokens. Gramática versionada (`contractVersion`) e teste golden multi-card (preço do card N não casa com o card 1).
6. `externalProductId` consistente com permalink.
7. `cardId` único; se `coverageComplete=true`, cobertura `|cards ∪ rejected| == min(scanned,maxCards)`; se `false`, tratar como parcial/needsReview, não 503.
8. Falha -> `needsReview`, nunca descarte silencioso.

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

### 7.5 Boot/degraded

- Allowlist semeada com `status='unknown'`.
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

## 11. Fases

0. Baseline/go-no-go + ADR + contratos.
1. Extração no extractor com paridade golden + `/v1/extract` raw/gzip + recorte.
2. Registry/heartbeat/reservas/CPU.
3. Scheduler/deadline/breaker.
4. Fila/async **somente com Ofertas Automáticas como produtor** (usa o padrão 202 existente); sem esse produtor, Fase 4 fica fora do MVP.
5. Integração API (`htmlRef`, revalidação, cache key, modos, facade `extractionGateway`).
6. Carga/rollout.

---

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
| boot vazio | seed unknown + degraded, não fail |
| seq restart | bootId reinicia seq |

---

## 13. Decisões fechadas

1. Heartbeat 30s (180s configurável, grosseiro).
2. Sync wait 2,5s + fallback/503; fila só async.
3. HTML recortado 1MB, gzip 512KB.
4. N VPS 2 vCPU + API separada.
5. Dono único da extração = ai-extractor; legado temporário; depois 503+UI.
6. Plataformas iniciais: Amazon, Mercado Livre, Shopee.
7. LLM externo; sem modelo local.

---

## 14. Critérios de aceite

1. 1MB/gzip 200; 1–1,2MB `HTML_TOO_LARGE`; >1,2MB `PAYLOAD_TOO_LARGE`; zip bomb rejeitado.
2. Grounding: `cardRoot` resolve no HTML original; selection ∈ candidates; quote/path/occurrence dentro do root; fixture multi-card prova que o preço do card N não casa com o card 1; zero valor fora.
3. Scheduler: score; 75/60; max(reserved,reported)<capacity; contador reconciliado ≤30s; documento de reserva removido ≤120s; histerese.
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
14. UX: estado de fila/degradado/503 com Retry-After; sem correção silenciosa; `retry:0` para 503 (mutation de busca).
15. `NO_CARDS_EXTRACTED` retorna 200 vazio, nunca 503; `coverageComplete=false`/recorte >1MB não derrubam a busca.
16. Recorte não destrutivo: extração com e sem recorte produz o mesmo conjunto em todos os fixtures (DOM parity, JSON-LD off).
17. Facade: falha de afiliação não remove o card; legacy não reextrai; pool não chama `extractOffers`.
18. Job com `trimmerVersion/coreVersion` antigo é reprocessado; `idempotencyKey` único evita duplicata; `contractVersion` incompatível rejeita.
19. `pageHealthy` com preço só em JSON (sem “R$”) extrai; primeira fonte vazia não impede a segunda.
20. `X-System-Status` exposto no CORS; UI lê o header e cai no health/admin em 503.
21. Shadow compara final×final (legado pós-processado × pool pós-processado) e conta 1 extração local + 1 pool por amostra.
22. `trimmerVersion` entra na chave pré-fetch e no cache de resultado; bump invalida.

---

## 14.1 Notas de implementação (P2, não bloqueiam)

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

## Estado da implementação (MVP, 2026-10-27)

Implementado e testado:

- **Extractor (`ai-extractor-api`)**: `POST /api/v1/extract` com corpo binário/gzip, `x-extract-meta`, validação de `contractVersion`/`htmlHashTrimmed`/`htmlBytes`, tetos de 1 MB/512 KB/1,2 MB; extração determinística por plataforma (Amazon, Mercado Livre, Shopee, AliExpress, Shein) por JSON-LD + DOM; adjudicação opcional via perfil `cards`; `no_cards` = 200; heartbeat 30 s com CPU (cgroup v1/v2 → `/proc/stat` → loadavg), in-flight, capacidade, versões e plataformas, HMAC/bootId/seq; `draining` no shutdown.
- **API central**: schemas `tb_aiExtractorInstances`/`tb_aiExtractorReservations`; registry com saturação 75/60, elegibilidade por CPU+contrato+plataforma+stale, score `0.6*CPU + 0.4*ocupação`, reserva atômica (`max(reserved,reportedInflight) < capacity`), release e sweep de 30 s com TTL; allowlist semeada no boot; endpoints internos de heartbeat/health/instances/eligible/sweep com `x-internal-key` (tempo constante) + HMAC.
- **Cliente do pool**: recorte genérico `trim@1` antes do envio (nunca trunca; >1 MB = vazio autoritativo `html_too_large_after_trim`), gzip, retry em conexão/429/502/503/504 (máx. 2 instâncias), timeout de busca síncrona de 2,5 s (bulk 15 s), espera curta por capacidade quando todas estão saturadas, cache de resultado por hash+versões e revalidação central (preço/moeda/imagem/permalink/ID/evidência → `needsReview`, nunca descarte silencioso).
- **Modos**: `legacy` default (caminho atual preservado), `pool` (zero extração local, `no_cards` autoritativo) e `shadow` (amostra estável de 5%, pool em paralelo ao legado, sem latência adicional).
- **Pipeline**: `MarketplaceService` e `autoOfferSearch` usam o mesmo hook; challenge continua por fonte (400 só quando todas bloqueiam); `discarded` do pool é mesclado ao do provider.
- **Observabilidade/UX**: header `X-System-Status` em `/api/v1` + `/api/v1/health` (`ok|degraded|unavailable`, cache de 5 s com single-flight e escopo por plataforma); CORS expõe o header e `Retry-After`; FRONT lê o header, trata 503/`Retry-After` sem retry cego (queryClient e mutations), mostra estado degradado, estado vazio próprio para `no_cards`/`all_rejected`/HTML grande e feedback “aguardando capacidade” após 500 ms.
- **Fila (MVP)**: o job 202 de Ofertas Automáticas é o produtor assíncrono; quando o pool está saturado, a chamada espera até o orçamento bulk (15 s) por capacidade da PLATAFORMA e, esgotado, cai no legado (migração). Não há fila durável nova no MVP — o FRONT síncrono nunca espera além de 2,5 s (aproximado pelo deadline).
- **Reserva**: locks por slot `(dns, slot)` com índice único (admissão nunca depende de contador lido/escrito); índices do pool falham o boot se não puderem ser criados; `reserved` é métrica reconciliada por CAS no sweep. Extractor tem admissão local (`EXTRACTOR_CAPACITY` → 429 `EXTRACTOR_BUSY` + `Retry-After`) e mantém a vaga até o trabalho real terminar (timeout devolve 504 sem liberar CPU fantasma).
- **Page health**: `no_cards` do pool só encerra a cascata quando a página é saudável (fora do cache, ≥ `AI_EXTRACTOR_PAGE_MIN_BYTES`, sem challenge, sinal BRL quando `requiresBrl` e sinal de listagem — JSON-LD/âncora de produto/`productId`); shell JS (mesmo >20 KB) continua para fetch/render.
- **Sem fallback legado** (`AI_EXTRACTOR_LEGACY_FALLBACK=false`): erro/indisponibilidade do pool vira `503` com `Retry-After`; challenge continua `400`; `shadow` + fallback desligado falha o boot.

Diferenças conscientes em relação ao desenho completo: o facade ainda é o hook `extractRemote` do provider (não existe `ScrapeResult` formal); a fila bulk é a espera limitada acima (sem coleção de jobs nova); a evidência valida os quotes no DOCUMENTO (não no escopo estrito do `cardRoot`) para não invalidar layouts sem container estável — o risco residual é um valor do card N existir em outro card; shadow compara contagens (não diff final×final), então não serve como gate de rollout; SSRF bloqueia IPs literais (IPv4/IPv6, mapeados inclusive hex) e exige HTTPS em produção, mas DNS rebinding depende do resolver do host.


