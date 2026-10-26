import { setTimeout as delay } from 'node:timers/promises'
import { ApiError } from '../../exceptions/ApiError.ts'
import { NONE_LETTER } from './grammar.ts'
import type { CompletionInput, CompletionResult, LlmProvider } from './types.ts'

// ============================================================================
// Provider deterministico. Le o MESMO prompt que o modelo real receberia e
// aplica regras simples, devolvendo LETRAS (nao IDs). Serve para testar o
// pipeline completo (parse + validacao) sem carregar GGUF nem fazer rede.
// ============================================================================

interface ParsedPrice {
  letter: string
  currency: string
  cents: number
  kind: string
}

interface ParsedCard {
  cardNumber: number
  titles: Array<{ letter: string; text: string }>
  prices: ParsedPrice[]
  images: string[]
}

const NON_PRODUCT_HINTS = [
  'patrocinado',
  'publicidade',
  'frete gratis',
  'avaliacoes',
  'ver mais',
  'cupom de desconto',
]

function parsePrompt(user: string): ParsedCard[] {
  const cards: ParsedCard[] = []
  let current: ParsedCard | null = null

  for (const raw of user.split('\n')) {
    const line = raw.trim()
    const cardMatch = /^card (\d+) \(id=([A-Za-z0-9_-]+)\)/.exec(line)
    if (cardMatch?.[1]) {
      current = { cardNumber: Number(cardMatch[1]), titles: [], prices: [], images: [] }
      cards.push(current)
      continue
    }
    if (!current) continue

    const titleMatch = /^T ([A-L])="(.*)"$/.exec(line)
    if (titleMatch?.[1] !== undefined && titleMatch[2] !== undefined) {
      current.titles.push({ letter: titleMatch[1], text: titleMatch[2] })
      continue
    }

    const priceMatch = /^P ([A-L]) moeda=([A-Z]{3}) centavos=(\d+) tipo=([a-z]+) /.exec(line)
    if (priceMatch?.[1] && priceMatch[2] && priceMatch[3] && priceMatch[4]) {
      current.prices.push({
        letter: priceMatch[1],
        currency: priceMatch[2],
        cents: Number(priceMatch[3]),
        kind: priceMatch[4],
      })
      continue
    }

    const imageMatch = /^I ([A-L])$/.exec(line)
    if (imageMatch?.[1]) current.images.push(imageMatch[1])
  }

  return cards
}

function confidenceOverride(): number | null {
  const text = (process.env['FAKE_CONFIDENCE'] ?? '').trim()
  if (text === '') return null
  const raw = Number(text)
  if (!Number.isFinite(raw)) return null
  return Math.min(100, Math.max(0, raw))
}

function decide(card: ParsedCard): Record<string, string | number> {
  const titles = card.titles.filter((title) => title.text.length >= 8)
  const text = titles.map((title) => title.text.toLowerCase()).join(' ')
  const hinted = NON_PRODUCT_HINTS.some((hint) => text.includes(hint))

  const currents = card.prices.filter((price) => price.kind === 'current' && price.currency === 'BRL')
  const ambiguous = new Set(currents.map((price) => price.cents)).size > 1
  const price = currents[0]
  const title = [...titles].sort((a, b) => b.text.length - a.text.length)[0]
  const image = card.images[0]

  if (hinted || !title || !price || !image || ambiguous) {
    return {
      c: card.cardNumber,
      p: 0,
      t: NONE_LETTER,
      pr: NONE_LETTER,
      o: NONE_LETTER,
      i: NONE_LETTER,
      cf: confidenceOverride() ?? 5,
    }
  }

  const original = card.prices
    .filter(
      (candidate) =>
        candidate.kind === 'original' && candidate.currency === 'BRL' && candidate.cents > price.cents,
    )
    .sort((a, b) => b.cents - a.cents)[0]

  return {
    c: card.cardNumber,
    p: 1,
    t: title.letter,
    pr: price.letter,
    o: original?.letter ?? NONE_LETTER,
    i: image,
    cf: confidenceOverride() ?? 90,
  }
}

export class FakeProvider implements LlmProvider {
  readonly name = 'fake' as const
  readonly modelId: string
  readonly modelVersion: string
  private readonly delayMs: number
  private calls = 0

  constructor(modelId = 'fake-adjudicator', modelVersion = 'fake@1', delayMs?: number) {
    this.modelId = modelId
    this.modelVersion = modelVersion
    const fromEnv = Number(process.env['FAKE_DELAY_MS'] ?? '0')
    this.delayMs = delayMs ?? (Number.isFinite(fromEnv) ? fromEnv : 0)
  }

  async load(): Promise<void> {
    // nada a carregar
  }

  async isReady(): Promise<boolean> {
    return true
  }

  async complete(input: CompletionInput): Promise<CompletionResult> {
    this.calls += 1
    const failAfter = Number(process.env['FAKE_FAIL_AFTER'] ?? '0')
    if (Number.isInteger(failAfter) && failAfter > 0 && this.calls > failAfter) {
      throw new Error('fake_provider_forced_failure')
    }

    const started = Date.now()
    const delayMs = Number(process.env['FAKE_DELAY_MS'] ?? this.delayMs)
    if (Number.isFinite(delayMs) && delayMs > 0) {
      if (delayMs > input.timeoutMs) {
        await delay(Math.min(input.timeoutMs, 25), undefined, input.signal ? { signal: input.signal } : undefined)
        throw new ApiError(503, 'MODEL_TIMEOUT', 'Model timed out')
      }
      await delay(delayMs, undefined, input.signal ? { signal: input.signal } : undefined)
    }
    const cards = parsePrompt(input.user)
    const payload = { d: cards.map((card) => decide(card)) }
    return {
      text: JSON.stringify(payload),
      tokensIn: Math.ceil(input.user.length / 4),
      tokensOut: Math.ceil(JSON.stringify(payload).length / 4),
      latencyMs: Date.now() - started,
    }
  }

  async dispose(): Promise<void> {
    // nada a liberar
  }
}
