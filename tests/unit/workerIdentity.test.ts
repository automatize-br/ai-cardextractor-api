import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { SUPPORTED_PLATFORMS, coreMajorOf, workerCapabilities } from '../../src/config/version.ts'
import { loadWorkerId, resetWorkerIdForTests } from '../../src/modules/extractorState/workerIdentity.ts'

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'worker-id-'))
}

function reset(): void {
  resetWorkerIdForTests()
}

test('workerId de env é validado e reaproveitado', () => {
  reset()
  const id = '11111111-1111-4111-8111-111111111111'
  assert.equal(loadWorkerId({ id, file: '', stateMode: 'memory' }), id)
  reset()
  assert.throws(() => loadWorkerId({ id: 'nao-e-uuid', file: '', stateMode: 'memory' }), /UUID válido/)
})

test('workerId é criado no arquivo e permanece estável entre reinícios', () => {
  reset()
  const file = path.join(tempDir(), 'worker-id')
  const first = loadWorkerId({ id: '', file, stateMode: 'mongo' })
  assert.match(first, /^[0-9a-f-]{36}$/)
  assert.equal(readFileSync(file, 'utf8').trim(), first)

  reset()
  const second = loadWorkerId({ id: '', file, stateMode: 'mongo' })
  assert.equal(second, first)
})

test('arquivo com conteúdo inválido é fail-closed (não gera id novo)', () => {
  reset()
  const file = path.join(tempDir(), 'worker-id')
  writeFileSync(file, 'lixo\n')
  assert.throws(() => loadWorkerId({ id: '', file, stateMode: 'mongo' }), /não é um UUID/)
})

test('modo mongo sem arquivo e sem env é fail-closed', () => {
  reset()
  assert.throws(
    () => loadWorkerId({ id: '', file: '', stateMode: 'mongo' }),
    /EXTRACTOR_WORKER_ID_FILE é obrigatório/,
  )
})

test('modo não-mongo pode usar id efêmero (dev/teste)', () => {
  reset()
  const id = loadWorkerId({ id: '', file: '', stateMode: 'memory' })
  assert.match(id, /^[0-9a-f-]{36}$/)
})

test('capability exclui plataformas que exigem browser quando ele está desligado', () => {
  const all = [...SUPPORTED_PLATFORMS]
  const semBrowser = workerCapabilities(all, false)
  assert.equal(semBrowser.includes('shopee'), false)
  assert.equal(semBrowser.includes('mercadolivre'), true)

  const comBrowser = workerCapabilities(all, true)
  assert.equal(comBrowser.includes('shopee'), true)
})

test('workerCapabilities normaliza, deduplica e ignora vazios', () => {
  const caps = workerCapabilities([' MercadoLivre ', 'mercadolivre', '', 'amazon'], false)
  assert.deepEqual(caps, ['mercadolivre', 'amazon'])
})

test('coreMajor é derivado do coreVersion (não comparação literal)', () => {
  assert.equal(coreMajorOf('offer-extract-core@1.2.0'), 1)
  assert.equal(coreMajorOf('offer-extract-core@2'), 2)
  assert.equal(coreMajorOf('dev'), 1)
})
