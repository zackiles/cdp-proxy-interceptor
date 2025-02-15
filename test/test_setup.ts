import 'jsr:@std/dotenv/load'
import { getChromiumPaths } from '../src/utils.ts'

// Add any additional test setup here
// For example, setting up global test hooks, mocks, or utilities
// Enable logging of CDP messages in Playwright

try {
  getChromiumPaths()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  console.warn(`Warning: ${message}. Some tests may fail.`)
}

Deno.env.set("DEBUG", "pw:protocol")
Deno.env.set('DENO_ENV', 'test')

// Basic test setup file
// Add any global test configuration here

