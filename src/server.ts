import './config/timezone.ts'
import http from 'node:http'
import { createApp } from './app.ts'
import { aiConfigSource, env, isProductionEnvironment } from './config/env.ts'
import { validateConfig } from './config/validate.ts'
import { connectDB, disconnectDB } from './providers/mongoose.ts'
import { closePersistence } from './providers/persistence/index.ts'
import { disposeProviders } from './providers/llm/index.ts'
import { disposeCatalogProviders } from './providers/llm/catalogProvider.ts'
import { bootstrapAiConfig, startHeartbeat, stopHeartbeat } from './modules/heartbeat/heartbeatService.ts'
import { startAiConfigPoll, stopAiConfigPoll } from './modules/aiConfig/mongoConfigSource.ts'
import { startExtractorState, stopExtractorState } from './modules/extractorState/extractorStateService.ts'

// Fail-closed: fora de dev/teste, sem chave interna o servico nao sobe.
if (isProductionEnvironment() && env.AI_INTERNAL_KEY === '') {
  console.error('[Server] AI_INTERNAL_KEY ausente em producao — recusando subir sem autenticacao interna.')
  process.exit(1)
}

// `fake` em producao devolveria decisoes plausiveis sem modelo real. Com a
// config vinda do painel/central o provider fisico vem de lá; o `fake` do .env
// é apenas placeholder do catálogo legado e não atende request nenhum.
if (isProductionEnvironment() && env.LLM_PROVIDER === 'fake' && aiConfigSource() === 'env') {
  console.error('[Server] LLM_PROVIDER=fake nao e permitido em producao (config de IA vinda do .env).')
  process.exit(1)
}

// A chave do painel é cifrada pela API com CREDENTIALS_ENC_KEY: sem ela o
// extractor não consegue decifrar a API key e a IA ficaria indisponível.
if (
  isProductionEnvironment() &&
  aiConfigSource() === 'mongo' &&
  env.CREDENTIALS_ENC_KEY.length < 16
) {
  console.error(
    '[Server] CREDENTIALS_ENC_KEY ausente/curta em producao — deve ser a MESMA chave (16+ chars) usada pela API central.',
  )
  process.exit(1)
}

if (
  env.EXTRACTOR_STATE_MODE === 'mongo' &&
  env.EXTRACTOR_DNS === ''
) {
  console.error('[Server] EXTRACTOR_STATE_MODE=mongo exige EXTRACTOR_DNS (identidade da instancia no pool).')
  process.exit(1)
}

const needsMongo =
  env.AI_PERSISTENCE === 'mongo' ||
  env.EXTRACTOR_STATE_MODE === 'mongo' ||
  aiConfigSource() === 'mongo'
if (
  needsMongo &&
  env.MONGO_URI === '' &&
  (env.MONGO_URL === '' || env.MONGO_USER === '' || env.MONGO_PASSWORD === '')
) {
  console.error(
    '[Server] Mongo obrigatorio (persistencia/estado/config) sem MONGO_URI nem MONGO_USER/MONGO_PASSWORD/MONGO_URL.',
  )
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
      stopExtractorState(),
      stopAiConfigPoll(),
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
    server.listen(env.PORT, env.HOST, async () => {
      console.log(`[Server] ai-extractor-api on http://${env.HOST}:${env.PORT} (pid ${process.pid})`)
      console.log(
        `[Server] provider=${env.LLM_PROVIDER} model=${env.AI_MODEL_ID} persistence=${env.AI_PERSISTENCE} state=${env.EXTRACTOR_STATE_MODE} aiConfig=${aiConfigSource()}`,
      )
      if (aiConfigSource() === 'mongo') {
        startAiConfigPoll()
      } else {
        await bootstrapAiConfig()
      }
      if (env.EXTRACTOR_STATE_MODE === 'mongo') {
        startExtractorState()
      } else {
        startHeartbeat()
      }
    })
  })
  .catch((error) => {
    console.error('[Server] Falha ao inicializar:', error instanceof Error ? error.message : error)
    process.exit(1)
  })

export default app
