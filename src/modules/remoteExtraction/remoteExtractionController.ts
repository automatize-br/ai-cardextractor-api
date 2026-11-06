import type { Request, Response } from 'express'
import { env } from '../../config/env.ts'
import { CONTRACT_VERSION, CORE_VERSION, EXTRACTOR_VERSION } from '../../config/version.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import { activeExtractions, beginExtraction, endExtraction } from '../extraction/metrics.ts'
import RemoteExtractionService, { type RemoteExtractionInput } from './remoteExtractionService.ts'
import { TRIMMER_VERSION } from './htmlTrimmer.ts'

export const REMOTE_CONTRACT_VERSION = '2'

interface RemoteBody {
  contractVersion?: unknown
  requestId?: unknown
  marketplace?: unknown
  urls?: unknown
  query?: unknown
  profile?: unknown
  mode?: unknown
  maxScanned?: unknown
  maxCards?: unknown
  maxLlmCards?: unknown
  deadlineAt?: unknown
}

const MODES = ['off', 'shadow', 'assist', 'on']

function asString(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function readBody(raw: unknown): RemoteExtractionInput & { requestId: string; mode: 'off' | 'shadow' | 'assist' | 'on' } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ApiError(400, 'INPUT_INVALID', 'body must be a JSON object')
  }
  const body = raw as RemoteBody
  if (asString(body.contractVersion, 8) !== REMOTE_CONTRACT_VERSION) {
    throw new ApiError(409, 'CONTRACT_MISMATCH', `unsupported contractVersion (expected ${REMOTE_CONTRACT_VERSION})`)
  }
  const marketplace = asString(body.marketplace, 40)
  if (marketplace === '') throw new ApiError(400, 'INPUT_INVALID', 'marketplace is required')

  const urls = Array.isArray(body.urls)
    ? body.urls.map((item) => asString(item, 2048)).filter((item) => item !== '')
    : []
  if (urls.length === 0) throw new ApiError(400, 'INPUT_INVALID', 'urls is required')
  if (urls.length > 5) throw new ApiError(400, 'INPUT_INVALID', 'urls supports at most 5 items')

  const mode = MODES.includes(String(body.mode)) ? (body.mode as RemoteExtractionInput['mode']) : 'off'
  return {
    requestId: asString(body.requestId, 120),
    marketplace,
    urls,
    query: asString(body.query, 200),
    profile: asString(body.profile, 80) || env.AI_DEFAULT_PROFILE,
    mode: mode as 'off' | 'shadow' | 'assist' | 'on',
    maxScanned: asInt(body.maxScanned, env.EXTRACTOR_MAX_SCANNED, 1, env.EXTRACTOR_MAX_SCANNED),
    maxCards: asInt(body.maxCards, env.EXTRACTOR_MAX_CARDS, 1, env.EXTRACTOR_MAX_CARDS),
    maxLlmCards: asInt(body.maxLlmCards, env.EXTRACTOR_MAX_LLM_CARDS, 0, env.EXTRACTOR_MAX_LLM_CARDS),
    deadlineAt: asInt(body.deadlineAt, Date.now() + env.EXTRACTOR_SCRAPE_TIMEOUT_MS, Date.now() + 1, Number.MAX_SAFE_INTEGER),
  }
}

export default class RemoteExtractionController {
  static async extractOffers(req: Request, res: Response): Promise<void> {
    if (activeExtractions() >= env.EXTRACTOR_CAPACITY) {
      res.setHeader('Retry-After', '2')
      throw new ApiError(429, 'EXTRACTOR_BUSY', 'Extractor at capacity')
    }
    beginExtraction()
    let work: ReturnType<typeof RemoteExtractionService.extract> | null = null
    try {
      const input = readBody(req.body)
      const remaining = Math.min(env.EXTRACTOR_SCRAPE_TIMEOUT_MS, Math.max(1, input.deadlineAt - Date.now()))
      let timer: NodeJS.Timeout | null = null
      try {
        work = RemoteExtractionService.extract(input)
        // O slot só volta quando o trabalho REAL terminar (timeout não libera CPU
        // fantasma). Erro também libera.
        void work.then(
          () => endExtraction(),
          () => endExtraction(),
        )
        const result = await Promise.race([
          work,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new ApiError(504, 'MODEL_TIMEOUT', 'Scrape/extraction timed out')),
              remaining,
            )
          }),
        ])

        console.log(
          `[extract-offers] requestId=${input.requestId || '-'} marketplace=${input.marketplace} ` +
            `urls=${input.urls.length} offers=${result.offers.length} quality=${result.quality} ` +
            `blocked=${result.sources.filter((source) => source.error === 'blocked').length} ` +
            `ms=${result.durationMs}`,
        )

        sendSuccess(res, {
          contractVersion: REMOTE_CONTRACT_VERSION,
          requestId: input.requestId,
          marketplace: result.marketplace,
          extractorVersion: EXTRACTOR_VERSION,
          coreVersion: CORE_VERSION,
          trimmerVersion: TRIMMER_VERSION,
          quality: result.quality,
          reason: result.reason,
          offers: result.offers,
          discarded: result.discarded,
          rejected: result.rejected,
          scanned: result.scanned,
          sources: result.sources,
          durationMs: result.durationMs,
          core: CONTRACT_VERSION,
        })
      } finally {
        if (timer) clearTimeout(timer)
      }
    } finally {
      // Validação falhou antes de iniciar o trabalho: libera o slot aqui.
      if (!work) endExtraction()
    }
  }
}
