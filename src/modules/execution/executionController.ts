import type { Request, Response } from 'express'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import ExecutionService from './executionService.ts'

export default class ExecutionController {
  static async execute(req: Request, res: Response): Promise<void> {
    const controller = new AbortController()
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', onClose)

    let result: Awaited<ReturnType<typeof ExecutionService.execute>>
    try {
      result = await ExecutionService.execute(req.body, { signal: controller.signal })
    } finally {
      res.off('close', onClose)
    }

    const requestId = String(res.locals['requestId'] ?? '')
    console.log(
      `[execute] requestId=${requestId} profile=${result.profileId}@${result.profileVersion} ` +
        `model=${result.modelId} mode=${result.mode} cache=${result.cache.appHit ? 'hit' : 'miss'} ` +
        `latencyMs=${result.latencyMs}`,
    )
    sendSuccess(res, result)
  }
}
