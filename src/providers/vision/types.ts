// ============================================================================
// Provider de VISÃO (F5) — CLIP/SigLIP via servico HTTP ou fake offline.
//
// Contrato: recebe o texto do produto e as URLs JÁ extraídas e devolve um score
// por imagem (0..1). O provider NUNCA cria imagem, URL ou texto: só pontua os
// candidatos existentes para o pipeline reordenar a melhor foto.
// ============================================================================

export interface VisionScoreInput {
  text: string
  images: string[]
  timeoutMs: number
  signal?: AbortSignal | null
}

export interface VisionProvider {
  readonly name: string
  isReady(): Promise<boolean>
  score(input: VisionScoreInput): Promise<number[]>
  dispose(): Promise<void>
}
