import { Schema } from 'mongoose'
import mongoose from '../../providers/mongoose.ts'

// Contadores diarios agregados (sem dados de oferta). Serve /stats e alertas.
const tb_aiUsage = mongoose.model(
  'tb_aiUsage',
  new Schema(
    {
      day: { type: String, required: true, unique: true },
      total: { type: Number, default: 0 },
      llm: { type: Number, default: 0 },
      heuristic: { type: Number, default: 0 },
      fallback: { type: Number, default: 0 },
      modelCalls: { type: Number, default: 0 },
      totalLatencyMs: { type: Number, default: 0 },
      validationFailures: { type: Number, default: 0 },
    },
    { timestamps: true },
  ),
)

export default tb_aiUsage
