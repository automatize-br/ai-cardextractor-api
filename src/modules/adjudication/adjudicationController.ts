import type { Request, Response } from 'express'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import { dayKey } from '../../helpers/dayKey.ts'
import AdjudicationService from './adjudicationService.ts'

export default class AdjudicationController {
  static async adjudicate(req: Request, res: Response): Promise<void> {
    // Se o cliente desconectar/abortar, cancela a inferencia em andamento.
    const controller = new AbortController()
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', onClose)

    let result: Awaited<ReturnType<typeof AdjudicationService.adjudicate>>
    try {
      result = await AdjudicationService.adjudicate(req.body, { signal: controller.signal })
    } finally {
      res.off('close', onClose)
    }

    const requestId = String(res.locals['requestId'] ?? '')
    const fallback = result.fallbackReason ? ` fallback=${result.fallbackReason}` : ''
    console.log(
      `[adjudicate] requestId=${requestId} hash=${result.packHash.slice(0, 12)} mode=${result.mode} ` +
        `cards=${result.decisions.length + result.rejected.length} decisions=${result.decisions.length} ` +
        `rejected=${result.rejected.length} latencyMs=${result.latencyMs}${fallback}`,
    )
    sendSuccess(res, result)
  }

  static async stats(req: Request, res: Response): Promise<void> {
    const queryDay = typeof req.query['day'] === 'string' ? req.query['day'] : ''
    const day = /^\d{4}-\d{2}-\d{2}$/.test(queryDay) ? queryDay : dayKey()
    sendSuccess(res, await AdjudicationService.stats(day))
  }
}
