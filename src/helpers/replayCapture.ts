import { appendFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { env } from '../config/env.ts'
import type { ReplayRecord } from '../types/replay.ts'

// ============================================================================
// Captura de replay em JSONL (F6) — OPT-IN via AI_REPLAY_PATH.
//
// Contém o pack completo (títulos/imagens/preços da loja). Nunca ligue em
// produção sem política de retenção: o arquivo é a base do dataset de treino.
// Falha de captura é best-effort e nunca quebra a adjudicação.
// ============================================================================

let warnedFull = false

export async function captureReplay(record: ReplayRecord): Promise<void> {
  const path = env.AI_REPLAY_PATH.trim()
  if (path === '') return
  try {
    await mkdir(dirname(path), { recursive: true })
    if (env.AI_REPLAY_MAX_BYTES > 0) {
      const size = await stat(path).then((info) => info.size).catch(() => 0)
      if (size >= env.AI_REPLAY_MAX_BYTES) {
        if (!warnedFull) {
          console.warn(`[replay] ${path} atingiu AI_REPLAY_MAX_BYTES — captura pausada.`)
          warnedFull = true
        }
        return
      }
    }
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
  } catch (error) {
    console.error('[replay] capture failed:', error instanceof Error ? error.message : error)
  }
}
