import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { env } from '../../config/env.ts'

// ============================================================================
// Identidade estável do worker.
//
// O PLAN2 exige `workerId` estável, separado de DNS/IP. Env não é persistência:
// um uuid novo a cada boot órfã jobs/reservas (`workerId` muda), então o id é
// gravado em arquivo (default `.data/worker-id`).
//
// Falha de leitura/gravação é fail-closed quando o estado é publicado no Mongo:
// melhor não subir do que entrar no pool com identidade efêmera.
// ============================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

let cached: string | null = null

function invalid(file: string, detail: string): Error {
  return new Error(`EXTRACTOR_WORKER_ID inválido em ${file}: ${detail}`)
}

export interface WorkerIdOptions {
  id?: string
  file?: string
  stateMode?: string
}

export function loadWorkerId(options: WorkerIdOptions = {}): string {
  if (cached && options.id === undefined && options.file === undefined) return cached

  const stateMode = options.stateMode ?? env.EXTRACTOR_STATE_MODE
  const fromEnv = (options.id ?? env.EXTRACTOR_WORKER_ID).trim()
  if (fromEnv !== '') {
    if (!UUID_RE.test(fromEnv)) throw new Error('EXTRACTOR_WORKER_ID deve ser um UUID válido')
    cached = fromEnv.toLowerCase()
    return cached
  }

  const file = (options.file ?? env.EXTRACTOR_WORKER_ID_FILE).trim()
  if (file === '') {
    if (stateMode === 'mongo') {
      throw new Error('EXTRACTOR_WORKER_ID_FILE é obrigatório com EXTRACTOR_STATE_MODE=mongo')
    }
    cached = randomUUID()
    return cached
  }

  const resolved = path.resolve(file)
  let existing = ''
  try {
    existing = readFileSync(resolved, 'utf8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `não foi possível ler ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (existing !== '') {
    if (!UUID_RE.test(existing)) throw invalid(resolved, 'conteúdo não é um UUID')
    cached = existing.toLowerCase()
    return cached
  }

  const id = randomUUID()
  try {
    mkdirSync(path.dirname(resolved), { recursive: true })
    writeFileSync(resolved, `${id}\n`, { mode: 0o600 })
  } catch (error) {
    throw new Error(
      `não foi possível gravar o workerId em ${resolved}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  cached = id
  return cached
}

/** Só para testes: permite trocar env/arquivo entre casos. */
export function resetWorkerIdForTests(): void {
  cached = null
}
