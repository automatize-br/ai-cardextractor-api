#!/usr/bin/env node
// Libera a porta do servico antes do `dev` (evita rodar codigo velho por um
// processo orfao). Le PORT do ambiente ou do .env; default 5555.

import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

function readPort() {
  if (process.env.PORT) return Number(process.env.PORT)
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = /^\s*PORT\s*=\s*(\d+)\s*$/.exec(line)
      if (match) return Number(match[1])
    }
  }
  return 5555
}

const port = readPort()
if (!Number.isInteger(port) || port <= 0) {
  console.error(`[free-port] PORT invalida: ${port}`)
  process.exit(0)
}

try {
  if (process.platform === 'win32') {
    const output = execSync(`netstat -ano -p tcp | findstr :${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const pids = new Set()
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue
      const parts = line.trim().split(/\s+/)
      const pid = Number(parts[parts.length - 1])
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid)
    }
    for (const pid of pids) {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
      console.log(`[free-port] processo ${pid} encerrado (porta ${port})`)
    }
  } else {
    const pids = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (pids) {
      execSync(`kill -9 ${pids.split(/\s+/).join(' ')}`, { stdio: 'ignore' })
      console.log(`[free-port] processo(s) ${pids} encerrado(s) (porta ${port})`)
    }
  }
} catch {
  // Porta livre (ou ferramenta ausente) — segue o boot.
}
