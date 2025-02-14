import 'jsr:@std/dotenv/load'

// Add any additional test setup here
// For example, setting up global test hooks, mocks, or utilities

// Ensure CHROMIUM_DIRECTORY is set
if (!Deno.env.get('CHROMIUM_DIRECTORY')) {
  console.warn(
    'Warning: CHROMIUM_DIRECTORY environment variable is not set. Some tests may fail.',
  )
}
// Enable logging of CDP messages in Playwright
Deno.env.set("DEBUG", "pw:protocol")

Deno.env.set('DENO_ENV', 'test')

// Basic test setup file
// Add any global test configuration here
