# Plano de Integração — IA de Extração de Ofertas

**Versão:** 1.0.18
**Criado em:** 2026-10-21
**Última atualização:** 2026-10-21
**Status:** Concluído (F1–F7)
**Substitui:** `01_ARQUITETURA_E_IA.md` (documento original com 4 documentos empacotados e erros técnicos)
**ADRs relacionados:** `docs/ADR-005-extracao-hibrida.md`, `../../API/docs/adr/004-deterministic-scraping.md`
**Evolução:** `docs/PLANO_EXTRACAO_UNIVERSAL.md` (v2.1.1) define a substituição do adjudicador hardcoded por perfis declarativos no `.env`, catálogo de modelos e extração universal.

---

## Histórico de alterações

| Data | Versão | Alteração |
| --- | --- | --- |
| 2026-10-26 | 1.0.18 | Evolução v2 em `docs/PLANO_EXTRACAO_UNIVERSAL.md`: perfis no `.env`, catálogo de modelos, `/v1/execute` e cache; `/v1/adjudicate` preservado como adaptador. |
| 2026-10-21 | 1.0.0 | Criação do plano consolidado. Consolida as decisões das duas rodadas de revisão adversarial (backend e produto), corrige os erros técnicos do documento original e define o escopo do MVP. |
| 2026-10-21 | 1.0.1 | Registrada a criação do microserviço `ai-extractor-api` (F0/F1) e o contrato de adjudicação implementado. |
| 2026-10-21 | 1.0.2 | Repositório renomeado para `ai-extractor-api`; planos e ADR movidos para `ai-extractor-api/docs/`. Referências de caminho atualizadas. |
| 2026-10-21 | 1.0.3 | Porta padrão do serviço definida em 5555 para não bloquear a operação local. |
| 2026-10-22 | 1.0.17 | Relevância textual na busca: quando há termo (`q`), a API descarta cards cujo título não corresponde ao termo (tokens normalizados + sinônimos: gpu/gráfica/geforce/radeon/rtx/gtx). Evita “placa de vídeo” trazer placa de vidro/acrílico; contador `discarded.irrelevant` (on/off por `SEARCH_RELEVANCE`). |
| 2026-10-22 | 1.0.16 | Cobertura shadow passou a ser medida por **card pendente** (título ambíguo), não por pack; sem cards pendentes o gate é vacuamente satisfeito. Achado no teste real: 18 cards ambíguos estouram o orçamento de 12s em CPU; com 30s o assist conclui em 17,6s. |
| 2026-10-21 | 1.0.15 | F7: kill switch em runtime no painel (`PUT /admin/ai-extractor/mode`, override em memória com auditoria; `env` limpa), seletor de modo e alerta de divergência entre serviço/API no IA Lab, e `npm run rollout:report` (gates de 200 packs, 99% válidos, 99% cobertura shadow e p95 opcional) sobre os replays. |
| 2026-10-21 | 1.0.14 | F6: replay opt-in (`AI_REPLAY_PATH`) → dataset builder (`npm run dataset:build`, splits por domínio, `test.eval.jsonl`) → `training/train_qlora.py` (LoRA; engine `hf` p/ Windows/CPU e `sft` p/ Linux/GPU) → GGUF no llama.cpp. Cross-platform: scripts compatíveis com Windows e Ubuntu/WSL2; `.gitattributes` força LF em scripts/datasets. |
| 2026-10-21 | 1.0.13 | F5: visão opcional (CLIP/SigLIP via HTTP, `off` por padrão) que reordena apenas as imagens já extraídas antes da heurística, com timeout/best-effort e kill switch por request; `httpProvider` (GPU/remota) usa o id do catálogo quando `LLM_HTTP_MODEL` está vazio. 14 testes novos. |
| 2026-10-21 | 1.0.12 | F4: harness de avaliação OFFLINE no `ai-extractor-api` (`npm run eval:adjudication`, dataset JSONL, acurácia por campo, casos inválidos e latência p95) e laboratório `/admin/ia-lab` (admin-only) na API/FRONT: status/ready/modelos/stats, load/unload do modelo e execução de pack de teste via proxy interno. 5 testes novos do proxy. |
| 2026-10-21 | 1.0.11 | F3: badge "Revisar" no card com tooltip dos motivos, proveniência enviada ao salvar, bloqueio de envio quando o motivo é preço/moeda, limpeza de `needsReview` ao editar e estado vazio com contadores de descarte. API passou a devolver `discarded` no envelope de `/platforms/:marketplace/offers` (contadores do scraper agregados por fonte). |
| 2026-10-21 | 1.0.10 | F2b: pack com múltiplos candidatos (títulos/preços/imagens) e IDs opacos únicos; moeda real por candidato com descarte não-BRL na borda do scraper; escolha do modelo revalidada contra o pack e aplicada só acima de `AI_MIN_CONFIDENCE`; campos `extractionSource/needsReview/reviewReasons/aiModelVersion` em `tb_products` (schema, tipos e controller). 5 testes novos. |
| 2026-10-21 | 1.0.9 | Cliente: circuit breaker (3 falhas de transporte → 60s sem chamadas), timeout alinhado ao servidor (15s > 12s), sanitização do pack (título 300, breadcrumb 200, host 255, cents inteiro, imagem http(s) ≤2000). Smoke real: 4 cards, 1 chamada, 1.76s, `c3` decidido pelo modelo (`source=model`). |
| 2026-10-21 | 1.0.8 | Cliente endurecido após 3ª revisão: packs fatiados (`AI_PACK_MAX_CARDS=30`), resposta malformada é fail-open, motivos objetivos de `rejected` descartam (invalid_model_output vai para revisão), `shadow` retorna os itens intocados, proveniência só marca `ai` quando `source=model`, moeda nula não vira BRL, pack adjudicado antes da paginação. 11 testes do cliente; API 1069 verdes. |
| 2026-10-21 | 1.0.7 | F2 iniciada na API: `src/helpers/aiExtractorClient.ts` (`adjudicateOffers`, fail-open, timeout, `AI_*`), exits de `browseOffers` integrados, campos `extractionSource/needsReview/reviewReasons/aiModelVersion` no tipo de resultado e 6 testes do cliente. Falta: moeda real, candidatos múltiplos (F2b) e campos em `tb_products`. |
| 2026-10-21 | 1.0.6 | Segunda rodada de revisão: abstenção do modelo não descarta oferta (`isProduct=null`); shadow persiste a escolha do modelo em `shadow`; `/health` reporta modo vivo; fallbackReason sanitizado; fila com limite; unload drena antes de remover do registry. 28 testes. |
| 2026-10-21 | 1.0.5 | Contrato ajustado após revisão: `mode` ganha `heuristic`; fallback preserva decisões; decisão ganha `needsReview`/`reviewReasons`; `model_fallback` significa "usar determinístico local", não descarte; kill switch `AI_ADJ_MODE` por request. |
| 2026-10-21 | 1.0.4 | Adjudicação híbrida validada no modelo real: heurísticas resolvem cards objetivos e o 0.5B só decide título ambíguo (lotes de 2, letras A-L). `LLM_TIMEOUT_MS`=120000. Smoke: 4 cards, 1 chamada, 2.2s. |

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
        |       POST http://127.0.0.1:5555/v1/adjudicate
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
  "packHash": null,
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
    "packHash": "<64 hex>",
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
        "confidence": 0.87,
        "needsReview": false,
        "reviewReasons": []
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
- `mode`: `llm` (modelo chamado), `heuristic` (100% regras), `fake` (teste) ou `fallback` (provider falhou).
- Em `fallback`, decisões determinísticas são preservadas; `rejected[].reason="model_fallback"` significa "card pendente sem modelo" e NÃO deve ser tratado como descarte pelo cliente (usar extração determinística local).
- `needsReview=true` quando `confidence < AI_MIN_CONFIDENCE`; o cliente deve sinalizar revisão, não descartar.
- `model_fallback` aparece em `reviewReasons`, NÃO em `rejected[].reason`. Abstenção do modelo (`p=1` com título inválido) NÃO vira descarte.
- `mode=heuristic` também é usado em `shadow` (decisão determinística; escolha do modelo fica registrada em `shadow` na auditoria).
- `packHash` é obrigatório no request (`null` = servidor calcula).

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
| Título sem relação com o termo buscado (`q`) | descarte `irrelevant` (gate determinístico; `SEARCH_RELEVANCE=off` desliga) |
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

Operação:
- `npm run rollout:report -- --in data/replays.jsonl` valida os gates do `shadow` (200 packs, 99% válidos, 99% dos cards pendentes com escolha shadow; `--max-p95` opcional). Exit 1 quando falha.
- Kill switch da API: `PUT /admin/ai-extractor/mode` (`off|shadow|assist|on|env`) grava override **em memória** (auditado) e vale por request; `env` volta ao `AI_ADJ_MODE` do processo. Reinício limpa o override.
- O modo do **serviço** (`ai-extractor-api`) continua no `.env` (`AI_ADJ_MODE`); o IA Lab mostra ambos e alerta quando divergem. Promova `assist` só após o relatório de shadow e o eval sem regressão de p95.

---

## 12. Fases

| Fase | Entrega | Status | Data |
| --- | --- | --- | --- |
| F0 | Plano consolidado, ADR-005, correções do doc original | Concluída | 2026-10-21 |
| F1 | `ai-extractor-api` scaffold + contrato + providers + testes | Concluída | 2026-10-21 |
| F2 | Integração na API (`AdjudicationClient`, candidatos, moeda) | Concluída | 2026-10-21 |
| F3 | Front (badge, bloqueio, estado vazio, contadores) | Concluída | 2026-10-21 |
| F4 | Laboratório admin + harness de eval + shadow | Concluída | 2026-10-21 |
| F5 | Visão (CLIP/SigLIP) e provider HTTP/GPU | Concluída | 2026-10-21 |
| F6 | Dataset + fine-tuning | Concluída (pipeline) | 2026-10-21 |
| F7 | Rollout `assist`/`on` | Concluída (ferramentas) | 2026-10-21 |

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
