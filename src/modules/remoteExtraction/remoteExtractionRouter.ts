import express from 'express'
import { internalAuthMiddleware } from '../../middleware/internalAuth.middleware.ts'
import RemoteExtractionController from './remoteExtractionController.ts'

const router = express.Router()

// Contrato v2: o extractor busca a página, extrai e revalida. Corpo JSON pequeno
// (URLs/parâmetros); o HTML nunca trafega. O `express.json` global do app já
// parseou o corpo (limite 1 MB).
router.post('/extract-offers', internalAuthMiddleware, RemoteExtractionController.extractOffers)

export default router
