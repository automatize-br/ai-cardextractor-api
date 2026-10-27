import './config/timezone.ts'
import http from 'node:http'
import { createApp } from './app.ts'
import { env, isProductionEnvironment } from './config/env.ts'
import { validateConfig } from './config/validate.ts'
import { connectDB, disconnectDB } from './providers/mongoose.ts'
import { closePersistence } from './providers/persistence/index.ts'
import { disposeProviders } from './providers/llm/index.ts'
import { disposeCatalogProviders } from './providers/llm/catalogProvider.ts'
import { startHeartbeat, stopHeartbeat } from './modules/heartbeat/heartbeatService.ts'

// Fail-closed: fora de dev/teste, sem chave interna o servico nao sobe.
if (isProductionEnvironment() && env.AI_INTERNAL_KEY === '') {
  console.error('[Server] AI_INTERNAL_KEY ausente em producao — recusando subir sem autenticacao interna.')
  process.exit(1)
}

// `fake` em producao devolveria decisoes plausiveis sem modelo real: falha silenciosa.
if (isProductionEnvironment() && env.LLM_PROVIDER === 'fake') {
  console.error('[Server] LLM_PROVIDER=fake nao e permitido em producao.')
  process.exit(1)
}

if (
  env.AI_PERSISTENCE === 'mongo' &&
  env.MONGO_URI === '' &&
  (env.MONGO_URL === '' || env.MONGO_USER === '' || env.MONGO_PASSWORD === '')
) {
  console.error('[Server] AI_PERSISTENCE=mongo sem MONGO_URI nem MONGO_USER/MONGO_PASSWORD/MONGO_URL.')
  process.exit(1)
}

try {
  validateConfig()
} catch (error) {
  console.error('[Server] Configuração inválida:', error instanceof Error ? error.message : error)
  process.exit(1)
}

process.on('unhandledRejection', (reason) => {
  console.error('[Process] unhandledRejection:', reason)
})
process.on('uncaughtException', (error) => {
  console.error('[Process] uncaughtException:', error)
  process.exit(1)
})

const app = createApp()
const server = http.createServer(app)

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[Server] Porta ${env.PORT} ja esta em uso (HOST=${env.HOST}).`)
    console.error('[Server] Libere com "npm run dev:free-port" e suba novamente.')
  } else {
    console.error('[Server] Erro no servidor HTTP:', error)
  }
  process.exit(1)
})

let shuttingDown = false
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[Server] ${signal} recebido — encerrando...`)
  server.close(() => {
    void Promise.allSettled([
      stopHeartbeat(),
      disposeProviders(),
      disposeCatalogProviders(),
      closePersistence(),
      disconnectDB(),
    ]).finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(0), 8_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

connectDB()
  .then(() => {
    server.listen(env.PORT, env.HOST, () => {
      console.log(`[Server] ai-extractor-api on http://${env.HOST}:${env.PORT} (pid ${process.pid})`)
      console.log(
        `[Server] provider=${env.LLM_PROVIDER} model=${env.AI_MODEL_ID} persistence=${env.AI_PERSISTENCE} mode=${env.AI_ADJ_MODE}`,
      )
      startHeartbeat()
    })
  })
  .catch((error) => {
    console.error('[Server] Falha ao inicializar:', error instanceof Error ? error.message : error)
    process.exit(1)
  })

export default app
