import { Schema } from 'mongoose'
import mongoose from '../../providers/mongoose.ts'

// Catalogo/estado dos modelos conhecidos pelo servico. A configuracao base vem
// de env; este registro guarda o ciclo de vida (loaded/unloaded/error) e a
// versao efetivamente usada nas adjudicacoes.
const tb_aiModels = mongoose.model(
  'tb_aiModels',
  new Schema(
    {
      modelId: { type: String, required: true, unique: true },
      provider: { type: String, enum: ['fake', 'llamacpp', 'http'], required: true },
      path: { type: String, default: '' },
      contextSize: { type: Number, default: 2048 },
      version: { type: String, default: '' },
      status: { type: String, enum: ['unloaded', 'loading', 'loaded', 'error'], default: 'unloaded' },
      loadedAt: { type: Date, default: null },
      lastError: { type: String, default: null },
    },
    { timestamps: true },
  ),
)

tb_aiModels.schema.index({ status: 1 })

export default tb_aiModels
