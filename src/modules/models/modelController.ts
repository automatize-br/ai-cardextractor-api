import type { Request, Response } from 'express'
import { sendSuccess } from '../../helpers/apiResponse.ts'
import ModelService from './modelService.ts'

export default class ModelController {
  static async list(_req: Request, res: Response): Promise<void> {
    sendSuccess(res, { models: await ModelService.list() })
  }

  static async load(req: Request, res: Response): Promise<void> {
    const model = await ModelService.load(String(req.params['modelId'] ?? ''))
    sendSuccess(res, { model })
  }

  static async unload(req: Request, res: Response): Promise<void> {
    const result = await ModelService.unload(String(req.params['modelId'] ?? ''))
    sendSuccess(res, result)
  }
}
