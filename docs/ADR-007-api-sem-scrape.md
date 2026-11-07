# ADR-007 — API principal nunca busca HTML; todo scrape roda nos workers

**Data:** 2026-11-07
**Status:** Aceito (implementado nas branches `feat/extractor-pool-all-marketplaces` e `feat/ia-cars-validation-integration`)
**Contexto:** `ai-extractor-api` + `../API`
**Relacionado:** ADR-006 (push sync/pull async), `TROUBLESHOOTING_VPS_2026-11-06.md`

## Contexto

Com `AI_EXTRACTOR_MODE=pool`, a busca de Temu passou a devolver `503 'temporariamente indisponível'`.
Causa raiz: a API passava o caminho remoto do pool para **qualquer** marketplace, mas nenhum worker
anunciava `temu` (nem estava no `SCRAPE_MARKETPLACES` do worker) — `No eligible extractor instance`.
O modo pool sequestrava a rota sem checar se o pool atendia aquela plataforma.

Decisão de produto: **nenhuma busca de ofertas é feita pela API principal**. Todo fetch/render/extração
de HTML vive nos workers (contrato v2). Na API ficam só as integrações oficiais por chave/senha,
no modelo da Shopee (Open API de afiliados).

## Decisão

1. **Worker cobre as 19 lojas de scrape**: `SCRAPE_MARKETPLACES` + `SUPPORTED_PLATFORMS` + perfis DOM
   + padrões de ID externo para `temu, tiktokshop, magalu, netshoes, casasbahia, pontofrio,
   americanas, kabum, centauro, renner, riachuelo, dafiti, zattini, boticario`
   (somados aos 5 existentes). Shopee continua listada, mas o worker a filtra sem browser
   (`BROWSER_ONLY_PLATFORMS`) e a API a resolve pela integração oficial — na prática o pool não a usa.
2. **API: allowlist `POOL_REMOTE_MARKETPLACES` (18 = as do worker menos `shopee`)** é a fonte única
   do gate — push sync (`browseOffers`), bulk direto (Etapa E) e fila pull usam o mesmo gate.
   Fora daqui, sem API oficial: `OFFERS_UNAVAILABLE` orientando ao worker (nunca mais 503 mudo).
3. **API oficial primeiro**: `shopee/aliexpress/amazon` com credenciais continuam na API principal
   (chamada leve, autorizada, sem anti-bot). Sem credenciais ou com resposta vazia/filtrada, o
   fallback é o pool (se suportado) ou os itens da própria API — nunca scrape local.
4. **Scrape local deletado da API**: `scrape/{index,browser,profiles,offerExtractor,amazonDealsJson}`,
   helpers `scrapeUnblocker/scrapeCache/imageValidation`, `closeBrowser`, testes dedicados.
   Mantidos (não fazem fetch): `scrapeProxy/scrapeRelay/scrapeEgress` (config + telas admin),
   `scrape-proxy-usage` (histórico), `ogProduct/ogFetch` (enriquecimento de item salvo — ver §5),
   `scrapeSources` (templates de URL, sem rede) e `scrape-routes` (o `probe` agora via worker).
5. **Exceção documentada — enriquecimento og de item salvo**: `fetchProductData`/og de UMA página de
   produto (fluxo de salvar oferta, baixo volume, sem escala de busca) continua na API. Migrar para o
   worker exigiria novo endpoint no contrato — backlog fase 2, se um dia fizer sentido.
6. **Shadow removido do caminho de scrape**: sem fetch local não há HTML para amostrar. O modo
   `shadow` perde sentido para lojas sem API oficial (rollout já concluído em `pool`).

## Consequências

**Positivas**

- Elimina a classe inteira de bugs "pool sequestra rota sem suporte" (Temu, TikTok, Magalu...).
- API principal sem Playwright/Chromium, sem unblocker, sem proxy de coleta no caminho quente.
- Gate único testado (unit + integração com worker emulado).

**Negativas / custos**

- Deploy em ordem obrigatória (ver Rollout): worker antes da API, senão 503 para as lojas novas.
- `Uso do proxy` (admin) mostra só histórico até os workers reportarem uso no heartbeat (backlog).
- Relay residencial sem chamador na API (backlog: descomissionar ou plugar no worker).
- Tuning de extração por loja agora é no worker (perfis iniciais = heurística + âncoras).

## Rollout (ordem obrigatória)

1. Deploy do worker (VPS `api-scrapping.vupia.com.br`): `.env` com   `EXTRACTOR_PLATFORMS=amazon,mercadolivre,aliexpress,shein,temu,tiktokshop,magalu,netshoes,casasbahia,pontofrio,americanas,kabum,centauro,renner,riachuelo,dafiti,zattini,boticario`
   (sem `shopee`: vai pela API oficial). Confirmar no admin: Oracle online com as capabilities.
2. Deploy da API (`AI_EXTRACTOR_MODE=pool`, `AI_EXTRACTOR_BULK_MIN_FLEET=1`;
   bulk pull exige `AI_EXTRACTOR_QUEUE_ENABLED=true`, senão a Etapa E usa o contrato v2 direto).
3. Validar matriz 18 lojas no FRONT (Explorar ofertas) + saúde das rotas no admin (probe via worker).
4. Rollback: `AI_EXTRACTOR_MODE=legacy` (API volta a não coletar scrape — lojas sem API oficial ficam
   indisponíveis até o pool voltar; é o comportamento honesto, sem fallback silencioso).

## Alternativas descartadas

- **Manter scrape local como fallback**: reintroduz Chromium/unblocker/proxy na API e o acoplamento
  que causou o incidente da Temu; fallback silencioso esconde falha do worker.
- **Mover a chamada oficial (Shopee/Ali/Amazon) para o worker**: zero ganho de cota (a cota é do
  `appId`, não do IP) por custo de latência e complexidade — ver análise em conversa de 2026-11-07.
- **Cache compartilhado para scrape**: sem identidade de app como nas APIs oficiais; cada HTML é
  por sessão/URL — single-flight + cache por usuário continuam valendo no pool.

## Validação com buscas reais (2026-11-07)

Pipeline real do worker (unblocker Decodo + extração) contra as páginas das lojas:

| Loja | Resultado | Observação |
| --- | --- | --- |
| Magalu | 50/50 ao vivo | parsing por `data-testid` |
| Shein | 20/20 (dump) | JSON-LD `ItemList/itemListElement` + âncora `-p-` |
| Renner | 48/48 | extração direta |
| AliExpress | 60/60 | controle (já funcionava) |
| Kabum | 10/10 via JSON-LD | permalink vinha só em `offers.url` |
| Netshoes | 30/30 | exige `device_type: mobile_android` (desktop dá 403 mesmo com proxy) |
| Temu | 0 (shell JS) | testados `wait`, `scroll_to_bottom`, `fetch_resource`: sem produtos no HTML |
| Americanas | 0 (shell JS) | `wait`/`scroll_to_bottom` não hidratam |
| Casas Bahia | 0 (shell JS) | desktop, mobile e geo BR testados |
| TikTok | template `shop.tiktok.com/search` 404 | URL atual: `shop.tiktok.com/br?q=` (path com região); conteúdo é shell JS; template `tiktok_shop_search` da Decodo responde `failed 613` (restrição de plano) |

Conclusões: (1) `browser_actions` (`wait`/`scroll`/`fetch_resource`) da Decodo **não** hidratam os
shells testados — shell JS só sai com navegador de verdade (Etapa E do worker). (2) Proxy próprio
**não** resolve Netshoes (403 com e sem proxy, desktop e mobile) — só o unblocker mobile. (3) TikTok
depende de URL válida (tarefa do produto) + render ou template liberado.
