import { ApiError } from '../../exceptions/ApiError.ts'
import type { VisionProvider, VisionScoreInput } from './types.ts'

// ============================================================================
// Provider HTTP para um servico CLIP/SigLIP (GPU ou CPU). Contrato minimo:
//
//   POST {VISION_HTTP_URL}/score
//   body: { "text": "...", "images": ["https://...", ...] }
//   resp: { "scores": [0.91, 0.42, ...] }   (mesma ordem de `images`)
//
// Qualquer servico que exponha esse endpoint (clip-server, SigLIP + FastAPI)
// funciona sem acoplar o servico de extracao a uma biblioteca nativa.
// ============================================================================

interface ScoreResponse {
  scores?: unknown
}

export class HttpVisionProvider implements VisionProvider {
  readonly name = 'http'

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async isReady(): Promise<boolean> {
    return this.baseUrl !== ''
  }

  async score(input: VisionScoreInput): Promise<number[]> {
    if (this.baseUrl === '') throw ApiError.modelUnavailable('VISION_HTTP_URL not configured')
    if (input.signal?.aborted) throw ApiError.modelUnavailable('Vision request aborted')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), input.timeoutMs)
    const onExternalAbort = (): void => controller.abort()
    input.signal?.addEventListener('abort', onExternalAbort)

    try {
      const response = await fetch(`${this.baseUrl}/score`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey !== '' ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ text: input.text, images: input.images }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw ApiError.modelUnavailable(`Vision service responded ${response.status}`)
      }
      const payload = (await response.json()) as ScoreResponse
      const scores = payload.scores
      if (!Array.isArray(scores) || scores.length !== input.images.length) {
        throw ApiError.modelUnavailable('Vision service returned invalid scores')
      }
      const parsed = scores.map((value) => (typeof value === 'number' ? value : Number.NaN))
      if (!parsed.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
        throw ApiError.modelUnavailable('Vision service returned scores out of range')
      }
      return parsed
    } catch (error) {
      if (controller.signal.aborted) throw ApiError.modelUnavailable('Vision request timed out')
      throw error instanceof ApiError ? error : ApiError.modelUnavailable('Vision provider failed')
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  async dispose(): Promise<void> {
    // stateless
  }
}
