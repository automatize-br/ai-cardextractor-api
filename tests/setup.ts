// Executado antes de tudo via `--import ./tests/setup.ts`.
// Injeta ambiente minimo e determinista: sem Mongo, sem modelo real, sem rede.

process.env['ENVIRONMENT'] = 'TEST'
process.env['TZ'] = 'America/Sao_Paulo'

process.env['AI_INTERNAL_KEY'] = 'test-internal-key'
process.env['AI_PERSISTENCE'] = 'memory'
process.env['AI_STORE_PACKS'] = 'false'
process.env['AI_ADJ_MODE'] = 'on'
process.env['AI_MIN_CONFIDENCE'] = '0.6'

process.env['LLM_PROVIDER'] = 'fake'
process.env['LLM_TIMEOUT_MS'] = '1000'
process.env['LLM_MAX_CARDS'] = '30'
process.env['LLM_MAX_TOKENS'] = '700'
process.env['LLM_TEMPERATURE'] = '0'

process.env['AI_MODEL_ID'] = 'fake-adjudicator'
process.env['AI_MODEL_VERSION'] = 'fake@test'
process.env['AI_MODEL_PATH'] = 'src/LLMS/does-not-exist.gguf'
process.env['AI_MODELS_JSON'] = ''
process.env['PACK_VERSION'] = '1'
process.env['PROMPT_VERSION'] = '1'
