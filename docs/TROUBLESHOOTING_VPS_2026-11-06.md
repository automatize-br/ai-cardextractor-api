# Troubleshooting — onboarding da VPS no pool de extração (2026-11-06)

Registro dos problemas encontrados ao subir a **primeira VPS de serviço** (`api-scrapping.vupia.com.br`)
no ambiente de **dev**, com as causas e as correções aplicadas. Serve de checklist para as próximas
instâncias e para a virada para **prod**.

## Ambiente do teste

| Item | Valor |
| --- | --- |
| VPS | `api-scrapping.vupia.com.br` (`163.176.30.113`) |
| Processo | pm2 `vupia-api-ai-scrapping` → `127.0.0.1:5555` atrás de nginx |
| `workerId` VPS | `0c53f16b-fa3b-4d14-8b26-49e6474eb30b` |
| Serviço no admin | `serviceId=cb6722d1-0536-4c55-9961-57371247fca2` |
| Worker local | `workerId=c932af8c-4de4-475d-a8a2-981591d4bde9` (`localhost:5555`) |
| Mongo | `automatize_dev` (mesmo cluster da API dev) |
| API central | `http://127.0.0.1:2222` (HUB de dev) |

## 1. Problemas encontrados

### 1.1 nginx responde 502 em todas as rotas

**Sintoma:** `GET https://api-scrapping.vupia.com.br/api/v1/health` → `502 Bad Gateway` (nginx/1.24.0),
inclusive `/`. TLS válido (`CN=api-scrapping.vupia.com.br`).

**Causa:** nginx no ar, mas o processo Node atrás dele estava morto (crash no boot).

**Solução:** subir/corrigir o processo. O `pm2 list` deve mostrar **um único** app de extractor online.

---

### 1.2 Boot falhando: Atlas recusa a conexão

**Sintoma (log):**

```
[Server] Falha ao inicializar: Could not connect to any servers in your MongoDB Atlas cluster.
One common reason is that you're trying to access the database from an IP that isn't whitelisted.
```

**Causa:** IP público da VPS (`163.176.30.113`) fora do allowlist do Atlas.

**Solução:** liberar o IP no Atlas (Network Access). O IP é fixo da VPS — liberar **/32**, não `0.0.0.0/0`.

---

### 1.3 `Cannot use a session that has ended`

**Sintoma (log):** `[state] falha ao publicar estado: Cannot use a session that has ended`

**Causa:** o processo subiu com o Atlas bloqueado e ficou com um handle de conexão cuja sessão
implícita já foi encerrada. O `/api/v1/health` continua respondendo (não toca no Mongo), mas as
escritas de estado falham silenciosamente.

**Solução:** **reiniciar o processo depois** de liberar o IP. Confirmar `[mongo] connected` no log e
a ausência de `[state] falha`. Não é dado corrompido.

---

### 1.4 Colisão de heartbeat: VPS sobrescrevendo a linha da local ⚠️

**Sintoma:** a VPS não aparecia no admin. No Mongo, a linha da local (`dns=localhost:5555`) passou a
ter o **`workerId` da VPS** (`0c53f16b…`), e as duas máquinas alternavam a mesma linha ("flapping").

**Causa:** a VPS subiu com `EXTRACTOR_DNS=localhost:5555` (copiado do `.env` local). O upsert de
estado usa a identidade:

```ts
const identity = { $or: [{ workerId }, { dns }] }
```

Como o `dns` era igual ao da local, a VPS **casou a linha existente pelo DNS** e sobrescreveu o
`workerId` — em vez de criar a linha dela.

**Solução:**

```bash
EXTRACTOR_DNS=api-scrapping.vupia.com.br
```

Regras do valor:

- sem esquema (`https://`), sem caminho e sem barra final;
- **idêntico** à URL cadastrada em `tb_aiextractorservices` (o allowlist compara com `normalizeDns`);
- `workerId` é a identidade estável (arquivo); `dns`/`host` são metadados.

Depois do restart, o esperado são **duas linhas** em `tb_aiextractorinstances`:

```
online | api-scrapping.vupia.com.br | contract=2 | workerId=0c53f16b…
online | localhost:5555              | contract=2 | workerId=c932af8c…
```

> Durante a janela de colisão o admin pode mostrar uma instância só ou oscilar. É efeito da colisão,
> não do scheduler.

---

### 1.5 `[jobs] API central indisponível (healthcheck); aguardando`

**Sintoma (log):** o poller bulk fica idle repetindo essa mensagem.

**Causa:** o preflight do worker (`GET {EXTRACTOR_CONTROL_URL}/api/v1/health`, timeout 2 s, cache 10 s)
falhou. Dois erros encadeados:

1. `EXTRACTOR_CONTROL_URL` estava com o sufixo de rota:
   `https://api.vupia.com.br/api/v1` → o código concatena de novo e chama
   `https://api.vupia.com.br/api/v1/api/v1/health` → **404**.
2. O control URL apontava para a API de **prod**, enquanto o estado vai para o Mongo de **dev**.

**Solução:**

```bash
EXTRACTOR_CONTROL_URL=https://api.vupia.com.br   # BASE, sem /api/v1
```

O código acrescenta `/api/v1/health` e `/api/v1/internal/ai-extractors` — **nunca** inclua a rota na
variável.

**Importante (independência do serviço):** esse preflight existe **apenas** no `jobPoller`
(caminho da fila bulk). `GET /api/v1/health`, `POST /api/v1/extract-offers` e `POST /api/v1/extract`
**não** dependem da API central. Com `EXTRACTOR_JOBS_ENABLED=false`, o serviço roda 100% standalone.

---

### 1.6 Worker de dev consumindo fila de prod (risco de ambiente cruzado)

**Sintoma:** `[jobs] poller ativo` na VPS apontando para `https://api.vupia.com.br` (prod), enquanto o
heartbeat da instância vive no `automatize_dev`.

**Causa:** `EXTRACTOR_JOBS_ENABLED=true` + control URL de prod. Se o código do pool já estiver
deployado em prod, essa VPS vira um worker "fantasma": consome jobs de prod, mas **não aparece no pool
de prod** (o estado está no dev), furando a contabilidade de capacidade/reserva.

**Solução (até o deploy validado):**

```bash
EXTRACTOR_JOBS_ENABLED=false
```

Quando o pool for promovido a prod: control URL de prod + `MONGODB_URI`/`MONGO_ENVIRONMENT` de prod +
cadastro do serviço no banco de prod.

---

### 1.7 Unblocker HTTP 429 compartilhado (limite externo)

**Sintoma:** buscas retornam 503 / 0 itens; no log:

```
[scrape] unblocker HTTP 429
```

**Causa:** a chave/limite do provedor de unblocker é **compartilhada** entre local e VPS. Não é
regressão da VPS nem da autenticação/contrato.

**Comportamento observado (idêntico nas duas instâncias):**

| Plataforma | Resultado | Detalhe |
| --- | --- | --- |
| AliExpress | **200 · 60 ofertas** | fetch direto funciona mesmo com 429 |
| Mercado Livre | 503 | 429 → fetch direto bloqueado |
| Amazon | 200 · 0 itens (`no_cards`) | fetch direto devolve página anti-bot (~2,3 KB) |
| Shein | 200 · 0 itens (`no_cards`) | página buscada, 0 cards |

**Soluções:** chave/limite por instância ou plano maior no provedor; para Amazon/Shein, evoluir o
perfil de render/extração (página sem JS útil). **Não** é problema de DNS, contrato ou auth.

---

### 1.8 `SCRAPE_DEBUG_DUMP=true` enchendo disco

**Sintoma:** `tmp/scrape/*.html` crescendo (~900 KB por página).

**Causa:** dump de depuração ligado no `.env` do VPS.

**Solução:** `SCRAPE_DEBUG_DUMP=false` em serviço (ou TTL/limpeza no diretório).

---

### 1.9 Credenciais expostas em print

**Sintoma:** `MONGO_PASSWORD` e `JWT_KEY` apareceram em texto puro em um screenshot de terminal.

**Solução:** rotacionar os dois. Trocar a senha no Atlas e no `.env` da API e do extractor; trocar o
`JWT_KEY` invalida os access tokens ativos (esperado). Nunca colar `.env` completo em chat/print.

---

## 2. Checklist de onboarding de uma nova instância

```bash
# 1) identidade única (obrigatório)
EXTRACTOR_DNS=<host-ou-host:porta cadastrado no admin>
EXTRACTOR_STATE_MODE=mongo
MONGO_ENVIRONMENT=automatize_dev          # ou MONGO_URI do banco alvo
EXTRACTOR_CONTROL_URL=<base da API do MESMO ambiente>   # sem /api/v1
EXTRACTOR_JOBS_ENABLED=false              # enquanto a API do ambiente não tiver o pool

# 2) auth compartilhada
AI_INTERNAL_KEY=<mesma chave da API do ambiente>

# 3) operação
SCRAPE_DEBUG_DUMP=false
```

Conferência:

```bash
pm2 env 0 | grep -E "^EXTRACTOR_(DNS|CONTROL_URL|JOBS_ENABLED)="
pm2 logs <app> --lines 20 --nostream
```

Esperado: `[mongo] connected`, `[state] publicando … workerId=<id>`, sem `[state] falha`, sem
`API central indisponível` (quando o control URL é do mesmo ambiente).

> `pm2 restart` pode reaproveitar env antigo com dotenvx. Se a variável não mudar:
> `pm2 delete 0 && pm2 start npm --name <app> -- run start`.

---

## 3. Validação executada

### 3.1 Forçado pelo HUB (local desabilitada → só VPS elegível)

| Item | Resultado |
| --- | --- |
| Busca | `aliexpress` · `"capa celular transparente"` · `limit=8` |
| Resposta do HUB | **200 · 8 itens · 3,56 s** |
| Extração na VPS | **60 ofertas · `quality=ok` · 2.743 ms** (`requestId=pool_1794001243936_bs68mq`) |
| Log da local | **0 requisições** (29 → 29 linhas) |
| Fallback legado | impossível: em `AI_EXTRACTOR_MODE=pool` o `fetchOffersRemote` desliga o cache de página e, em falha do pool, lança `ScrapeBlockedError` |

### 3.2 Matriz VPS × local (cada instância isolada)

| Plataforma | VPS | Local |
| --- | --- | --- |
| AliExpress | 200 · 60 ofertas | 200 · 60 ofertas |
| Mercado Livre | 503 (~1,7 s) | 503 (~2,2 s) |
| Amazon | 200 · 0 itens | 200 · 0 itens |
| Shein | 200 · 0 itens | 200 · 0 itens |

**Conclusão:** a VPS está em **paridade com a local**. As falhas são o unblocker 429 (externo) e
limitações de extração de Amazon/Shein — nenhuma causa é a VPS.

---

## 4. Comandos úteis

```bash
# saúde da instância
curl -sS "$EXTRACTOR_CONTROL_URL/api/v1/health"

# estado publicado (no banco do ambiente)
db.tb_aiextractorinstances.find({}, { workerId:1, dns:1, observedStatus:1, lastHeartbeatAt:1 })

# serviços cadastrados (admin)
GET /api/v1/admin/ai-extractor/services
GET /api/v1/admin/ai-extractor/instances
```

## 5. Referências

- `docs/VALIDACAO_2026-11-05.md` — validação local ponta a ponta.
- `docs/ENTREGA_POOL_EXTRACAO.md` — escopo e variáveis.
- `docs/ADR-006-hub-push-sync-fila-pull-async.md` — arquitetura híbrida.
- API: `docs/CONFIG_IA_EXTRACTOR.md` e `docs/CHECKLIST_ROLLOUT.md`.
