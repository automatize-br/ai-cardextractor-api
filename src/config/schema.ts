import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ErrorObject, ValidateFunction } from 'ajv'
import type { JsonSchema } from '../types/profile.ts'

// ============================================================================
// Validação de JSON Schema (draft 2020-12) para perfis de tarefa.
//
// O perfil declara schema de entrada e de saída. O boot valida o meta-schema e
// o runtime valida o payload. O subconjunto é deliberadamente conservador:
// sem $ref remoto, sem if/then/else, sem patternProperties.
// ============================================================================

const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  allowUnionTypes: true,
  validateFormats: false,
})

const compiled = new Map<string, ValidateFunction>()

function compile(schema: JsonSchema, label: string): ValidateFunction {
  const key = JSON.stringify(schema)
  const existing = compiled.get(key)
  if (existing) return existing
  try {
    const validate = ajv.compile(schema)
    compiled.set(key, validate)
    return validate
  } catch (error) {
    throw new Error(`${label} is not a valid JSON Schema: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return []
  return errors.map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
}

export function assertJsonSchema(schema: JsonSchema, label: string): void {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new Error(`${label} must be a JSON Schema object`)
  }
  compile(schema, label)
}

export interface JsonValidationResult {
  ok: boolean
  errors: string[]
}

export function validateJson(schema: JsonSchema, value: unknown, label: string): JsonValidationResult {
  const validate = compile(schema, label)
  const ok = validate(value) as boolean
  return { ok, errors: ok ? [] : formatErrors(validate.errors) }
}

export function clearSchemaCacheForTests(): void {
  compiled.clear()
}
