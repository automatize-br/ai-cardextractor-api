# ADR-006 — HUB/SWITCH no caminho síncrono + fila pull no assíncrono

**Data:** 2026-11-04
**Status:** Proposto — revisado após 8 rodadas (v5.0.1); aguarda confirmação final de produto registrada em
`PLANO_POOL_EXTRACAO_DISTRIBUIDA.md` §16.16
**Contexto:** `ai-extractor-api` + `../API`
**Relacionado:** `docs/PLAN2/vupia-plano-workers-distribuidos.md`, `docs/PLAN2/DIAGRAMA.png`,
`docs/PLANO_POOL_EXTRACAO_DISTRIBUIDA.md` §16, `docs/ADR-005-extracao-hibrida.md`

## Contexto

O PLAN2 recomenda avaliar o modelo **pull**: a API grava jobs e workers assumem trabalhos quando têm
capacidade. O diagrama que acompanha o PLAN2 desenha outro fluxo: a API tem um **HUB/SWITCH** que
“identifica o servidor de serviço menos ocupado e direciona a chamada para este servidor”, com
`API-SERVIÇO(0..n)` executando busca/scraping.

O código atual já implementa o desenho do diagrama para a busca do FRONT: `tb_aiExtractorInstances`
(CPU/in-flight/capacidade/saturação), score `0.6*CPU + 0.4*ocupação`, reserva atômica por slot e
contrato v2 `POST /api/v1/extract-offers` (o extractor busca e extrai; a API não renderiza).

O que falta é coordenação durável para o fluxo **bulk**: hoje ele espera até 15 s por capacidade e cai
no legado (que renderiza Chromium na API). Sem fila não há lease, tentativas, dead-letter nem
recuperação de worker morto.

**Restrição de escopo (2026-11-04):** nada muda no FRONT. Toda mudança fica na fronteira **API ↔
extractors**; o contrato público `MarketplaceProductSearchResult[]`, headers e códigos já existentes
são preservados.

## Decisão

Arquitetura **híbrida**:

1. **Síncrono (busca do usuário): push.** O HUB/SWITCH escolhe a instância menos ocupada e chama
   `extract-offers` com **um deadline absoluto por busca** (default 45 s), `signal` propagado e as N
   URLs em uma única chamada. A espera por capacidade é de até 10 s (`≤ deadline−15 s`); esgotada, a resposta é **503 + `Retry-After`** (429 é interno —
   o cliente tenta outra instância) — nunca 200 vazio. Justificativa: não adicionar fila ao caminho interativo nem
   duplicar a seleção que já funciona; atende ao diagrama.
2. **Assíncrono (Ofertas Automáticas, bulk): pull.** API grava `tb_aiExtractorJobs` em lote (`categories[]`, `participants[]`); leitura autorizada por participante, fan-out por owner (quota debitada no consumo, filtros/afiliação por owner); o worker faz claim
   atômico com filtro completo (`status`, `nextAttemptAt`, `attempts < maxAttempts`, contrato,
   plataforma), renova `lockedUntil` a cada 20 s e só conclui/falha por **CAS** em
   `{jobId, workerId, leaseToken}`. Job de worker morto volta a ser elegível quando o lease expira;
   `claims`/`attempts` (3) com backoff e dead-letter; falha transitória volta a `pending` limpando posse e `deadlineAt`.
3. **Ledger único de capacidade por `workerId`:** `max(reservedSlots, inflightSlots) ≤ capacity`,
   com reserva **única** `(workerId, slot)` (a reserva é o slot). O claim do job **adquire** a reserva no
   mesmo ledger do push; a reserva é liberada no terminal ou no ACK, e o TTL é só rede de segurança. `capacity` é clampada no servidor (default 1, máximo 2 com benchmark).
4. **Resultado é artefato; HTML não sai do worker.** O extractor busca (unblocker/proxy/HTTP), recorta,
   extrai e revalida; devolve `RawOffer[]`. O resultado do bulk é persistido em
   `tb_aiExtractionResults` (chave `{jobId, claim}`, TTL 6 h); leitura por `resultRef.claim`; `resultRef`
   guarda só metadados; `completed` sem resultado é detectado pelo sweeper e re-coletado (`:r{n}`). HTML é descartado após a
   extração — não há endpoint de leitura de arquivo (PLAN2 §8.2 não é adotado).
5. **O worker não renderiza hoje.** `WORKER_BROWSER_ENABLED=false` por default; plataformas JS-only
   (ex.: Shopee) só entram na capability após a Etapa E decidir entre embarcar Playwright no worker
   (com benchmark próprio) ou mantê-las no legado. O ADR **não** afirma “API sem Chromium” antes disso.
6. **Identidade separada de host.** `workerId` é UUID persistido em arquivo
   (`EXTRACTOR_WORKER_ID_FILE`), não em env; `dns`/`host` são metadados; `bootId` é do processo.
7. **Status tem dono.** `desiredStatus` é escrito por admin/reaper; `lastHeartbeatAt`/`activeJobs` pelo
   worker. Snapshot nunca ressuscita `draining`; reaper marca `offline` após 60 s.
8. **Dois relógios.** Heartbeat de liveness/lease a cada 20 s (update parcial); snapshot de métricas a
   cada 180 s; seleção exige heartbeat ≤60 s.

## Consequências

**Positivas**

- Preserva o caminho síncrono validado (Mercado Livre e AliExpress) e o contrato do FRONT.
- Torna o bulk recuperável e observável, sem Redis/RabbitMQ/K8s.
- Elimina a necessidade de servir HTML a partir de outro worker (menos superfície de segurança).
- Deixa explícito o que o worker **não** faz hoje (render), evitando promessa falsa de “API sem Chromium”.

**Negativas / custos**

- Duas mecânicas de coordenação (reserva/ledger + lease de job) para manter e testar.
- `workerId` exige migração em duas fases (`workerId=dns` → UUID em arquivo) e convivência durante o rollout.
- Polling do worker adiciona leitura no Mongo; mitigado por `limit = slots livres`, backoff e
  bulk apenas com `fleetHealthy ≥ 2` e worker ocioso.
- O FRONT continua limitado por deadline (45 s) e pode receber 503; a experiência de falha é
  responsabilidade do FRONT e **não** é alterada neste ciclo.

## Alternativas descartadas

- **Tudo pull:** piora a latência do interativo e duplica a seleção; contraria o diagrama.
- **Tudo push (sem fila):** não recupera job de worker morto nem limita tentativas (estado da v3.1.0).
- **Redis/BullMQ:** infra nova sem necessidade demonstrada; Mongo resolve claim/lease/TTL/sweeper.
- **API buscar HTML no worker proprietário (PLAN2 §8.2/alternativa A):** desnecessário no contrato v2 —
  não há consumidor de HTML depois da extração.
- **TTL index no job:** trocado por sweeper explícito para não arriscar apagar job ativo.
