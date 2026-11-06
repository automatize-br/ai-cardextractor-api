import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyAiConfig } from '../../src/modules/aiConfig/apply.ts'
import {
  getRuntimeAiConfig,
  resetRuntimeAiConfigForTests,
  runtimeAiEnabled,
  runtimeModel,
} from '../../src/modules/aiConfig/runtimeConfig.ts'
import { getModel } from '../../src/config/models.ts'
import { getProfile } from '../../src/config/profiles.ts'

const base = {
  contractVersion: '1',
  configId: 'default',
  version: 1,
  enabled: true,
  mode: 'assist',
  provider: 'fake',
  baseUrl: '',
  model: 'fake',
  apiKey: null,
  temperature: 0.2,
  maxTokens: 600,
  timeoutMs: 5000,
  structuredOutput: 'json_schema',
}

test('config dinâmica aplica modelo fast e habilita IA sem reiniciar', () => {
  resetRuntimeAiConfigForTests()
  assert.equal(runtimeAiEnabled(), false)
  // Placeholder existe para os perfis carregarem mesmo sem config.
  assert.equal(runtimeModel().id, 'fast')
  assert.ok(getProfile('cards') !== null)

  const applied = applyAiConfig(base)
  assert.equal(applied.applied, true)
  assert.equal(runtimeAiEnabled(), true)
  assert.equal(getRuntimeAiConfig()?.mode, 'assist')
  const model = getModel('fast')
  assert.equal(model?.id, 'fast')
  assert.equal(model?.provider, 'fake')
  assert.equal(model?.model, 'fake')
})

test('config inválida não derruba a atual', () => {
  applyAiConfig(base)
  const applied = applyAiConfig({ contractVersion: '1', provider: 'openai-compatible' })
  assert.equal(applied.applied, false)
  assert.equal(getRuntimeAiConfig()?.version, 1)
})

test('enabled=false mantém a config mas desliga a IA', () => {
  applyAiConfig({ ...base, version: 2, enabled: false })
  assert.equal(runtimeAiEnabled(), false)
  assert.equal(getRuntimeAiConfig()?.version, 2)
  resetRuntimeAiConfigForTests()
})
