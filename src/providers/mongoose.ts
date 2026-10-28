import mongoose from 'mongoose'
import { env, mongoRequired } from '../config/env.ts'

// ============================================================================
// Conexao Mongo OPCIONAL. O servico funciona em `AI_PERSISTENCE=memory`
// (default), sem banco. A conexao e aberta quando QUALQUER recurso precisa do
// banco:
//   - AI_PERSISTENCE=mongo  -> packs/uso da IA
//   - EXTRACTOR_STATE_MODE=mongo -> estado do pool (cada extractor grava o seu)
//   - AI_CONFIG_SOURCE=mongo -> config de IA lida de tb_aiextractorconfigs
// A URI pode vir pronta (MONGO_URI) ou ser composta no formato Atlas
// (MONGO_USER/MONGO_PASSWORD/MONGO_URL). Nenhuma credencial e logada.
// ============================================================================

export function buildMongoUri(): string | null {
  if (env.MONGO_URI !== '') return env.MONGO_URI
  if (env.MONGO_USER === '' || env.MONGO_PASSWORD === '' || env.MONGO_URL === '') return null
  const user = encodeURIComponent(env.MONGO_USER)
  const password = encodeURIComponent(env.MONGO_PASSWORD)
  const database = env.MONGO_ENVIRONMENT || 'dev'
  return `mongodb+srv://${user}:${password}@${env.MONGO_URL}/${database}?appName=Cluster0`
}

/** true quando alguma feature habilitada exige o banco. */
export function mongoNeeded(): boolean {
  return mongoRequired()
}

export async function connectDB(): Promise<boolean> {
  if (!mongoRequired()) return false
  const uri = buildMongoUri()
  if (!uri) {
    throw new Error(
      'MongoDB é obrigatório (AI_PERSISTENCE=mongo ou EXTRACTOR_STATE_MODE=mongo ou AI_CONFIG_SOURCE=mongo) ' +
        'mas MONGO_URI nem MONGO_USER/MONGO_PASSWORD/MONGO_URL foram informados',
    )
  }
  await mongoose.connect(uri)
  console.log('[mongo] connected')
  return true
}

export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState === 0) return
  await mongoose.connection.close()
}

export { mongoose }
export default mongoose
