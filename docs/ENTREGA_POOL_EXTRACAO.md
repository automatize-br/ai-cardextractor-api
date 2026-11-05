# Entrega — pool de extração distribuída (PLAN2)

**Versão do plano:** 5.2.0 (`docs/PLANO_POOL_EXTRACAO_DISTRIBUIDA.md`)
**Repositórios:** `ai-extractor-api` (workers) + `../API` (central)
**Escopo:** toda mudança é entre **API central ↔ extractors**. **Nenhuma mudança no FRONT**; contrato
público (`MarketplaceProductSearchResult[]`, headers, códigos) preservado.

---

## 1. Arquitetura entregue

```
FRONT → API central (HUB/SWITCH)
          ├─ síncrono: push → POST /api/v1/extract-offers (deadline, 1 chamada com N URLs)
          ├─ bulk:     pull → tb_aiExtractorJobs (claim/lease/CAS) → worker executa
          └─ resultado bulk: tb_aiExtractionResults → fan-out por participante
```

- **Síncrono (busca do usuário):** push, escolha da instância menos ocupada, reservas por slot.
- **Bulk (Ofertas Automáticas):** fila pull durável; worker não escreve no Mongo (claim/resultado via
  control plane autenticado).
- **HTML nunca sai do worker**; a API recebe ofertas já revalidadas.
- **Identidade do worker:** `workerId` UUID persistido em arquivo; `dns`/`host` são metadados.
- **Estado:** `desiredStatus` (admin/reaper) × `observedStatus` (reaper) × `lastHeartbeatAt` (worker).

## 2. Coleções (MongoDB)

| Coleção | Papel |
| --- | --- |
| `tb_aiextractorinstances` | estado/métricas do worker (workerId, capabilities, contrato v2, heartbeat) |
| `tb_aiextractorreservations` | ledger de slots (síncrono e bulk), `(dns, slot)` + `workerId`/`jobId`/`claim` |
| `tb_aiextractorbulkleases` | admissão de frota do bulk (`frota−1` slots) |
| `tb_aiextractorjobs` | fila durável (descritor, nunca HTML/credencial) |
| `tb_aiextractionresults` | resultado validado `{jobId, claim}`, TTL 6 h |
| `tb_autoofferdeliveries` | fan-out idempotente por participante |
| `tb_aiextractorservices` | cadastro (admin) dos serviços/URLs do pool; fonte do allowlist |

## 3. Endpoints

### Worker (interno, `x-internal-key`)

| Método | Rota |
| --- | --- |
| `POST` | `/api/v1/internal/ai-extractors/jobs/claim` |
| `POST` | `/api/v1/internal/ai-extractors/jobs/:jobId/renew` |
| `POST` | `/api/v1/internal/ai-extractors/jobs/:jobId/result` |
| `POST` | `/api/v1/internal/ai-extractors/jobs/:jobId/fail` |
| `POST` | `/api/v1/internal/ai-extractors/heartbeat` (modo legado) |

### Admin (`authMiddleware` + admin)

| Método | Rota |
| --- | --- |
| `GET/POST/PUT/DELETE` | `/api/v1/admin/ai-extractor/services[/:serviceId]` | cadastro de serviços (URL/nome/keyEnv/enabled) |
| `GET` | `/api/v1/admin/ai-extractor/instances` |
| `POST` | `/api/v1/admin/ai-extractor/instances/:workerId/drain` |
| `POST` | `/api/v1/admin/ai-extractor/instances/:workerId/resume` |
| `GET` | `/api/v1/admin/ai-extractor/jobs?status=` |
| `POST` | `/api/v1/admin/ai-extractor/jobs/:jobId/retry` |
| `POST` | `/api/v1/admin/ai-extractor/jobs/:jobId/cancel` |
| `GET` | `/api/v1/admin/ai-extractor/jobs/:jobId/deliveries` |

### Dono do job (autenticado)

| Método | Rota |
| --- | --- |
| `GET` | `/api/v1/extraction-jobs/:jobId` |
| `GET` | `/api/v1/extraction-jobs/:jobId/result` |

### Contrato v2 (extractor)

`POST /api/v1/extract-offers` — o worker busca (`unblocker → proxy → HTTP`), resolve challenge, recorta,
extrai e revalida. Retorna `offers[]` no contrato `RawOffer`. O endpoint legado `/api/v1/extract` fica
para rollback.

## 4. Variáveis de ambiente

### Worker (`ai-extractor-api/.env`)

| Variável | Default | Papel |
| --- | --- | --- |
| `EXTRACTOR_DNS` | — | host/DNS do worker (allowlist da API) |
| `EXTRACTOR_CONTROL_URL` | — | URL da API central (fila/health) |
| `AI_INTERNAL_KEY` | — | chave do control plane (mesma da API) |
| `EXTRACTOR_STATE_MODE` | `central` | `mongo` = publica estado direto no Atlas |
| `EXTRACTOR_WORKER_ID_FILE` | `.data/worker-id` | identidade estável (fail-closed) |
| `EXTRACTOR_STATE_HEARTBEAT_MS` | `20000` | liveness/lease |
| `EXTRACTOR_STATE_INTERVAL_MS` | `180000` | snapshot de métricas |
| `EXTRACTOR_CAPACITY` / `_MAX` | `1` / `2` | concorrência (2 exige benchmark) |
| `WORKER_BROWSER_ENABLED` | `false` | sem Chromium; Shopee fora da capability |
| `EXTRACTOR_JOBS_ENABLED` | `false` | liga o poller da fila bulk |
| `EXTRACTOR_JOBS_POLL_MS` | `2000` | polling |
| `EXTRACTOR_JOBS_RENEW_MS` | `20000` | renovação do lease |
| `SCRAPE_UNBLOCKER_AUTH` | — | Decodo (fetch é local ao worker) |
| `CREDENTIALS_ENC_KEY` | — | decifra a config de IA do Mongo |

### Central (`API/.env`)

| Variável | Default | Papel |
| --- | --- | --- |
| `AI_EXTRACTOR_MODE` | `legacy` | `pool` em produção |
| `AI_EXTRACTOR_POOL_JSON` | — | allowlist `[{dns,keyEnv}]` |
| `AI_EXTRACTOR_LEGACY_FALLBACK` | `true` | fallback durante migração |
| `AI_EXTRACTOR_SELECTION_MAX_AGE_MS` | `60000` | heartbeat máximo para seleção |
| `AI_EXTRACTOR_OFFERS_CONTRACT_VERSION` | `2` | gate do contrato de ofertas |
| `AI_EXTRACTOR_OFFERS_CONTRACT_TOLERANCE_UNTIL` | — | janela de rollout (ISO) |
| `AI_EXTRACTOR_CAPACITY_MAX` | `2` | teto de capacidade |
| `AI_EXTRACTOR_QUEUE_ENABLED` | `false` | produtor bulk na fila |
| `AI_EXTRACTOR_JOB_MAX_CATEGORIES` | `5` | categorias por job |
| `AI_EXTRACTOR_JOB_BUDGET_MS` | `285000` | deadline de execução (hard) |
| `AI_EXTRACTOR_QUEUE_DEADLINE_MS` | `600000` | idade máxima na fila |
| `AI_EXTRACTOR_LEASE_MS` | `180000` | lease (renovado a cada 20 s) |
| `AI_EXTRACTOR_MAX_ATTEMPTS` | `3` | tentativas |
| `AI_EXTRACTOR_RESULT_TTL_MS` | `21600000` | TTL do resultado (6 h) |
| `AI_EXTRACTOR_BULK_MIN_FLEET` | `3` | frota mínima para bulk |
| `AI_EXTRACTOR_ALERT_WEBHOOK_URL` | — | canal de alerta |
| `AI_EXTRACTOR_RESERVATION_TTL_MS` | `180000` | TTL da reserva de slot |

## 5. Scripts (API)

| Script | Uso |
| --- | --- |
| `scripts/benchmark-workers.ts` | latência/erro N≥30 por plataforma (Etapa D) |
| `scripts/load-pool.ts` | carga interativa + bulk (Etapa G) |
| `scripts/rollout-check.ts` | pré-condições do rollout (sai com 1 em bloqueio) |

## 6. Runbooks e docs

- `API/docs/CHECKLIST_ROLLOUT.md` — dia do rollout, go/no-go, rollback ≤5 min
- `API/docs/RUNBOOK_FILA_E_DRAIN.md` — fila, drain, sinais e rollback
- `API/docs/RUNBOOK_WORKER_ADD_REMOVE.md` — adicionar/remover worker
- `API/docs/RUNBOOK_ROTACAO_SEGREDOS.md` — rotação de chaves
- `API/docs/BENCHMARK_WORKERS.md` — critérios de capacidade
- `API/docs/LOAD_TEST_G.md` — perfil/métricas de carga
- `API/docs/CONFIG_IA_EXTRACTOR.md` — config de IA + contrato v2 + fila
- `docs/PLANO_POOL_EXTRACAO_DISTRIBUIDA.md` — plano normativo (v5.2.0)
- `docs/ADR-006-hub-push-sync-fila-pull-async.md` — decisão híbrida

## 7. Testes

| Suíte | Resultado |
| --- | --- |
| `ai-extractor-api` | **158/158** |
| API unit | **716/716** |
| API integração (pool/fila/reaper/deliveries/pull) | **41/41** (8 + 18 + 7 + 5 + 3) |

Cenários cobertos: claim concorrente, lease/CAS, perda de lease, deadline hard, falha/retry/backoff,
sweeper, cancelamento, retry `:r{n}`, idempotência de enqueue, fan-out, gate de capability/contrato,
drain/resume, alertas, mapeamento do pull.

## 8. Roteiro de validação (operacional)

1. **Benchmark** na VPS: `benchmark-workers.ts` (N≥30) + CPU/RAM/event loop → decidir `capacity`.
2. **Frota ≥3** saudável e `rollout-check.ts` sem FAIL.
3. **Rodada real de autoOfertas** com `AI_EXTRACTOR_QUEUE_ENABLED=true` (amostra 5%): paridade de ofertas
   e CPU da API ≤ baseline +10 p.p.
4. **Carga**: `load-pool.ts --users 8 --spread 600 --peak 3 --bulk 6`.
5. **Rollout** 5% → 25% → 100% por automação, com rollback documentado.
6. Configurar `AI_EXTRACTOR_ALERT_WEBHOOK_URL` (canal externo).

## 9. Limitações conhecidas

- Deadline do síncrono ainda é **120 s por fonte** no código; o alvo do plano (45 s único + `signal`) não
  foi implementado nesta entrega.
- `legacy`/`shadow` e `autoOfferSearch` com `AI_EXTRACTOR_QUEUE_ENABLED=false` ainda renderizam na API.
- Shopee permanece no legado (worker sem browser).
- Reservas usam `(dns, slot)` como lock, com `workerId` gravado; migração para `workerId` puro pendente.
- Control plane usa `x-internal-key` compartilhada (chave por instância pendente).
- Benchmark/carga/rollout reais ainda não executados (dependem de VPS/frota).
