# Validação — pool de extração (2026-11-05)

Registro da validação local ponta a ponta: cadastro do serviço, subida dos processos, autenticação,
healthcheck, buscas, fila bulk e tela administrativa.

## Ambiente

| Item | Valor |
| --- | --- |
| API central | `http://127.0.0.1:2222` |
| Serviço local | `http://localhost:5555` |
| `workerId` | `c932af8c-4de4-475d-a8a2-981591d4bde9` |
| Mongo | `automatize_dev` |
| Branches | API `feat/ia-cars-validation-integration` · extractor `feat/extractor-pool-scheduler` · FRONT `feat/admin-extractor-services` |

## 1. Cadastro do serviço no banco (admin)

`tb_aiextractorservices`:
```json
{
  "serviceId": "df0c5501-3b44-412b-b932-d2cb69701ab2",
  "name": "Local (dev)",
  "url": "localhost:5555",
  "keyEnv": "EXTRACTOR_KEY",
  "enabled": true,
  "notes": "worker local de validação"
}
```

`tb_aiextractorinstances` (publicado pelo próprio worker):
```json
{
  "workerId": "c932af8c-4de4-475d-a8a2-981591d4bde9",
  "dns": "localhost:5555",
  "observedStatus": "online",
  "desiredStatus": "auto",
  "use": 23.2,
  "reportedInflight": 0,
  "capacity": 1,
  "saturated": false,
  "offersContractVersion": "2",
  "coreMajor": 1,
  "capabilities": ["amazon", "mercadolivre", "aliexpress", "shein"],
  "lastHeartbeatAt": "2026-11-05T03:18:34.068Z"
}
```

API confirma elegibilidade:
```json
{"instances":[{"dns":"localhost:5555","use":23.2,"reserved":0,"reportedInflight":0,"capacity":1}]}
```

## 2. Autenticação (chave única compartilhada)

Modelo: `AI_INTERNAL_KEY` idêntica no `.env` da API e de **todos** os serviços; header `x-internal-key`
comparado em tempo constante.

| Teste | Resultado |
| --- | --- |
| API `POST /internal/ai-extractors/jobs/claim` sem chave | **403** |
| API idem com chave errada | **403** |
| API idem com chave correta | **200** `{jobs:[]}` |
| Extractor `POST /api/v1/extract-offers` sem chave | **401** |
| Extractor idem com chave correta + contrato inválido | passou auth → **400 CONTRACT_MISMATCH** |
| API `GET /internal/ai-extractor/config` sem chave | **401** |
| API idem com chave correta | **200** (config) |

## 3. Healthcheck e fallback determinístico

- Rota: `GET <serviço>/api/v1/health` → `{"success":true,"data":{"status":"ok",...}}`.
- A API valida antes de enviar trabalho: timeout 1 s, cache 10 s; sem `status: ok` pula para a **próxima**
  da lista ordenada (score + `lastDispatchedAt`), no máximo `AI_EXTRACTOR_MAX_INSTANCE_ATTEMPTS` (3).
- Sem sorteio, sem repetir a mesma instância e sem loop. Nenhuma saudável → 503 sem reservar slot.

| Cenário | Resultado |
| --- | --- |
| Serviço no ar | `health 200` + busca `200` |
| Serviço parado (ainda elegível por heartbeat) | **503 em 0,31 s** |
| Log | `[health] worker localhost:5555 sem resposta: fetch failed` → `No healthy extractor instance (healthcheck)` |
| Serviço reiniciado | busca `200` novamente |
| Teste com 2 instâncias (1ª unhealthy) | health na 1ª falha → requisição vai para a 2ª (2 health calls, 1 extração) |
| Teste todas unhealthy | 503 e **0 extrações** |

## 4. Buscas (retorno para o FRONT)

`GET /api/v1/platforms/aliexpress/offers?q=fone%20bluetooth&page=1&limit=24` → **200** em 0,19 s
(cache) e 24 itens. Contrato inalterado (`data.items`).

Amostra:
```json
{
  "success": true,
  "count": 24,
  "items[0]": {
    "marketplace": "aliexpress",
    "externalProductId": "1005012280076565",
    "title": "Fones de Ouvido Sem Fio QCY HT21 Melobuds N65...",
    "price": 21772,
    "originalPrice": null,
    "currency": "BRL",
    "image": "https://...",
    "permalink": "https://pt.aliexpress.com/item/1005012280076565.html",
    "affiliateUrl": null,
    "commissionRate": null
  }
}
```

`GET ...&limit=2` (sem cache) → 200 em ~2,8–5,7 s com preflight.

Mercado Livre: **503** em 1,3 s; o extractor registrou `unblocker HTTP 429` → `quality=blocked`.
Não é autenticação nem contrato — é limite externo do provedor.

## 5. Fila bulk e fan-out

```text
ENQUEUED 310814c5-b1dc-4240-8b0a-e16f187d9f28
FINAL {"status":"completed","claims":1,"error":null,"offers":60,"quality":"ok"}

PULL {"rows":60,"first":"Novo x15 tws fones de ouvido bluetooth...",
      "delivery":{"status":"delivered","offers":60,"claim":1}}
```

Logs do extractor:
```text
[jobs] done jobId=310814c5-... marketplace=aliexpress quality=ok offers=60 sources=1 ms=2388
[jobs] done jobId=1120222c-... marketplace=aliexpress quality=ok offers=60 sources=1 ms=2821
```

## 6. Tela administrativa (FRONT)

- Rota: **Administração → Serviços de extração** (`/admin/servicos-extracao`).
- Lista cadastro + status do heartbeat (online/offline/drenando), CPU, in-flight/capacidade, capabilities.
- CRUD: criar, editar, habilitar/desabilitar, remover.
- Validação: `tsc -b` ok, `eslint` ok, `vitest` **24/24**, `vite build` ok.

## 7. Suítes automatizadas

| Suíte | Resultado |
| --- | --- |
| API unit | **716/716** |
| API suíte completa | **1456/1456** |
| Extractor | **158/158** |

## 8. Observações / pendências

- Mercado Livre depende do unblocker (429 externo no momento do teste).
- Benchmark (N≥30/plataforma), carga 8/pico 3 e rollout 5→25→100% ainda são operacionais.
- `keyEnv` do cadastro é legado do heartbeat HMAC; a autenticação atual é a chave única `AI_INTERNAL_KEY`.
- Reservas usam `(dns, slot)` com `workerId` gravado; migração para `workerId` puro segue pendente.
- O upsert de estado agora é por `workerId` (DNS é metadado; troca de DNS não duplica linha).
- Onboarding da VPS de serviço (colisão de DNS, control URL, 429 do unblocker e teste forçado pelo HUB):
  `docs/TROUBLESHOOTING_VPS_2026-11-06.md`.
