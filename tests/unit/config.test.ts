import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { afterEach, test } from 'node:test'
import { listModels, resetModelsForTests } from '../../src/config/models.ts'
import { getProfile, listProfiles, resetProfilesForTests } from '../../src/config/profiles.ts'
import { validateJson } from '../../src/config/schema.ts'
import { makeProfile } from '../profileFixture.ts'

const ORIGINAL_PROFILES = process.env['AI_PROFILES_JSON']
const ORIGINAL_PROFILES_B64 = process.env['AI_PROFILES_B64']
const ORIGINAL_MODELS = process.env['AI_MODELS_JSON']

afterEach(() => {
  if (ORIGINAL_PROFILES === undefined) delete process.env['AI_PROFILES_JSON']
  else process.env['AI_PROFILES_JSON'] = ORIGINAL_PROFILES
  if (ORIGINAL_PROFILES_B64 === undefined) delete process.env['AI_PROFILES_B64']
  else process.env['AI_PROFILES_B64'] = ORIGINAL_PROFILES_B64
  if (ORIGINAL_MODELS === undefined) delete process.env['AI_MODELS_JSON']
  else process.env['AI_MODELS_JSON'] = ORIGINAL_MODELS
  resetProfilesForTests()
  resetModelsForTests()
})

test('carrega perfil válido do .env e calcula hashes estáveis', () => {
  process.env['AI_PROFILES_JSON'] = JSON.stringify([makeProfile()])
  const first = listProfiles()
  assert.equal(first.length, 1)
  assert.equal(first[0]?.profile.id, 'test-profile')
  assert.match(first[0]?.profileHash ?? '', /^[a-f0-9]{64}$/)
  assert.match(first[0]?.promptHash ?? '', /^[a-f0-9]{64}$/)
  assert.match(first[0]?.schemaHash ?? '', /^[a-f0-9]{64}$/)

  const second = listProfiles()
  assert.equal(second[0]?.profileHash, first[0]?.profileHash)
  assert.equal(second[0]?.promptHash, first[0]?.promptHash)
})

test('aceita AI_PROFILES_B64', () => {
  const json = JSON.stringify([makeProfile({ id: 'b64-profile' })])
  process.env['AI_PROFILES_JSON'] = ''
  process.env['AI_PROFILES_B64'] = Buffer.from(json, 'utf8').toString('base64')
  const profiles = listProfiles()
  assert.equal(profiles[0]?.profile.id, 'b64-profile')
})

test('rejeita output.schema sem additionalProperties:false', () => {
  const profile = makeProfile()
  profile.output.schema = { type: 'object', properties: {} }
  process.env['AI_PROFILES_JSON'] = JSON.stringify([profile])
  assert.throws(() => listProfiles(), /additionalProperties:false/)
})

test('rejeita placeholder desconhecido no prompt', () => {
  const profile = makeProfile()
  profile.prompt.userTemplate = '<INPUT>{{input}}</INPUT>{{segredo}}'
  process.env['AI_PROFILES_JSON'] = JSON.stringify([profile])
  assert.throws(() => listProfiles(), /unknown prompt placeholder/)
})

test('rejeita perfil duplicado', () => {
  process.env['AI_PROFILES_JSON'] = JSON.stringify([makeProfile(), makeProfile()])
  assert.throws(() => listProfiles(), /duplicate profile id/)
})

test('rejeita modelo inexistente no catálogo', () => {
  process.env['AI_PROFILES_JSON'] = JSON.stringify([
    makeProfile({ model: { ...makeProfile().model, id: 'nao-existe' } }),
  ])
  assert.throws(() => listProfiles(), /not found in AI_MODELS_JSON/)
})

test('lê catálogo v2 e rejeita formato antigo', () => {
  process.env['AI_MODELS_JSON'] = JSON.stringify([
    {
      id: 'remote',
      version: 'remote@1',
      provider: 'openai',
      model: 'gpt-test',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      structuredOutput: 'json_schema',
      promptCaching: 'auto',
    },
  ])
  resetModelsForTests()
  const models = listModels()
  assert.equal(models[0]?.id, 'remote')
  assert.match(models[0]?.modelHash ?? '', /^[a-f0-9]{64}$/)

  process.env['AI_MODELS_JSON'] = JSON.stringify([{ id: 'old', path: 'src/LLMS/x.gguf', contextSize: 2048 }])
  resetModelsForTests()
  assert.throws(() => listModels(), /formato antigo/)
})

test('rejeita apiKeyEnv vazio em provider remoto', () => {
  process.env['AI_MODELS_JSON'] = JSON.stringify([
    {
      id: 'remote',
      version: 'remote@1',
      provider: 'openai',
      model: 'gpt-test',
      baseUrl: 'https://example.com/v1',
      apiKeyEnv: '',
    },
  ])
  resetModelsForTests()
  assert.throws(() => listModels(), /apiKeyEnv is required/)
})

test('permite apiKeyEnv vazio em openai-compatible loopback', () => {
  process.env['AI_MODELS_JSON'] = JSON.stringify([
    {
      id: 'local',
      version: 'local@1',
      provider: 'openai-compatible',
      model: 'qwen',
      baseUrl: 'http://127.0.0.1:8080/v1',
      apiKeyEnv: '',
    },
  ])
  resetModelsForTests()
  const models = listModels()
  assert.equal(models[0]?.id, 'local')
})

test('getProfile encontra perfil configurado', () => {
  process.env['AI_PROFILES_JSON'] = JSON.stringify([makeProfile({ id: 'cards' })])
  assert.equal(getProfile('cards')?.profile.id, 'cards')
  assert.equal(getProfile('missing'), null)
})

test('profiles/cards.json é um exemplo válido', () => {
  const profiles = readFileSync('profiles/cards.json', 'utf8')
  process.env['AI_PROFILES_JSON'] = JSON.stringify([JSON.parse(profiles)])
  process.env['AI_MODELS_JSON'] = JSON.stringify([
    {
      id: 'fast',
      version: 'fast@1',
      provider: 'fake',
      model: 'fake',
      baseUrl: '',
      apiKeyEnv: '',
      structuredOutput: 'json_schema',
      promptCaching: 'off',
    },
  ])
  resetProfilesForTests()
  resetModelsForTests()
  const loaded = listProfiles()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]?.profile.id, 'cards')
  assert.ok((loaded[0]?.profile.validation.rules.length ?? 0) > 0)
})

test('validateJson valida schema de saída', () => {
  const profile = makeProfile()
  const ok = validateJson(profile.output.schema, { items: [{ item: 1, choice: 'A', confidence: 90 }] }, 'out')
  assert.equal(ok.ok, true)
  const bad = validateJson(profile.output.schema, { items: [{ item: 1, choice: 'Z', confidence: 90 }] }, 'out')
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.length > 0)
})
