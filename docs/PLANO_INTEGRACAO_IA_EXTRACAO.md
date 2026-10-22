# Plano de Integração — IA de Extração de Ofertas

**Versão:** 1.0.2
**Criado em:** 2026-10-21
**Última atualização:** 2026-10-21
**Status:** Em implementação (F0 concluída, F1 em andamento)
**Substitui:** `01_ARQUITETURA_E_IA.md` (documento original com 4 documentos empacotados e erros técnicos)
**ADRs relacionados:** `docs/ADR-005-extracao-hibrida.md`, `../../API/docs/adr/004-deterministic-scraping.md`

---

## Histórico de alterações

| Data | Versão | Alteração |
| --- | --- | --- |
| 2026-10-21 | 1.0.0 | Criação do plano consolidado. Consolida as decisões das duas rodadas de revisão adversarial (backend e produto), corrige os erros técnicos do documento original e define o escopo do MVP. |
| 2026-10-21 | 1.0.1 | Registrada a criação do microserviço `ai-extractor-api` (F0/F1) e o contrato de adjudicação implementado. |
| 2026-10-21 | 1.0.2 | Repositório renomeado para `ai-extractor-api`; planos e ADR movidos para `ai-extractor-api/docs/`. Referências de caminho atualizadas. |

> Regra deste documento: toda alteração de escopo, contrato ou fase deve adicionar uma linha na tabela acima com a data e um resumo de uma frase. Não reescrever o histórico.

---

## 1. Objetivo

Aumentar a taxa de extração correta de ofertas (título, preço, preço original, imagem) nas páginas de marketplace, usando um modelo de linguagem pequeno rodando localmente em CPU como **adjudicador** de candidatos já extraídos de forma determinística.

O ganho esperado não é "gerar dados", e sim **escolher** entre candidatos plausíveis quando as heurísticas empatam, e **descartar** cards que não são produtos.

---

## 2. Escopo

### 2.1 No escopo (MVP)

- Microserviço HTTP `ai-extractor-api` (Express + TypeScript + ESM), desacoplado da API Vupia.
- Contrato `POST /v1/adjudicate`: recebe um *pack* de cards com candidatos e devolve apenas **IDs escolhidos**.
- Providers de modelo plugáveis: `llamacpp` (local), `fake` (testes), `http` (endpoint OpenAI-compatible, para GPU/remoto futuro).
- Catálogo de modelos por configuração, com load/unload e status.
- Validação estrita no servidor (IDs opacos, moeda, completude, preço).
- Persistência de auditoria (memory ou Mongo), com hash do pack e métricas de latência.
- Harness de avaliação por CLI e modo `shadow` (replay offline).
- Uma página: coleta disparada pela UI existente (`WebScrappingPage`), sem crawler.

### 2.2 Fora do escopo (MVP)

- Geração de títulos, preços, links ou descrições pelo modelo.
- Crawler/agendador próprio.
- Recipe learning (o modelo aprender rotas/ seletores).
- Fine-tuning obrigatório para entrar em produção (usa-se modelo base + prompt).
- Processamento de imagem por VLM (só heurística; CLIP/SigLIP na F5).
- Envio de mensagens: a IA nunca decide envio; apenas marca `needsReview`.

---

## 3. Invariantes (não negociáveis)

1. **A IA não gera valores.** Ela devolve `cardId` + IDs opacos de candidatos existentes no pack.
2. **Preço sempre presente** em reais, convertido para centavos no servidor da API Vupia (fonte da verdade).
3. **Moeda por candidato.** Candidato com moeda diferente de BRL é descartado (`discarded.currency_mismatch`). Sem conversão cambial.
4. **Preço ambíguo é descarte**, nunca chute.
5. **Oferta desmembrada é descarte**, não `needsReview`. Faltou título/preço/imagem/link válido → fora.
6. **`needsReview` é exceção**: só para oferta completa e incerta; bloqueia envio quando o motivo é preço/moeda.
7. **Timeout ou falha do modelo degrada para o determinístico**, nunca 5xx para o usuário.
8. **A IA só é chamada por `MarketplaceService.browseOffers`**, nunca dentro do `MarketplaceScraper` nem no fluxo de Ofertas Automáticas (auto-ofertas desligadas no MVP).
9. **Nenhum segredo do usuário** é usado: `ai-extractor-api` tem chave interna própria (`AI_INTERNAL_KEY`), separada do `AiService`/quota `aiMessagesPerDay`.
10. **Determinismo reproduzível**: `packHash` ecoado e validado; `modelVersion`, `promptVersion` e `packVersion` carimbados.

---

## 4. Arquitetura

```
FRONT (../FRONT)
  WebScrappingPage
        |
        | GET /platforms/:marketplace/offers
        v
API Vupia (../../API)
  MarketplaceService.browseOffers
        |
        |-- MarketplaceScraper (determinístico, inalterado)
        |       -> RawOffer[] + candidatos + proveniência
        |
        |-- AdjudicationClient (novo, interno)
        |       POST http://127.0.0.1:3010/v1/adjudicate
        |       timeout 3.5s por lote, aborta e cai no determinístico
        v
ai-extractor-api (novo)
  modules/adjudication
        |
        |-- validators (schema do pack, IDs, moeda, completude)
        |-- prompt + gramática GBNF estática
        |-- providers/llm (llamacpp | http | fake)
        |-- validation pós-modelo (descarta IDs inexistentes/inválidos)
        v
  Qwen2.5-0.5B-Instruct Q4_K_M (CPU, ~400 MB)
```

### 4.1 Por que microserviço separado

- Isola o processo nativo do `node-llama-cpp` (binários, memória, CPU) do processo da API.
- Permite escalar/derrubar a IA sem afetar o uptime da API.
- Permite trocar o provider local por GPU/remoto sem mudar a API.
- O contrato HTTP é o mesmo para `sync` e para um futuro `async` (fila).

---

## 5. Contrato

### 5.1 Request (`POST /v1/adjudicate`)

```json
{
  "packVersion": "1",
  "marketplace": "amazon",
  "cards": [
    {
      "cardId": "c_7f3a",
      "host": "amazon.com.br",
      "titleCandidates": [{ "id": "t_1", "text": "Fone Bluetooth XYZ" }],
      "priceCandidates": [
        { "id": "p_1", "text": "R$ 199,90", "currency": "BRL", "cents": 19990, "kind": "current" },
        { "id": "p_2", "text": "R$ 249,90", "currency": "BRL", "cents": 24990, "kind": "original" }
      ],
      "imageCandidates": [{ "id": "i_1", "url": "https://m.media-amazon.com/images/I/x.jpg" }],
      "context": { "position": 3, "breadcrumb": "Eletrônicos > Áudio" }
    }
  ]
}
```

Regras do request:
- `cards`: 1..N (limite operacional 30 por chamada).
- `cardId`, `titleCandidates[].id`, `priceCandidates[].id`, `imageCandidates[].id`: strings opacas `[A-Za-z0-9_-]{1,32}`, únicas no pack.
- `currency`: ISO-4217; `cents`: inteiro >= 0.
- `kind`: `current` | `original` | `installment` | `unknown`.
- `context` é opcional e nunca é usado para gerar valores.

### 5.2 Response

```json
{
  "success": true,
  "data": {
    "packVersion": "1",
    "packHash": "sha256:...",
    "mode": "llm",
    "modelId": "qwen2.5-0.5b-instruct-q4_k_m",
    "modelVersion": "qwen2.5-0.5b-instruct-q4_k_m@2026-10-21",
    "promptVersion": "1",
    "latencyMs": 812,
    "decisions": [
      {
        "cardId": "c_7f3a",
        "isProduct": true,
        "titleId": "t_1",
        "priceId": "p_1",
        "originalPriceId": "p_2",
        "imageId": "i_1",
        "confidence": 0.87
      }
    ],
    "rejected": [{ "cardId": "c_9d21", "reason": "not_a_product" }]
  }
}
```

Regras da response:
- Exatamente uma decisão por `cardId` do request (ou em `decisions`, ou em `rejected`).
- `titleId`, `priceId`, `imageId` DEVEM existir no pack daquele card.
- `priceId` DEVE apontar para candidato `kind=current` e `currency=BRL` quando `isProduct=true`.
- `originalPriceId` é `null` ou aponta para candidato com `cents > price.cents`.
- `confidence` em `[0,1]`.
- Em modo `fallback` (timeout/erro/modelo indisponível), `decisions` volta vazio e `mode="fallback"` com `fallbackReason`.

---

## 6. Gate de completude e descarte

Aplicado **antes** da adjudicação (na API Vupia) e **revalidado** no `ai-extractor-api`.

| Condição | Resultado |
| --- | --- |
| Sem título com >= 8 caracteres | descarte `missingTitle` |
| Sem preço BRL plausível (0 < cents < 100_000_000) | descarte `missingPrice` |
| Sem imagem em host da loja | descarte `missingImage` |
| Link inválido ou fora do domínio | descarte `invalidLink` |
| Card não é produto (banner, avaliação, frete) | descarte `not_a_product` |
| Preço ambíguo (dois `current` incompatíveis) | descarte `ambiguousPrice` |
| Oferta completa mas confiança < limiar | `needsReview` (não descarta) |
| Moeda não-BRL em qualquer candidato de preço | descarta aquele candidato; se sobrar nenhum current BRL, descarta o card |

Contadores obrigatórios no retorno da coleta: `discarded: { missingTitle, missingPrice, missingImage, invalidLink, notAProduct, ambiguousPrice, currency }`.

---

## 7. Integração com a API Vupia

### 7.1 Correções obrigatórias no lado da API (P0 da revisão)

1. **Moeda:** `scrape/index.ts:526` grava `currency: 'BRL'` fixo, mas o extrator aceita `US$`/`$`. Passar a moeda real do candidato e descartar não-BRL na borda.
2. **Candidatos pré-filtro:** `offerExtractor.ts:591-616` (com `limit` em `:592`) descarta cards sem título/imagem+preço antes da adjudicação. O pack deve ser montado com os candidatos **antes** desse descarte; só o resultado final passa pelo gate.
3. **Proveniência:** `RawOffer` precisa carregar `extractionSource`, `confidence`, `needsReview`, `reviewReasons` (aditivos, sem quebrar consumidores).
4. **IDs opacos** em vez de índices posicionais.
5. **`packHash`** calculado no cliente e validado no servidor.
6. **Helper próprio de URL interna** (`assertInternalServiceUrl`), sem reutilizar o validador de URLs públicas.
7. **Kill switch em runtime** (`AI_ADJ_ENABLED` lido a cada request, com invalidação de cache).
8. **Filtro antes da paginação** e dedupe estável.
9. **Latência:** orçamento de 12 s por request; 30 cards x 3,5 s = 105 s se chamado card a card. A chamada é **por lote** (até 30 cards) com `AbortController`.
10. **Contrato `sync`** agora, com `AI_ADJ_EXECUTION=sync|async` reservado.

### 7.2 Pontos de código

- `src/modules/marketplaces/marketplaceService.ts` — único ponto de chamada.
- `src/providers/marketplace/scrape/offerExtractor.ts` — produzir candidatos + proveniência.
- `src/providers/marketplace/scrape/index.ts` — moeda real.
- `src/domain/schemas/tb_products.ts` — campos aditivos `extractionSource`, `needsReview`, `reviewReasons`, `aiModelVersion`.
- `src/modules/autoOffers/*` — intocado no MVP (auto-ofertas desligadas).

---

## 8. Frontend

- Nenhum frontend novo. Usar `../FRONT`.
- `WebScrappingPage.tsx`: `PAGE_SIZE = 30` (`:28`), `loadingRef` (`:109-110`), skeleton (`:251`).
- Badge de revisão no `ProductResultCard` quando `needsReview=true`.
- `EditProductModal` limpa `needsReview` ao salvar.
- `SendProductModal` bloqueia envio quando o motivo é preço/moeda.
- Estado vazio deve distinguir "nenhuma oferta encontrada" de "ofertas descartadas por incompletude", exibindo os contadores.
- Laboratório `/admin/ai-lab` (admin-only) no mesmo codebase, padrão `AdminScrapeRoutesPage`.

---

## 9. Modelo e treino

### 9.1 Modelo do MVP

- Base: `Qwen2.5-0.5B-Instruct`, quantização `Q4_K_M` (GGUF, ~400 MB).
- Execução: CPU, `contextSize` 2048, `temperature` 0, gramática GBNF estática.
- `promptVersion=1`, `modelVersion=<arquivo>@<data>`.

### 9.2 Pipeline de treino (F6, opcional)

- Dataset rotulado a partir de replays `shadow` + correções humanas.
- Split por **domínio/marketplace**, não aleatório (evitar vazamento).
- Métricas: acurácia de escolha por campo, taxa de packs inválidos, latência p95.
- Sem promessa de "98%" sem base amostral; metas definidas após a linha de base.
- Fine-tuning não bloqueia o MVP: o modelo base já entra em `shadow`.

---

## 10. Persistência e observabilidade

Coleções próprias do `ai-extractor-api` (nunca reutilizar `tb_aiUsage` da API):

- `tb_ai_models`: catálogo/versões carregadas.
- `tb_ai_adjudications`: `packHash`, `marketplace`, contagens, `mode`, `modelId`, `modelVersion`, `promptVersion`, `latencyMs`, `validationFailures`, `createdAt`. Sem pack completo por padrão (`AI_STORE_PACKS=false`).
- `tb_ai_usage_daily`: contadores por dia e por marketplace (custo/latência).

Modo `AI_PERSISTENCE=memory` (default em dev/teste) ou `mongo`.

Logs estruturados por request: `requestId`, `packHash`, `mode`, `latencyMs`, `decisions`, `rejected`.

---

## 11. Rollout

| Etapa | Comportamento | Critério de saída |
| --- | --- | --- |
| `off` | IA desligada, determinístico puro | linha de base medida |
| `shadow` | IA roda, decisões são registradas, resultado determinístico prevalece | >= 200 packs, taxa de packs válidos >= 99% |
| `assist` | IA prevalece quando confiança >= limiar e validação passa | ganho >= 5 p.p. na taxa de extração correta, sem regressão de latência p95 |
| `on` | IA prevalece no canário | rollback via kill switch sem deploy |

Kill switch: `AI_ADJ_ENABLED` + `AI_ADJ_MODE` lidos a cada request; mudança invalida cache.

---

## 12. Fases

| Fase | Entrega | Status | Data |
| --- | --- | --- | --- |
| F0 | Plano consolidado, ADR-005, correções do doc original | Concluída | 2026-10-21 |
| F1 | `ai-extractor-api` scaffold + contrato + providers + testes | Em andamento | 2026-10-21 |
| F2 | Integração na API (`AdjudicationClient`, candidatos, moeda) | Pendente | — |
| F3 | Front (badge, bloqueio, estado vazio, contadores) | Pendente | — |
| F4 | Laboratório admin + harness de eval + shadow | Pendente | — |
| F5 | Visão (CLIP/SigLIP) e provider HTTP/GPU | Pendente | — |
| F6 | Dataset + fine-tuning | Pendente | — |
| F7 | Rollout `assist`/`on` | Pendente | — |

---

## 13. Riscos

| Risco | Mitigação |
| --- | --- |
| 0.5B erra escolhas | gramática estática + validação dura + confiança + fallback determinístico |
| Latência estoura | lote único de 30 cards, orçamento 3,5 s/lote, abort → fallback |
| Modelo alucina IDs | IDs opacos validados contra o pack; decisão inválida é descartada |
| Vazamento de dados | pack não é persistido por padrão; logs sem título/preço |
| Regressão na API | IA fora do scraper, kill switch, modo shadow |
| Duplicação de telemetria | coleções próprias, prefixo `tb_ai_` |

---

## 14. Critérios de aceite do MVP

1. `POST /v1/adjudicate` responde em <= 3,5 s (p95) para 30 cards em CPU.
2. 100% das decisões retornadas referenciam IDs existentes no pack.
3. Nenhuma decisão com moeda != BRL ou preço ambíguo é aceita.
4. Falha/timeout do `ai-extractor-api` não altera o status HTTP da coleta (degradação silenciosa).
5. Modo `shadow` não altera nenhum resultado entregue ao front.
6. Testes unitários e de integração verdes; `typecheck` limpo.
7. Nenhum segredo de usuário trafega para o `ai-extractor-api`.

---

## 15. Documentos

- `docs/PLANO_AI_API.md` — plano de implementação do microserviço.
- `docs/ADR-005-extracao-hibrida.md` — decisão arquitetural.
- `01_ARQUITETURA_E_IA.md` — material original (obsoleto; mantido para histórico).
