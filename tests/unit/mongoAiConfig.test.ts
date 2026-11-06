import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { test } from 'node:test'
import { decryptSecretWithKey } from '../../src/modules/aiConfig/decrypt.ts'
import { buildRuntimeConfig } from '../../src/modules/aiConfig/mongoConfigSource.ts'

// Reproduz o formato gravado pela API (AES-256-GCM + SHA-256 da chave).
function encrypt(plaintext: string, credentialsKey: string): string {
  const key = crypto.createHash('sha256').update(credentialsKey).digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`
}

const KEY = 'chave-de-teste-com-32-caracteres!!'

test('decifra a API key no mesmo formato da API central', () => {
  const payload = encrypt('oc_sk_teste_1234', KEY)
  assert.equal(decryptSecretWithKey(payload, KEY), 'oc_sk_teste_1234')
})

test('chave errada falha (fail-closed) em vez de devolver lixo', () => {
  const payload = encrypt('oc_sk_teste_1234', KEY)
  assert.throws(() => decryptSecretWithKey(payload, 'outra-chave-qualquer-123'), /decifrar/)
})

test('payload adulterado é rejeitado pelo authTag', () => {
  const parts = encrypt('segredo', KEY).split(':')
  const tampered = `v1:${parts[1]}:${parts[2]}:${Buffer.from('outro').toString('base64')}`
  assert.throws(() => decryptSecretWithKey(tampered, KEY), /decifrar/)
})

test('documento do painel vira a config runtime esperada pelo extractor', () => {
  const config = buildRuntimeConfig(
    {
      configId: 'default',
      enabled: true,
      mode: 'assist',
      provider: 'openai-compatible',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      model: 'deepseek-v4.1-flash',
      encryptedApiKey: encrypt('oc_sk_abc', KEY),
      temperature: 0.2,
      maxTokens: 1200,
      timeoutMs: 45000,
      structuredOutput: 'json_schema',
      version: 9,
    },
    (payload) => decryptSecretWithKey(payload, KEY),
  )
  assert.equal(config.contractVersion, '1')
  assert.equal(config.version, 9)
  assert.equal(config.enabled, true)
  assert.equal(config.mode, 'assist')
  assert.equal(config.provider, 'openai-compatible')
  assert.equal(config.model, 'deepseek-v4.1-flash')
  assert.equal(config.apiKey, 'oc_sk_abc')
  assert.equal(config.temperature, 0.2)
  assert.equal(config.maxTokens, 1200)
  assert.equal(config.timeoutMs, 45000)
})

test('config desabilitada no painel não exige chave e mantém IA desligada', () => {
  const config = buildRuntimeConfig(
    { configId: 'default', enabled: false, mode: 'on', provider: 'fake', version: 3 },
    () => {
      throw new Error('não deveria decifrar sem chave')
    },
  )
  assert.equal(config.enabled, false)
  assert.equal(config.apiKey, null)
  assert.equal(config.provider, 'fake')
  assert.equal(config.version, 3)
})
