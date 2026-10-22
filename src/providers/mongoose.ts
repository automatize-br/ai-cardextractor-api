import mongoose from 'mongoose'
import { env } from '../config/env.ts'

// ============================================================================
// Conexao Mongo OPCIONAL. O servico funciona em `AI_PERSISTENCE=memory`
// (default), sem banco. Em `mongo`, a URI pode vir pronta (MONGO_URI) ou ser
// composta no formato Atlas (MONGO_USER/MONGO_PASSWORD/MONGO_URL).
// Nenhuma credencial e logada.
// ============================================================================

export function buildMongoUri(): string | null {
  if (env.MONGO_URI !== '') return env.MONGO_URI
  if (env.MONGO_USER === '' || env.MONGO_PASSWORD === '' || env.MONGO_URL === '') return null
  const user = encodeURIComponent(env.MONGO_USER)
  const password = encodeURIComponent(env.MONGO_PASSWORD)
  const database = env.MONGO_ENVIRONMENT || 'dev'
  return `mongodb+srv://${user}:${password}@${env.MONGO_URL}/${database}?appName=Cluster0`
}

export async function connectDB(): Promise<boolean> {
  if (env.AI_PERSISTENCE !== 'mongo') return false
  const uri = buildMongoUri()
  if (!uri) {
    throw new Error('AI_PERSISTENCE=mongo requires MONGO_URI or MONGO_USER/MONGO_PASSWORD/MONGO_URL')
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
