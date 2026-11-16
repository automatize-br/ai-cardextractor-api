# Diagnóstico — disparos vazios na Amazon (Ofertas Automáticas)

**Data:** 2026-11-16 · **Status:** causa raiz confirmada com reprodução + correção aplicada na API

> 🔁 **DOC GÊMEA** — este documento existe nos DOIS projetos e deve ser atualizado sempre nos dois:
> - API central: `D:\MEUS_PROJETOS\AUTOMATIZE\API\docs\DIAGNOSTICO_DISPAROS_AMAZON_2026-11-16.md`
> - Worker: `D:\MEUS_PROJETOS\AUTOMATIZE\IA OFERT EXTRACT\ai-extractor-api\docs\DIAGNOSTICO_DISPAROS_AMAZON_2026-11-16.md`

---

## 1. Sintoma

Automações de Ofertas Automáticas com a plataforma **Amazon** nunca enviam nada:
todo ciclo termina `SKIPPED` com `NO_ELIGIBLE_PRODUCTS` ("Nenhuma oferta encontrada").
A busca MANUAL ("Explorar ofertas" na mesma plataforma) **funciona** (30 cards).

Amostra de prod (7d, `tb_autoofferexecutions`): natanaelgemes18 98/98 SKIPPED ·
luiz.adm83 92/92 · ericvinicius1987 78/88 (os envios que saíram eram Shopee) ·
deborahdelaye 32/32 · pedroorf 1/1. Zero produtos Amazon gerados.

## 2. Causa raiz (medida, não deduzida)

A automação dava **15s** de orçamento ao worker; a coleta Amazon leva **16–21s**.
A busca manual dava **120s** → funcionava. Teste real no worker de produção
(`api-scrapping.vupia.com.br`, rota `POST /api/v1/extract-offers`, contrato v2,
mesma URL que a automação monta — `https://www.amazon.com.br/s?k=informatica`):

| Orçamento (`waitMs`) | Resultado |
|---|---|
| **15s** (o que a automação passava) | ❌ `HTTP 504 MODEL_TIMEOUT` em 15,1s · 0 ofertas |
| **120s** (o que a busca manual usa) | ✅ `HTTP 200` em 21s · **54 ofertas** · `quality=ok` |

- A automação (`autoOfferSearch.searchOne` na API central) chamava
  `extractOffersViaPool` com `waitMs: env.AI_EXTRACTOR_POOL_BULK_WAIT_MS` →
  variável fora do `.env` da API → **default 15.000ms**.
- O `BULK_WAIT_MS` foi dimensionado para a FILA EM LOTE (várias URLs por job,
  custo amortizado). Usado na coleta interativa de 1 URL, aborta o worker antes
  do fim → 0 ofertas → fonte entra em cooldown → `NO_ELIGIBLE_PRODUCTS` no
  ciclo inteiro. Determinístico enquanto o unblocker responder em >15s.
- O manual (`marketplaceService.browseOffers`) chama o pool **sem `waitMs`**
  → cai no `AI_EXTRACTOR_POOL_SCRAPE_TIMEOUT_MS` (120s) → sobra tempo.

**O scraping em si NÃO estava quebrado**: o worker coleta `/deals` E as páginas
de busca `/s?k=` (perfis Amazon com seletores `/dp/` funcionam na `/s?k=`).
Cascata do worker (`src/modules/remoteExtraction/pageFetcher.ts`):
**unblocker (Decodo) → fetch direto**; desafios anti-bot são detectados
(`looksLikeChallenge`) e a página anti-bot não tem cards (`no_cards`).

## 3. Correção aplicada (API central)

`src/modules/autoOffers/autoOfferSearch.ts`:

```ts
// antes
waitMs: env.AI_EXTRACTOR_POOL_BULK_WAIT_MS,
// depois — mesmo orçamento da coleta interativa (1 URL)
waitMs: env.AI_EXTRACTOR_POOL_SCRAPE_TIMEOUT_MS,
```

Commit API: `77f9ac0` (`dev`). Suíte 1549/1549 · typecheck · build ✅.
Teste de regressão: `tests/integration/autoOfferSourceCooldown.test.ts`
(assert: orçamento enviado ao worker ≥ 30s + ofertas do worker viram candidatos).

> O ciclo agendado NÃO tem o teto de 10min do manual (`MANUAL_SEARCH_TIMEOUT_MS`
> só é passado no disparo manual) — o teto real passa a ser o próprio 120s do pool.

**Follow-up (mesmo dia)** — após o deploy, o ciclo de 21:45 (ainda no código antigo)
gravou cache `amazon/games · 0 rows`: o pool respondeu 200 com `no_cards` dentro dos
15s. Como o `get()` do cache (API central) tratava qualquer entrada ≤6h como hit
(mesmo vazia), os ciclos seguintes liam o cache e terminavam `NO_ELIGIBLE` SEM
coletar — envenenamento de até 6h por (usuário, categoria, plataforma). Corrigido
em `autoOfferSearchCacheRepository.ts`: **resultado vazio não é gravado** e
**entrada vazia não é hit**. Para o worker não muda nada (o fix é 100% na API).

## 4. Orçamentos de tempo da coleta (referência API ↔ worker)

| Variável (API central) | Default | Uso |
|---|---|---|
| `AI_EXTRACTOR_POOL_SCRAPE_TIMEOUT_MS` | 120000 | Coleta INTERATIVA de 1 URL (busca manual, automação desde a correção) |
| `AI_EXTRACTOR_POOL_BULK_WAIT_MS` | 15000 | Fila em LOTE / espera por capacidade — NÃO usar em coleta interativa |
| `AI_EXTRACTOR_POOL_TIMEOUT_MS` | 6000 | Healthcheck/sync do pool |

No worker (`ai-extractor-api`): `EXTRACTOR_SCRAPE_TIMEOUT_MS` é o teto da própria
extração (o controller faz `race` até `min(EXTRACTOR_SCRAPE_TIMEOUT_MS, deadlineAt - now)`),
`SCRAPE_UNBLOCKER_TIMEOUT_MS` limita o unblocker, `EXTRACTOR_CAPACITY` limita
extrações simultâneas (429 `EXTRACTOR_BUSY` com `Retry-After: 2`).

Latências medidas em prod (16/11/2026, worker do pool): `/deals` 16,7s ·
`/s?k=informatica` 21,1s · `/s?k=fone bluetooth` 21,0s (unblocker lento; quando
mais rápido, <15s, os 15s do bulk "passavam" — daí o problema parecer intermitente).

## 5. Gap secundário (pendente, API central)

Todos os clientes têm a Amazon conectada **só com a Tag de Associado** —
`accessKey` (Credential ID) e `secretKey` (Credential Secret) VAZIOS (verificado
descriptografando `tb_marketplaceaccounts` em prod). Consequência:
`amazonProvider.supportsSearch()` (exige os 3 campos) = false → a **API oficial
(Creators) nunca é usada** pela automação; tudo depende do scraping.
`validators.ts` (API) aceita só a Tag na conexão. Recomendação: coletar/orientar
Credential ID + Secret no onboarding e avisar o cliente quando a Amazon for
pulada por isso (hoje vira "Nenhuma oferta encontrada", sem explicar o motivo).

## 6. Como reproduzir/verificar

```bash
# API central: diagnóstico direto no worker (compara orçamentos)
node --import tsx scripts/diag-amazon-worker.ts     # 3 URLs, orçamento 90s
node --import tsx scripts/diag-amazon-worker3.ts    # reproduz 15s=504 vs 120s=200

# Monitor de ciclo da automação (prod da API, somente leitura)
MONGO_ENVIRONMENT=automatize_prod node --import tsx scripts/monitor-pedroorf.ts

# Worker: teste pela rota real
# POST https://api-scrapping.vupia.com.br/api/v1/extract-offers
# headers: x-internal-key · body: { contractVersion:"2", marketplace, urls[], query, deadlineAt }
# 200 → { success, data: { quality, offers[], discarded } } · estouro → 504 MODEL_TIMEOUT
```

## 7. Regra de sincronização

Qualquer mudança de **contrato, orçamento de tempo ou variável de ambiente** da
coleta pool deve ser refletida NESTA doc nos dois projetos no mesmo commit/PR:
API (`docs/DIAGNOSTICO_DISPAROS_AMAZON_2026-11-16.md` + `docs/CONFIG_IA_EXTRACTOR.md`)
e worker (`docs/DIAGNOSTICO_DISPAROS_AMAZON_2026-11-16.md` + `docs/TROUBLESHOOTING_VPS_2026-11-06.md`).
