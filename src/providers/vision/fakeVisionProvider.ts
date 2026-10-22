import type { VisionProvider, VisionScoreInput } from './types.ts'

// ============================================================================
// Provider deterministico p/ testes/offline. Pontua a URL que contem
// `preferred` (default) mais alto; o resto fica abaixo. Nao acessa a rede.
// `VISION_FAKE_PREFER` permite trocar o marcador.
// ============================================================================

export class FakeVisionProvider implements VisionProvider {
  readonly name = 'fake'

  async isReady(): Promise<boolean> {
    return true
  }

  async score(input: VisionScoreInput): Promise<number[]> {
    const marker = (process.env['VISION_FAKE_PREFER'] ?? 'preferred').trim().toLowerCase()
    return input.images.map((url) => (url.toLowerCase().includes(marker) ? 0.9 : 0.3))
  }

  async dispose(): Promise<void> {
    // stateless
  }
}
