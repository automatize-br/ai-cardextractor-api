import { randomUUID } from 'node:crypto'
import { env, getAdjMode } from '../../config/env.ts'
import { PROMPT_VERSION } from '../../enums/adjudication.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import { getProvider } from '../../providers/llm/index.ts'
import { RESPONSE_GRAMMAR } from '../../providers/llm/grammar.ts'
import { buildUserPrompt, SYSTEM_PROMPT } from '../../providers/llm/prompt.ts'
import type {
  AdjudicationDecision,
  AdjudicationMode,
  AdjudicationPack,
  AdjudicationResult,
  AdjudicationStats,
  ReviewReason,
} from '../../types/adjudication.ts'
import AdjudicationRepository from './adjudicationRepository.ts'
import {
  adjudicateDeterministically,
  longestTitleId,
  type PendingCard,
} from './adjudicationHeuristics.ts'
import { assertPackHash, parseTitleDecisions, validatePack } from './adjudicationValidators.ts'
import { rankImageCandidates } from './visionRanking.ts'
import { getVisionProvider } from '../../providers/vision/index.ts'
import { captureReplay } from '../../helpers/replayCapture.ts'

// ============================================================================
// Adjudicacao HIBRIDA:
//   1. regras deterministicas resolvem preco/imagem/original/titulo unico;
//   2. o modelo e chamado SO para cards com mais de um titulo plausivel;
//   3. se o modelo falhar, as decisoes ja resolvidas SAO PRESERVADAS e apenas
//      os cards pendentes caem para heuristica (mode=fallback);
//   4. `AI_ADJ_MODE` e lido a CADA request: off | shadow | assist | on.
// ============================================================================

const MODES_WITH_MODEL = new Set(['shadow', 'assist', 'on'])

function uniqueReasons(reasons: ReviewReason[]): ReviewReason[] {
  return [...new Set(reasons)]
}

export default class AdjudicationService {
  static async adjudicate(
    raw: unknown,
    options: { signal?: AbortSignal | null } = {},
  ): Promise<AdjudicationResult> {
    const started = Date.now()
    const pack = validatePack(raw)
    const packHash = assertPackHash(pack)

    // VISÃO (F5, opcional): reordena as imagens JÁ extraídas pelo score CLIP/
    // SigLIP antes da heurística. Falha do provider mantém a ordem original.
    const vision = getVisionProvider()
    if (vision) {
      await rankImageCandidates(pack.cards, vision, {
        minScore: env.VISION_MIN_SCORE,
        timeoutMs: env.VISION_TIMEOUT_MS,
        signal: options.signal ?? null,
      }).catch(() => 0)
    }

    const provider = getProvider(null)
    const adjMode = getAdjMode()

    const heuristic = adjudicateDeterministically(pack.cards)
    const decisions: AdjudicationDecision[] = [...heuristic.decisions]
    const rejected = [...heuristic.rejected]
    const resolved = new Set<string>()

    let modelCalls = 0
    let providerFailure: string | null = null
    const shadowDecisions: Array<{
      cardId: string
      isProduct: boolean | null
      titleId: string | null
      confidence: number
    }> = []

    const resolvePending = (
      item: PendingCard,
      titleId: string,
      confidence: number,
      reasons: ReviewReason[],
      source: 'heuristic' | 'model',
    ): void => {
      if (resolved.has(item.cardId)) return
      resolved.add(item.cardId)
      const lowConfidence = confidence < env.AI_MIN_CONFIDENCE
      decisions.push({
        cardId: item.cardId,
        source,
        isProduct: true,
        titleId,
        priceId: item.priceId,
        originalPriceId: item.originalPriceId,
        imageId: item.imageId,
        confidence,
        needsReview: lowConfidence,
        reviewReasons: uniqueReasons(lowConfidence ? [...reasons, 'low_confidence'] : reasons),
      })
    }

    // Modelo so roda se o kill switch permitir e houver cards ambiguos.
    if (MODES_WITH_MODEL.has(adjMode) && heuristic.pending.length > 0) {
      const deadline = started + env.LLM_TIMEOUT_MS
      const chunkSize = Math.max(1, env.LLM_CHUNK_SIZE)

      for (let offset = 0; offset < heuristic.pending.length; offset += chunkSize) {
        if (providerFailure) break
        const chunk = heuristic.pending.slice(offset, offset + chunkSize)
        const subPack: AdjudicationPack = {
          packVersion: pack.packVersion,
          marketplace: pack.marketplace,
          packHash: null,
          cards: chunk.map((item) => item.miniCard),
        }

        try {
          const remaining = deadline - Date.now()
          if (remaining <= 0) throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')

          const userPrompt = buildUserPrompt(subPack)
          if (env.LLM_DEBUG) {
            console.log(
              `[llm] chunk ${Math.floor(offset / chunkSize) + 1} pack=${packHash.slice(0, 12)} mode=${adjMode} ` +
                `cards=${chunk.map((item) => item.cardId).join(',')} timeout=${remaining}ms promptChars=${userPrompt.length}`,
            )
            if (env.LLM_DEBUG_PROMPT) {
              console.log(`[llm] system> ${SYSTEM_PROMPT}`)
              console.log(`[llm] user>\n${userPrompt}`)
            }
          }

          const completion = await provider.complete({
            system: SYSTEM_PROMPT,
            user: userPrompt,
            grammar: RESPONSE_GRAMMAR,
            maxTokens: env.LLM_MAX_TOKENS,
            temperature: env.LLM_TEMPERATURE,
            timeoutMs: remaining,
            signal: options.signal ?? AbortSignal.timeout(remaining),
          })
          modelCalls += 1
          if (env.LLM_DEBUG) {
            console.log(
              `[llm] response latency=${completion.latencyMs}ms in=${completion.tokensIn} out=${completion.tokensOut} ` +
                `raw=${completion.text}`,
            )
          }

          const titles = parseTitleDecisions(completion.text, subPack)
          for (const item of chunk) {
            const modelTitle = titles.get(item.cardId)
            if (env.LLM_DEBUG) {
              console.log(
                `[llm] choice card=${item.cardId} product=${String(modelTitle?.isProduct ?? null)} ` +
                  `title=${modelTitle?.titleId ?? '-'} confidence=${(modelTitle?.confidence ?? 0).toFixed(2)}`,
              )
            }

            if (adjMode === 'shadow') {
              // Shadow: registra a escolha do modelo (evidencia para F4/F6),
              // mas a resposta continua deterministica.
              shadowDecisions.push({
                cardId: item.cardId,
                isProduct: modelTitle?.isProduct ?? null,
                titleId: modelTitle?.titleId ?? null,
                confidence: modelTitle?.confidence ?? 0,
              })
              const fallbackTitleId = longestTitleId(item)
              if (fallbackTitleId) {
                resolvePending(item, fallbackTitleId, 0.4, ['ambiguous_title'], 'heuristic')
              }
              continue
            }

            const minConfidence = env.AI_MIN_CONFIDENCE
            const credible = (modelTitle?.confidence ?? 0) >= minConfidence

            if (modelTitle?.isProduct === false) {
              // Assist NUNCA descarta: so o modo `on` remove, e apenas com
              // confianca acima do limiar. Caso contrario, mantem a oferta
              // com revisao obrigatoria.
              if (adjMode === 'on' && credible) {
                resolved.add(item.cardId)
                rejected.push({ cardId: item.cardId, reason: 'not_a_product' })
                continue
              }
              const fallbackTitleId = longestTitleId(item)
              if (fallbackTitleId) {
                resolvePending(item, fallbackTitleId, 0.4, ['ambiguous_title'], 'heuristic')
              }
              continue
            }

            // p=1 com titulo ausente/invalido (abstenção) NAO descarta a oferta.
            const modelTitleId =
              modelTitle?.titleId && item.titleIds.includes(modelTitle.titleId)
                ? modelTitle.titleId
                : null
            // No assist, uma escolha abaixo do limiar nao prevalece.
            const trustedTitleId =
              adjMode === 'on' || credible ? modelTitleId : null
            const titleId = trustedTitleId ?? longestTitleId(item)
            if (!titleId) {
              resolved.add(item.cardId)
              rejected.push({ cardId: item.cardId, reason: 'invalid_model_output' })
              continue
            }

            const reasons: ReviewReason[] = trustedTitleId ? [] : ['ambiguous_title']
            resolvePending(
              item,
              titleId,
              trustedTitleId ? (modelTitle?.confidence ?? 0.5) : 0.4,
              reasons,
              trustedTitleId ? 'model' : 'heuristic',
            )
          }
        } catch (error) {
          // Abort do cliente nao e falha do modelo: encerra silenciosamente.
          if (options.signal?.aborted) break
          providerFailure = error instanceof ApiError ? error.code : 'provider_error'
          console.error('[adjudication] model fallback:', providerFailure)
        }
      }
    }

    // Qualquer pendente nao resolvido (off/shadow/falha/timeout) vira decisao
    // deterministica com confianca baixa: nunca perde o trabalho ja feito.
    for (const item of heuristic.pending) {
      if (resolved.has(item.cardId)) continue
      const fallbackTitleId = longestTitleId(item)
      if (!fallbackTitleId) {
        resolved.add(item.cardId)
        rejected.push({ cardId: item.cardId, reason: 'invalid_model_output' })
        continue
      }
      resolvePending(
        item,
        fallbackTitleId,
        0.4,
        [providerFailure ? 'model_fallback' : 'ambiguous_title'],
        'heuristic',
      )
    }

    let mode: AdjudicationMode
    if (providerFailure) mode = 'fallback'
    else if (adjMode === 'shadow') mode = 'heuristic'
    else if (modelCalls > 0) mode = provider.name === 'fake' ? 'fake' : 'llm'
    else mode = 'heuristic'

    const modelLatencyMs = Date.now() - started
    const result: AdjudicationResult = {
      packVersion: pack.packVersion,
      packHash,
      mode,
      modelId: provider.modelId,
      modelVersion: provider.modelVersion,
      promptVersion: PROMPT_VERSION,
      latencyMs: modelLatencyMs,
      fallbackReason: providerFailure,
      decisions,
      rejected,
    }

    try {
      await AdjudicationRepository.save({
        adjudicationId: randomUUID(),
        packHash: result.packHash,
        packVersion: result.packVersion,
        marketplace: pack.marketplace,
        mode: result.mode,
        modelId: result.modelId,
        modelVersion: result.modelVersion,
        promptVersion: result.promptVersion,
        latencyMs: result.latencyMs,
        cards: pack.cards.length,
        decisions: result.decisions.length,
        rejected: result.rejected.length,
        validationFailures: result.rejected.filter((item) => item.reason === 'invalid_model_output').length,
        fallbackReason: result.fallbackReason,
        modelCalls,
        shadow: shadowDecisions.length > 0 ? shadowDecisions : null,
        createdAt: new Date(),
        pack: env.AI_STORE_PACKS ? pack : null,
      })
    } catch (error) {
      console.error('[adjudication] persist failed:', error instanceof Error ? error.message : error)
    }

    // F6: replay opt-in (AI_REPLAY_PATH) alimenta o dataset de treino.
    if (adjMode !== 'off') {
      await captureReplay({
        capturedAt: new Date().toISOString(),
        packHash: result.packHash,
        packVersion: result.packVersion,
        marketplace: pack.marketplace,
        mode: result.mode,
        modelId: result.modelId,
        modelVersion: result.modelVersion,
        promptVersion: result.promptVersion,
        latencyMs: result.latencyMs,
        fallbackReason: result.fallbackReason,
        pack,
        decisions: result.decisions,
        rejected: result.rejected,
        shadow: shadowDecisions.length > 0 ? shadowDecisions : null,
      })
    }

    return { ...result, latencyMs: Date.now() - started }
  }

  static async stats(day: string): Promise<AdjudicationStats> {
    return AdjudicationRepository.stats(day)
  }
}
