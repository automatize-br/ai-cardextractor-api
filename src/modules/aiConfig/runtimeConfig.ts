import { env } from '../../config/env.ts'
import { computeHash } from '../../helpers/packHash.ts'
import type { CatalogProvider, RegisteredModel } from '../../types/model.ts'

// ============================================================================
// Config de IA dinâmica vinda do central (admin) — sem reiniciar nem .env.
//
// O modelo lógico exposto aos perfis é sempre `fast`; o provider/modelo físico
// (OpenAI-compatible, llama.cpp, vLLM, Ollama, OpenRouter...) vem da config.
// Enquanto não houver config aplicada, `fast` existe como placeholder para os
// perfis carregarem; sem `enabled` a extração segue determinística.
// ============================================================================

export type RuntimeAiMode = 'off' | 'shadow' | 'assist' | 'on'

export interface RuntimeAiConfig {
  contractVersion: '1'
  configId: string
  version: number
  enabled: boolean
  mode: RuntimeAiMode
  provider: 'openai-compatible' | 'fake'
  baseUrl: string
  model: string
  apiKey: string | null
  temperature: number
  maxTokens: number
  timeoutMs: number
  structuredOutput: 'json_schema' | 'json_object' | 'none'
}

export const RUNTIME_MODEL_ID = 'fast'

const MODES: RuntimeAiMode[] = ['off', 'shadow', 'assist', 'on']
let current: RuntimeAiConfig | null = null

function asString(value: unknown, max = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

/** Valida o payload do central. Retorna null quando malformado (não aplica). */
export function parseRuntimeAiConfig(raw: unknown): RuntimeAiConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  if (record['contractVersion'] !== '1') return null
  if (typeof record['configId'] !== 'string' || record['configId'] === '') return null
  if (!Number.isFinite(Number(record['version']))) return null
  const provider = record['provider'] === 'fake' ? 'fake' : 'openai-compatible'
  const mode = MODES.includes(record['mode'] as RuntimeAiMode) ? (record['mode'] as RuntimeAiMode) : 'off'
  const structured = ['json_schema', 'json_object', 'none'].includes(String(record['structuredOutput']))
    ? (record['structuredOutput'] as RuntimeAiConfig['structuredOutput'])
    : 'json_schema'
  const baseUrl = asString(record['baseUrl'])
  const model = asString(record['model'], 160)
  const enabled = record['enabled'] === true
  // Desabilitada pode vir sem URL/modelo (serve para desligar a IA); habilitada exige.
  if (provider !== 'fake' && enabled && (baseUrl === '' || model === '')) return null
  return {
    contractVersion: '1',
    configId: asString(record['configId'], 64) || 'default',
    version: Math.max(0, Math.trunc(Number(record['version']) || 0)),
    enabled: record['enabled'] === true,
    mode,
    provider,
    baseUrl,
    model,
    apiKey: typeof record['apiKey'] === 'string' && record['apiKey'] !== '' ? record['apiKey'] : null,
    temperature: asNumber(record['temperature'], 0, 0, 2),
    maxTokens: Math.trunc(asNumber(record['maxTokens'], 800, 64, 32768)),
    timeoutMs: Math.trunc(asNumber(record['timeoutMs'], 30000, 1000, 120000)),
    structuredOutput: structured,
  }
}

export function applyRuntimeAiConfig(raw: unknown): { applied: boolean; version: number | null } {
  const parsed = parseRuntimeAiConfig(raw)
  if (!parsed) return { applied: false, version: current?.version ?? null }
  current = parsed
  return { applied: true, version: parsed.version }
}

export function getRuntimeAiConfig(): RuntimeAiConfig | null {
  return current
}

export function runtimeAiEnabled(): boolean {
  return current?.enabled === true && current.mode !== 'off'
}

export function runtimeAiMode(): RuntimeAiMode | null {
  return runtimeAiEnabled() ? current!.mode : null
}

/** Modelo lógico `fast` (configurado ou placeholder para carregar os perfis). */
export function runtimeModel(): RegisteredModel {
  const config = current
  const provider: CatalogProvider = config?.provider === 'fake' ? 'fake' : 'openai-compatible'
  const physical = config?.model || env.AI_MODEL_ID
  const baseUrl = config?.baseUrl || ''
  const maxOutput = config?.maxTokens ?? env.LLM_MAX_TOKENS
  const model = {
    id: RUNTIME_MODEL_ID,
    version: `runtime@${config?.version ?? 0}`,
    provider,
    model: provider === 'fake' ? 'fake' : physical,
    baseUrl,
    apiKeyEnv: '',
    structuredOutput: 'json_schema' as const,
    promptCaching: 'off' as const,
    maxContext: 200_000,
    maxOutput,
    cost: null,
  }
  return {
    ...model,
    modelHash: computeHash({
      id: model.id,
      version: model.version,
      provider: model.provider,
      model: model.model,
      baseUrl: model.baseUrl,
      structuredOutput: model.structuredOutput,
      maxContext: model.maxContext,
      maxOutput: model.maxOutput,
    }),
  }
}

export function runtimeApiKey(): string {
  return current?.apiKey ?? ''
}

export function resetRuntimeAiConfigForTests(): void {
  current = null
}
