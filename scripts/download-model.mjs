#!/usr/bin/env node
// Baixa o modelo base GGUF (Qwen2.5-0.5B-Instruct Q4_K_M) para src/models.
// Idempotente: se o arquivo final ja existe, nao baixa de novo.
// Overrides: MODEL_URL, MODEL_FILE.

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DEFAULT_URL =
  'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf?download=true'
const DEFAULT_FILE = 'src/models/qwen2.5-0.5b-instruct-q4_k_m.gguf'

const url = process.env.MODEL_URL || DEFAULT_URL
const target = resolve(process.env.MODEL_FILE || DEFAULT_FILE)
const partial = `${target}.part`

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

if (existsSync(target)) {
  console.log(`[model] ja existe: ${target} (${human(statSync(target).size)})`)
  process.exit(0)
}

mkdirSync(dirname(target), { recursive: true })

console.log(`[model] baixando ${url}`)
console.log(`[model] destino ${target}`)

const response = await fetch(url, { redirect: 'follow' })
if (!response.ok || !response.body) {
  console.error(`[model] falha HTTP ${response.status}`)
  process.exit(1)
}

const total = Number(response.headers.get('content-length') || 0)
let received = 0
let lastLog = Date.now()

const body = Readable.fromWeb(response.body)
body.on('data', (chunk) => {
  received += chunk.length
  if (Date.now() - lastLog > 1000) {
    lastLog = Date.now()
    const percent = total > 0 ? `${((received / total) * 100).toFixed(1)}%` : `${human(received)}`
    process.stdout.write(`\r[model] ${percent}`)
  }
})

try {
  await pipeline(body, createWriteStream(partial))
  renameSync(partial, target)
  process.stdout.write('\n')
  console.log(`[model] concluido: ${target} (${human(statSync(target).size)})`)
} catch (error) {
  rmSync(partial, { force: true })
  console.error(`\n[model] erro: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
