import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { env } from './env.ts'
import { getModel, listModels } from './models.ts'
import { assertJsonSchema } from './schema.ts'
import { computeHash } from '../helpers/packHash.ts'
import { validateRuleConfigs } from '../modules/execution/rules.ts'
import type {
  CoverageMode,
  FallbackPolicy,
  GroundingMode,
  ProfileMode,
  ProfileSummary,
  PromptExample,
  RegisteredProfile,
  RuleConfig,
  TaskProfile,
} from '../types/profile.ts'

// ============================================================================
// Perfis de tarefa v2. Fonte única: AI_PROFILES_JSON (ou AI_PROFILES_B64).
// Nenhum prompt/schema de negócio fica hardcoded; o perfil é validado no boot.
// ============================================================================

const MODES = ['selection', 'extraction', 'classification', 'score'] as const
const GROUNDING = ['none', 'candidate_ids', 'source_quotes'] as const
const COVERAGE = ['exact', 'partial'] as const
const FALLBACK = ['heuristic', 'review', 'reject'] as const
const STRUCTURED_OUTPUT = ['json_schema', 'tool', 'grammar', 'json_object', 'none'] as const

const schemaObject = z.record(z.string(), z.unknown())

const ruleSchema = z
  .object({
    type: z.string().trim().min(1).max(64),
    field: z.string().trim().min(1).max(120).optional(),
    collection: z.string().trim().min(1).max(120).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const exampleSchema = z
  .object({
    input: z.unknown(),
    output: z.unknown(),
  })
  .strict()

const profileSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    version: z.string().trim().min(1).max(64),
    description: z.string().trim().max(500).nullable().default(null),
    mode: z.enum(MODES),
    input: z
      .object({
        schema: schemaObject,
        collection: z.string().trim().min(1).max(120).default('items'),
        maxItems: z.number().int().positive().max(10_000).nullable().default(null),
        maxChars: z.number().int().positive().max(1_000_000).nullable().default(null),
      })
      .strict(),
    output: z
      .object({
        schema: schemaObject,
      })
      .strict(),
    prompt: z
      .object({
        system: z.string().trim().min(1).max(100_000),
        rules: z.array(z.string().max(20_000)).max(200).default([]),
        examples: z.array(exampleSchema).max(20).default([]),
        userTemplate: z.string().max(50_000).nullable().default(null),
      })
      .strict(),
    validation: z
      .object({
        grounding: z.enum(GROUNDING),
        coverage: z.enum(COVERAGE),
        candidateFields: z.record(z.string(), z.string().min(1).max(120)).default({}),
        rules: z.array(ruleSchema).max(200).default([]),
        fallback: z.enum(FALLBACK).default('review'),
        minConfidence: z.number().min(0).max(1).default(env.AI_MIN_CONFIDENCE),
      })
      .strict(),
    rulesVersion: z.string().trim().min(1).max(64),
    model: z
      .object({
        id: z.string().trim().min(1).max(64),
        allowedModels: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
        temperature: z.number().min(0).max(2).default(env.AI_TEMPERATURE),
        maxTokens: z.number().int().positive().max(1_000_000).nullable().default(null),
        timeoutMs: z.number().int().positive().max(600_000).nullable().default(null),
        batchSize: z.number().int().positive().max(10_000).nullable().default(null),
        structuredOutput: z.enum(STRUCTURED_OUTPUT).nullable().default(null),
      })
      .strict(),
    cache: z
      .object({
        appTtlMs: z.number().int().positive().max(365 * 24 * 60 * 60 * 1000).nullable().default(null),
        promptPrefix: z.boolean().default(true),
        storeQuotes: z.boolean().default(true),
        maxPromptCacheBlocks: z.number().int().min(0).max(4).default(1),
      })
      .strict(),
  })
  .strict()

const profilesSchema = z.array(profileSchema)

type ParsedProfile = z.infer<typeof profileSchema>

function readProfileJson(): unknown[] {
  const json = (process.env['AI_PROFILES_JSON'] ?? '').trim()
  const b64 = (process.env['AI_PROFILES_B64'] ?? '').trim()

  let text = ''
  if (json !== '') text = json
  else if (b64 !== '') {
    try {
      text = Buffer.from(b64, 'base64').toString('utf8')
    } catch {
      throw new Error('AI_PROFILES_B64 is not valid base64')
    }
  } else {
    // Sem env: usa o perfil `cards` versionado no repositório (fonte única do
    // contrato de cards). A config de provider/modelo vem do painel admin.
    try {
      return [JSON.parse(readFileSync(resolve(process.cwd(), 'profiles/cards.json'), 'utf8')) as unknown]
    } catch {
      return []
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`AI_PROFILES_JSON/B64 must be valid JSON: ${error instanceof Error ? error.message : 'parse error'}`)
  }
  if (!Array.isArray(parsed)) throw new Error('AI_PROFILES_JSON must be an array')
  return parsed
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
const ALLOWED_PLACEHOLDERS = new Set(['input', 'schema', 'rules', 'examples'])

function assertTemplate(template: string | null, profileId: string): void {
  if (template === null) return
  const found = [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '')
  for (const name of found) {
    if (!ALLOWED_PLACEHOLDERS.has(name)) {
      throw new Error(`profile "${profileId}": unknown prompt placeholder "{{${name}}}"`)
    }
  }
  if (!found.includes('input')) {
    throw new Error(`profile "${profileId}": prompt.userTemplate must include "{{input}}"`)
  }
}

function assertOutputClosed(profile: ParsedProfile): void {
  const schema = profile.output.schema
  if (schema['type'] === 'object' && schema['additionalProperties'] !== false) {
    throw new Error(`profile "${profile.id}": output.schema must set additionalProperties:false`)
  }
}

function assertModel(profile: ParsedProfile): void {
  const model = getModel(profile.model.id)
  if (!model) {
    throw new Error(
      `profile "${profile.id}": model "${profile.model.id}" not found in AI_MODELS_JSON (or legacy default)`,
    )
  }

  const requested = profile.model.structuredOutput
  if (requested !== null && requested !== 'none' && requested !== model.structuredOutput) {
    throw new Error(
      `profile "${profile.id}": requests structuredOutput "${requested}" but model "${model.id}" supports "${model.structuredOutput}"`,
    )
  }

  const allowed = profile.model.allowedModels.length > 0 ? profile.model.allowedModels : [profile.model.id]
  for (const id of allowed) {
    if (!getModel(id)) throw new Error(`profile "${profile.id}": allowedModels contains unknown model "${id}"`)
  }
}

function normalizeRule(rule: z.infer<typeof ruleSchema>): RuleConfig {
  const normalized: RuleConfig = { type: rule.type }
  if (rule.field !== undefined) normalized.field = rule.field
  if (rule.collection !== undefined) normalized.collection = rule.collection
  if (rule.filter !== undefined) normalized.filter = rule.filter
  if (rule.name !== undefined) normalized.name = rule.name
  if (rule.params !== undefined) normalized.params = rule.params
  return normalized
}

function normalizeProfile(profile: ParsedProfile): TaskProfile {
  return {
    id: profile.id,
    version: profile.version,
    description: profile.description,
    mode: profile.mode as ProfileMode,
    input: {
      schema: profile.input.schema,
      collection: profile.input.collection,
      maxItems: profile.input.maxItems,
      maxChars: profile.input.maxChars,
    },
    output: { schema: profile.output.schema },
    prompt: {
      system: profile.prompt.system,
      rules: [...profile.prompt.rules],
      examples: profile.prompt.examples.map((example): PromptExample => ({ input: example.input, output: example.output })),
      userTemplate: profile.prompt.userTemplate,
    },
    validation: {
      grounding: profile.validation.grounding as GroundingMode,
      coverage: profile.validation.coverage as CoverageMode,
      candidateFields: { ...profile.validation.candidateFields },
      rules: profile.validation.rules.map(normalizeRule),
      fallback: profile.validation.fallback as FallbackPolicy,
      minConfidence: profile.validation.minConfidence,
    },
    rulesVersion: profile.rulesVersion,
    model: {
      id: profile.model.id,
      allowedModels: [...profile.model.allowedModels],
      temperature: profile.model.temperature,
      maxTokens: profile.model.maxTokens,
      timeoutMs: profile.model.timeoutMs,
      batchSize: profile.model.batchSize,
      structuredOutput: profile.model.structuredOutput,
    },
    cache: {
      appTtlMs: profile.cache.appTtlMs,
      promptPrefix: profile.cache.promptPrefix,
      storeQuotes: profile.cache.storeQuotes,
      maxPromptCacheBlocks: profile.cache.maxPromptCacheBlocks,
    },
  }
}

function register(profile: TaskProfile): RegisteredProfile {
  const schemaHash = computeHash({ input: profile.input.schema, output: profile.output.schema })
  const promptHash = computeHash({
    system: profile.prompt.system,
    rules: profile.prompt.rules,
    examples: profile.prompt.examples,
    userTemplate: profile.prompt.userTemplate,
    outputSchema: profile.output.schema,
  })
  const profileHash = computeHash({
    ...profile,
    schemaHash,
    promptHash,
  })
  return { profile, profileHash, promptHash, schemaHash }
}

let cached: RegisteredProfile[] | null = null

export function listProfiles(): RegisteredProfile[] {
  if (cached) return cached

  const raw = readProfileJson()
  const parsed = profilesSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `AI_PROFILES_JSON invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    )
  }

  const ids = new Set<string>()
  const result: RegisteredProfile[] = []
  for (const item of parsed.data) {
    if (ids.has(item.id)) throw new Error(`AI_PROFILES_JSON has duplicate profile id "${item.id}"`)
    ids.add(item.id)
    assertTemplate(item.prompt.userTemplate, item.id)
    assertOutputClosed(item)
    assertJsonSchema(item.input.schema, `profile "${item.id}" input.schema`)
    assertJsonSchema(item.output.schema, `profile "${item.id}" output.schema`)
    const normalized = normalizeProfile(item)
    validateRuleConfigs(normalized.validation.rules, item.id)
    assertModel(item)
    result.push(register(normalized))
  }
  cached = result
  return cached
}

export function getProfile(id: string): RegisteredProfile | null {
  return listProfiles().find((entry) => entry.profile.id === id) ?? null
}

export function getDefaultProfile(): RegisteredProfile | null {
  const configured = listProfiles()
  const id = env.AI_DEFAULT_PROFILE.trim()
  return configured.find((entry) => entry.profile.id === id) ?? configured[0] ?? null
}

export function profileSummaries(): ProfileSummary[] {
  return listProfiles().map(({ profile, profileHash, promptHash }) => ({
    id: profile.id,
    version: profile.version,
    description: profile.description,
    mode: profile.mode,
    profileHash,
    promptHash,
    modelId: profile.model.id,
  }))
}

export function resetProfilesForTests(): void {
  cached = null
}

/** Sanity check para o boot: carrega catálogo e perfis. */
export function validateConfig(): void {
  listModels()
  listProfiles()
}
