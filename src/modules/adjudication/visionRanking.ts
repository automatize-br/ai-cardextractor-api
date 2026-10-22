import type { AdjudicationCard } from '../../types/adjudication.ts'
import type { VisionProvider } from '../../providers/vision/types.ts'

// ============================================================================
// Reordena os candidatos de imagem de cada card pelo score de visao (CLIP/
// SigLIP). Só reordena IDs JÁ presentes no pack: nunca cria/remove candidato.
// Best-effort: falha/timeout do provider mantém a ordem determinística.
// ============================================================================

const HTTP_URL = /^https?:\/\//i

export interface VisionRankingOptions {
  minScore: number
  timeoutMs: number
  signal?: AbortSignal | null
}

function scoreable(card: AdjudicationCard): Array<{ id: string; url: string }> {
  return card.imageCandidates.filter(
    (candidate) => HTTP_URL.test(candidate.url) && candidate.url.length <= 2000,
  )
}

export async function rankImageCandidates(
  cards: AdjudicationCard[],
  provider: VisionProvider,
  options: VisionRankingOptions,
): Promise<number> {
  const targets = cards.filter((card) => card.imageCandidates.length > 1)
  if (targets.length === 0) return 0

  let changed = 0
  await Promise.allSettled(
    targets.map(async (card) => {
      const images = scoreable(card)
      if (images.length < 2) return
      const title = [...card.titleCandidates].sort((left, right) => right.text.length - left.text.length)[0]?.text
      if (!title || title.trim() === '') return

      let scores: number[]
      try {
        scores = await provider.score({
          text: title,
          images: images.map((image) => image.url),
          timeoutMs: options.timeoutMs,
          signal: options.signal ?? null,
        })
      } catch {
        return
      }
      if (scores.length !== images.length) return

      const best = Math.max(...scores)
      if (!Number.isFinite(best) || best <= 0 || best < options.minScore) return

      const ranked = images
        .map((image, index) => ({ image, score: scores[index] ?? 0 }))
        .sort((left, right) => right.score - left.score)
      const firstId = ranked[0]?.image.id
      if (!firstId || card.imageCandidates[0]?.id === firstId) return

      const rankById = new Map(ranked.map((entry, index) => [entry.image.id, index]))
      card.imageCandidates.sort(
        (left, right) =>
          (rankById.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rankById.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      )
      changed += 1
    }),
  )
  return changed
}
