import { Schema } from 'mongoose'
import mongoose from '../../providers/mongoose.ts'
import { v4 as uuidv4 } from 'uuid'

// Auditoria de cada adjudicacao. NAO guarda titulo/preco/link por padrao
// (privacidade); o pack completo so e persistido com AI_STORE_PACKS=true.
const tb_aiAdjudications = mongoose.model(
  'tb_aiAdjudications',
  new Schema(
    {
      adjudicationId: {
        type: String,
        required: true,
        unique: true,
        default: () => uuidv4() as string,
      },
      packHash: { type: String, required: true },
      packVersion: { type: String, required: true },
      marketplace: { type: String, required: true },
      mode: { type: String, enum: ['llm', 'heuristic', 'fake', 'fallback'], required: true },
      modelId: { type: String, default: null },
      modelVersion: { type: String, default: null },
      promptVersion: { type: String, required: true },
      latencyMs: { type: Number, default: 0 },
      cards: { type: Number, default: 0 },
      decisions: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
      validationFailures: { type: Number, default: 0 },
      modelCalls: { type: Number, default: 0 },
      shadow: { type: Schema.Types.Mixed, default: null },
      fallbackReason: { type: String, default: null },
      pack: { type: Schema.Types.Mixed, default: null },
    },
    { timestamps: true },
  ),
)

tb_aiAdjudications.schema.index({ packHash: 1, createdAt: -1 })
tb_aiAdjudications.schema.index({ createdAt: -1 })
tb_aiAdjudications.schema.index({ marketplace: 1, createdAt: -1 })

export default tb_aiAdjudications
