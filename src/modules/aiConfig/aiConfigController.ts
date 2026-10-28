import type { Request, Response } from 'express'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import { ApiError } from '../../exceptions/ApiError.ts'
import { applyAiConfig } from './apply.ts'
import { getRuntimeAiConfig, parseRuntimeAiConfig } from './runtimeConfig.ts'

// ============================================================================
// Recebe a config de IA do central (admin). `test` faz um ping no /models do
// provider OpenAI-compatible para validar URL/chave antes de habilitar.
// ============================================================================

async function pingModel(config: NonNullable<ReturnType<typeof getRuntimeAiConfig>>): Promise<{
  ready: boolean
  message: string
}> {
  if (config.provider === 'fake') return { ready: true, message: 'provider fake' }
  if (config.baseUrl === '' || config.model === '') return { ready: false, message: 'baseUrl/model vazios' }
  const started = Date.now()
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(Math.min(10000, config.timeoutMs)),
    })
    if (!response.ok) {
      return { ready: false, message: `HTTP ${response.status} em /models (${Date.now() - started}ms)` }
    }
    return { ready: true, message: `modelo acessível (${Date.now() - started}ms)` }
  } catch (error) {
    return {
      ready: false,
      message: `falha ao acessar /models: ${error instanceof Error ? error.message : 'unknown'}`,
    }
  }
}

export default class AiConfigController {
  static async apply(req: Request, res: Response): Promise<void> {
    const parsed = parseRuntimeAiConfig(req.body)
    if (!parsed) throw ApiError.badRequest('Config de IA inválida')
    const result = applyAiConfig(req.body)
    const test = typeof req.body === 'object' && req.body !== null && (req.body as { test?: unknown }).test === true
    const appliedConfig = getRuntimeAiConfig()!
    const ping = test
      ? await pingModel(appliedConfig)
      : { ready: appliedConfig.provider === 'fake' || (appliedConfig.baseUrl !== '' && appliedConfig.model !== ''), message: 'config aplicada' }
    sendSuccess(res, {
      applied: result.applied,
      version: result.version,
      provider: appliedConfig.provider,
      model: appliedConfig.model,
      ready: ping.ready,
      message: ping.message,
    })
  }
}
