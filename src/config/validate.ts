import { env, isProductionEnvironment } from './env.ts'
import { listModels } from './models.ts'
import { listProfiles } from './profiles.ts'

// ============================================================================
// Fail-fast de configuração v2. Roda no boot (e no `npm run config:validate`).
// ============================================================================

const CACHE_MODES = new Set(['memory', 'redis', 'off'])
const PROMPT_CACHE_MODES = new Set(['auto', 'on', 'off'])

export function validateConfig(): void {
  if (!CACHE_MODES.has(env.AI_APP_CACHE)) {
    throw new Error(`AI_APP_CACHE must be "memory", "redis" or "off" — received "${env.AI_APP_CACHE}"`)
  }
  if (env.AI_APP_CACHE === 'redis') {
    throw new Error('AI_APP_CACHE=redis ainda não está implementado; use "memory" ou "off"')
  }
  if (!PROMPT_CACHE_MODES.has(env.AI_PROMPT_CACHE)) {
    throw new Error(`AI_PROMPT_CACHE must be "auto", "on" or "off" — received "${env.AI_PROMPT_CACHE}"`)
  }
  if (env.VISION_PROVIDER !== 'off' && env.VISION_PROVIDER !== 'fake' && env.VISION_VERSION === '') {
    throw new Error('VISION_VERSION is required when VISION_PROVIDER is enabled')
  }

  // Catálogo e perfis são validados aqui. Se AI_PROFILES_JSON estiver vazio,
  // o serviço segue no modo legado (apenas /v1/adjudicate).
  const models = listModels()
  if (env.AI_DEFAULT_MODEL !== '' && !models.some((model) => model.id === env.AI_DEFAULT_MODEL)) {
    throw new Error(`AI_DEFAULT_MODEL "${env.AI_DEFAULT_MODEL}" not found in AI_MODELS_JSON`)
  }
  const profiles = listProfiles()
  if (profiles.length > 0 && !profiles.some((entry) => entry.profile.id === env.AI_DEFAULT_PROFILE)) {
    console.warn(
      `[config] AI_DEFAULT_PROFILE="${env.AI_DEFAULT_PROFILE}" não encontrado; usando "${profiles[0]?.profile.id}".`,
    )
  }

  if (isProductionEnvironment()) {
    const explicitModelPath = (process.env['AI_MODEL_PATH'] ?? '').trim() !== ''
    if (env.LLM_PROVIDER === 'llamacpp' || explicitModelPath) {
      throw new Error(
        'LLM_PROVIDER=llamacpp/AI_MODEL_PATH não são suportados no runtime v2 em produção. ' +
          'Use um endpoint OpenAI-compatible em AI_MODELS_JSON ou o provider http legado.',
      )
    }
    if (env.LLM_PROVIDER === 'fake') {
      throw new Error('LLM_PROVIDER=fake não é permitido em produção')
    }
  }
}
