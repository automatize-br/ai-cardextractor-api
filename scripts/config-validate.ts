import { validateConfig } from '../src/config/validate.ts'

try {
  validateConfig()
  console.log('config ok')
} catch (error) {
  console.error(`config invalid: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
