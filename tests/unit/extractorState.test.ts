import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStateFields, nextSaturated, normalizeExtractorDns } from '../../src/modules/extractorState/stateDocument.ts'

const baseInput = {
  workerId: '11111111-1111-4111-8111-111111111111',
  dns: 'extractor-1.example.com',
  host: 'extractor-1.example.com',
  bootId: 'boot-1',
  seq: 7,
  version: 'prod-1',
  contractVersion: '1',
  offersContractVersion: '2',
  coreVersion: 'offer-extract-core@prod-1',
  coreMajor: 1,
  trimmerVersion: 'trim@1',
  platforms: ['mercadolivre'],
  capabilities: ['mercadolivre'],
  capacity: 2,
  use: 12.5,
  useRaw: 14.2,
  cpuMetricSupported: true,
  reportedInflight: 1,
  activeJobs: 1,
  memoryAvailableMb: 512,
  observedStatus: 'online' as const,
  now: new Date('2026-10-28T12:00:00.000Z'),
}

const thresholds = { busy: 75, resume: 60 }

test('estado publicado tem os campos que o scheduler da API lê', () => {
  const fields = buildStateFields(baseInput, null, thresholds)
  assert.equal(fields.workerId, baseInput.workerId)
  assert.equal(fields.dns, 'extractor-1.example.com')
  assert.equal(fields.host, 'extractor-1.example.com')
  assert.equal(fields.use, 12.5)
  assert.equal(fields.useRaw, 14.2)
  assert.equal(fields.cpuMetricSupported, true)
  assert.equal(fields.reportedInflight, 1)
  assert.equal(fields.activeJobs, 1)
  assert.equal(fields.capacity, 2)
  assert.equal(fields.offersContractVersion, '2')
  assert.equal(fields.coreMajor, 1)
  assert.deepEqual(fields.capabilities, ['mercadolivre'])
  assert.equal(fields.observedStatus, 'online')
  assert.equal(fields.contractVersion, '1')
  assert.equal(fields.lastSeq, 7)
  assert.equal(fields.lastSeenAt.toISOString(), '2026-10-28T12:00:00.000Z')
  assert.equal(fields.lastHeartbeatAt.toISOString(), '2026-10-28T12:00:00.000Z')
  // `reserved` é da API; o extractor nunca o sobrescreve. `status`/`desiredStatus`
  // são do admin/reaper — o worker não escreve estado desejado.
  assert.equal('reserved' in fields, false)
  assert.equal('status' in fields, false)
  assert.equal('desiredStatus' in fields, false)
})

test('histerese de saturação: liga em 75, só desliga em 60', () => {
  assert.equal(nextSaturated(75, false, thresholds.busy, thresholds.resume), true)
  assert.equal(nextSaturated(90, null, thresholds.busy, thresholds.resume), true)
  assert.equal(nextSaturated(70, true, thresholds.busy, thresholds.resume), true)
  assert.equal(nextSaturated(70, false, thresholds.busy, thresholds.resume), false)
  assert.equal(nextSaturated(60, true, thresholds.busy, thresholds.resume), false)
  assert.equal(nextSaturated(10, true, thresholds.busy, thresholds.resume), false)
})

test('campos numéricos são normalizados para a faixa aceita pela API', () => {
  const fields = buildStateFields(
    { ...baseInput, use: 130, useRaw: -4, reportedInflight: -1, activeJobs: -2, capacity: 0 },
    null,
    thresholds,
  )
  assert.equal(fields.use, 100)
  assert.equal(fields.useRaw, 0)
  assert.equal(fields.reportedInflight, 0)
  assert.equal(fields.activeJobs, 0)
  assert.equal(fields.capacity, 1)
})

test('shutdown publica observedStatus=draining (dica); desiredStatus nunca é escrito', () => {
  const fields = buildStateFields({ ...baseInput, observedStatus: 'draining' }, null, thresholds)
  assert.equal(fields.observedStatus, 'draining')
  assert.equal('desiredStatus' in fields, false)
})

test('dns é normalizado igual à API (sem esquema/barra/ponto final)', () => {
  assert.equal(normalizeExtractorDns(' HTTPS://Api-Scrapping.Vupia.com.br./ '), 'api-scrapping.vupia.com.br')
  assert.equal(normalizeExtractorDns('api-scrapping.vupia.com.br'), 'api-scrapping.vupia.com.br')
  assert.equal(normalizeExtractorDns('127.0.0.1:5555/'), '127.0.0.1:5555')
})
