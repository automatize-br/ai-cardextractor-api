# ADR-005 — Extração híbrida: determinístico + IA adjudicadora

**Data:** 2026-10-21
**Status:** Aceito
**Contexto:** API Vupia (`../../API`), extração de ofertas por scraping/API
**Relacionado:** `../../API/docs/adr/004-deterministic-scraping.md` (parcialmente superseded)

**Revisões:** 2026-10-21 — repositório do serviço renomeado para `ai-extractor-api`; ADR movida para `ai-extractor-api/docs/`.
**Revisões:** 2026-10-21 — pós-revisão adversarial: fallback preserva decisões heurísticas; kill switch por request; fila single-flight no provider; `needsReview` explícito.
**Revisões:** 2026-10-21 — adjudicação híbrida na prática: heurísticas resolvem preço/imagem/original e o modelo 0.5B decide apenas título ambíguo, em lotes de 2, respondendo letras (A-L).

---

## Contexto

O ADR-004 estabeleceu que a extração de ofertas é **determinística** e que a IA não participa da coleta. A regra protegeu a API contra custo, latência e alucinação, mas criou um teto de qualidade: seletores e heurísticas empatam em páginas com múltiplos preços, títulos truncados, banners promocionais e variantes.

O documento original `01_ARQUITETURA_E_IA.md` propunha o oposto: um modelo generativo que produz a oferta. Essa abordagem foi rejeitada porque:

1. Viola o ADR-004 de forma ampla, sem limite de dano.
2. Permite que o modelo invente título, preço, imagem e link.
3. Torna a auditoria e o rollback impossíveis na prática.
4. Assume fine-tuning com dataset inexistente como pré-requisito.

## Decisão

Adotar extração **híbrida**, com a IA atuando exclusivamente como **adjudicadora** de candidatos:

- O extrator determinístico continua sendo a única fonte de valores.
- A IA recebe um *pack* fechado de candidatos com IDs opacos e devolve apenas **quais IDs escolher**, além de `isProduct` e `confidence`.
- Toda decisão é revalidada no servidor: IDs precisam existir, preço precisa ser BRL e não ambíguo, `originalPrice` precisa ser maior que o preço atual.
- Qualquer falha (timeout, modelo indisponível, resposta inválida) degrada para o resultado determinístico, sem erro para o usuário.
- A IA roda em microserviço separado (`ai-extractor-api`), com provider plugável e kill switch em runtime.
- O modo inicial é `off`; a entrada em produção passa por `shadow` e `assist`.

### Limites explícitos

- A IA **não** gera valores, links, imagens ou descrições.
- A IA **não** é chamada dentro do `MarketplaceScraper` nem no fluxo de Ofertas Automáticas (MVP).
- A IA **não** usa credenciais ou quota de usuário.
- Nenhum resultado da IA é aceito sem validação contra o pack.

## Consequências

### Positivas

- Mantém os invariantes do ADR-004 (fonte determinística, auditabilidade, custo controlado).
- Ganho mensurável de qualidade sem reescrever o scraper.
- Rollback trivial (kill switch) e experimento seguro (`shadow`).
- Contrato estável permite trocar CPU por GPU/remoto sem tocar na API.

### Negativas / custos

- Duas fontes de resultado exigem um gate de validação e testes de contrato.
- Adiciona um processo (memória/CPU) e um hop de rede interno.
- 0.5B em CPU impõe orçamento de latência apertado (lote, não card a card).
- O ganho real depende de dados de avaliação; sem `shadow` não há como provar.

## Alternativas consideradas

1. **Modelo generativo (proposta original):** rejeitado por alucinação e falta de auditoria.
2. **Só determinístico (ADR-004 puro):** mantido como fallback e modo `off`, mas não resolve empates.
3. **LLM remoto (API paga):** rejeitado no MVP por custo por oferta e por acoplar disponibilidade externa ao fluxo do usuário; o provider `http` fica disponível.
4. **Modelo de classificação/ranking dedicado:** promissor, porém exige dataset; fica como evolução após a linha de base.

## Status do ADR-004

O ADR-004 permanece válido no essencial (determinístico é a fonte e o fallback), mas fica **parcialmente superseded** no ponto que proíbe qualquer participação de IA na extração. A alteração é restrita à adjudicação de candidatos, sob as condições acima. O ADR-004 não é editado neste momento; esta ADR é a referência para a exceção.
