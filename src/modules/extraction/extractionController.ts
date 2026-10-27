import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import type { Request, Response } from 'express'
import { env } from '../../config/env.ts'
import { CONTRACT_VERSION, CORE_VERSION, EXTRACTOR_VERSION } from '../../config/version.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import ExtractionService from './extractionService.ts'
import { beginExtraction, endExtraction } from './metrics.ts'

interface ExtractMeta {
  marketplace: string
  url: string
  profile: string
  contractVersion: string
  coreVersion: string
  trimmerVersion: string
  htmlHashTrimmed: string
  htmlBytes: number
  maxScanned: number
  maxCards: number
  maxLlmCards: number
  mode: 'off' | 'shadow' | 'assist' | 'on'
  deadlineAt: number
  requestId: string
}

function readMeta(raw: string): ExtractMeta {
  let text = raw.trim()
  if (!text.startsWith('{')) text = Buffer.from(text, 'base64url').toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ApiError(400, 'CONTRACT_MISMATCH', 'x-extract-meta is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, 'CONTRACT_MISMATCH', 'x-extract-meta must be an object')
  }
  const record = parsed as Record<string, unknown>
  const marketplace = typeof record['marketplace'] === 'string' ? record['marketplace'] : ''
  const url = typeof record['url'] === 'string' ? record['url'] : ''
  const profile = typeof record['profile'] === 'string' ? record['profile'] : 'cards'
  const contractVersion = typeof record['contractVersion'] === 'string' ? record['contractVersion'] : ''
  const coreVersion = typeof record['coreVersion'] === 'string' ? record['coreVersion'] : ''
  const trimmerVersion = typeof record['trimmerVersion'] === 'string' ? record['trimmerVersion'] : ''
  const htmlHashTrimmed = typeof record['htmlHashTrimmed'] === 'string' ? record['htmlHashTrimmed'] : ''
  const htmlBytes = Number(record['htmlBytes'])
  const maxScanned = Number(record['maxScanned'])
  const maxCards = Number(record['maxCards'])
  const maxLlmCards = Number(record['maxLlmCards'])
  const deadlineAt = Number(record['deadlineAt'])
  const mode = record['mode']
  const requestId = typeof record['requestId'] === 'string' ? record['requestId'] : ''

  if (marketplace === '' || url === '' || profile === '') {
    throw new ApiError(400, 'CONTRACT_MISMATCH', 'marketplace, url and profile are required')
  }
  if (contractVersion !== CONTRACT_VERSION) {
    throw new ApiError(409, 'CONTRACT_MISMATCH', `unsupported contractVersion "${contractVersion}"`)
  }
  if (!['off', 'shadow', 'assist', 'on'].includes(String(mode))) {
    throw new ApiError(400, 'INPUT_INVALID', 'invalid mode')
  }
  if (!Number.isInteger(htmlBytes) || !Number.isInteger(maxScanned) || !Number.isInteger(maxCards)) {
    throw new ApiError(400, 'INPUT_INVALID', 'htmlBytes/maxScanned/maxCards must be integers')
  }
  if (htmlHashTrimmed === '') throw new ApiError(400, 'CONTRACT_MISMATCH', 'htmlHashTrimmed is required')

  return {
    marketplace,
    url,
    profile,
    contractVersion,
    coreVersion,
    trimmerVersion,
    htmlHashTrimmed,
    htmlBytes,
    maxScanned: Math.min(env.EXTRACTOR_MAX_SCANNED, Math.max(1, maxScanned)),
    maxCards: Math.min(env.EXTRACTOR_MAX_CARDS, Math.max(1, maxCards)),
    maxLlmCards: Math.min(env.EXTRACTOR_MAX_LLM_CARDS, Math.max(0, Number.isInteger(maxLlmCards) ? maxLlmCards : env.EXTRACTOR_MAX_LLM_CARDS)),
    mode: mode as ExtractMeta['mode'],
    deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + env.EXTRACTOR_REQUEST_TIMEOUT_MS,
    requestId,
  }
}

function decodeBody(req: Request): Buffer {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
  if (raw.length === 0) throw new ApiError(400, 'HTML_INVALID', 'HTML body is empty')
  if (raw.length > env.EXTRACTOR_BODY_LIMIT_BYTES) {
    throw new ApiError(413, 'PACK_TOO_LARGE', `body exceeds ${env.EXTRACTOR_BODY_LIMIT_BYTES} bytes`)
  }
  const encoding = String(req.header('content-encoding') ?? '').toLowerCase()
  if (encoding === 'gzip') {
    if (raw.length > env.EXTRACTOR_MAX_HTML_GZIP_BYTES) {
      throw new ApiError(413, 'HTML_TOO_LARGE', `gzip body exceeds ${env.EXTRACTOR_MAX_HTML_GZIP_BYTES} bytes`)
    }
    try {
      return gunzipSync(raw, { maxOutputLength: env.EXTRACTOR_MAX_HTML_BYTES + 1 })
    } catch {
      throw new ApiError(413, 'HTML_TOO_LARGE', 'gzip body is invalid or exceeds the decompressed limit')
    }
  }
  return raw
}

export default class ExtractionController {
  static async extract(req: Request, res: Response): Promise<void> {
    const meta = readMeta(String(req.header('x-extract-meta') ?? ''))
    const htmlBuffer = decodeBody(req)
    if (htmlBuffer.length > env.EXTRACTOR_MAX_HTML_BYTES) {
      throw new ApiError(413, 'HTML_TOO_LARGE', `HTML exceeds ${env.EXTRACTOR_MAX_HTML_BYTES} bytes`)
    }
    const hash = createHash('sha256').update(htmlBuffer).digest('hex')
    if (hash !== meta.htmlHashTrimmed) {
      throw new ApiError(409, 'CONTRACT_MISMATCH', 'htmlHashTrimmed does not match body')
    }
    if (htmlBuffer.length !== meta.htmlBytes) {
      throw new ApiError(409, 'CONTRACT_MISMATCH', 'htmlBytes does not match body')
    }

    const remaining = Math.min(
      env.EXTRACTOR_REQUEST_TIMEOUT_MS,
      Math.max(1, meta.deadlineAt - Date.now()),
    )
    beginExtraction()
    let result: Awaited<ReturnType<typeof ExtractionService.extract>>
    try {
      result = await Promise.race([
        ExtractionService.extract({
          marketplace: meta.marketplace,
          url: meta.url,
          html: htmlBuffer.toString('utf8'),
          profile: meta.profile,
          maxScanned: meta.maxScanned,
          maxCards: meta.maxCards,
          maxLlmCards: meta.maxLlmCards,
          mode: meta.mode,
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new ApiError(504, 'MODEL_TIMEOUT', 'Extraction timed out')), remaining)
        }),
      ])
    } finally {
      endExtraction()
    }

    console.log(
      `[extract] requestId=${meta.requestId || '-'} marketplace=${meta.marketplace} mode=${result.mode} ` +
        `scanned=${result.scanned} cards=${result.cards.length} quality=${result.quality}`,
    )

    sendSuccess(res, {
      contractVersion: CONTRACT_VERSION,
      requestId: meta.requestId,
      marketplace: result.marketplace,
      extractorVersion: EXTRACTOR_VERSION,
      coreVersion: CORE_VERSION,
      trimmerVersion: meta.trimmerVersion,
      promptVersion: result.execution?.promptHash ?? null,
      modelId: result.execution?.modelId ?? null,
      modelVersion: result.execution?.modelVersion ?? null,
      mode: result.mode,
      degraded: result.quality === 'partial',
      reason: result.quality === 'no_cards' ? 'NO_CARDS_EXTRACTED' : null,
      htmlHashTrimmed: meta.htmlHashTrimmed,
      cards: result.cards,
      rejected: result.rejected,
      diagnostics: {
        scanned: result.scanned,
        returned: result.cards.length,
        rejected: result.rejected.length,
        truncated: result.truncated,
        coverageComplete: result.coverageComplete,
        quality: result.quality,
        htmlBytes: htmlBuffer.length,
        llmCards: result.execution ? Math.min(30, result.cards.length) : 0,
      },
    })
  }
}
