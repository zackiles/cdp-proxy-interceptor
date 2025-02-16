import startProxy from '../src/main.ts'
import { chromium, Page } from 'npm:playwright'
Deno.env.set('DEBUG', 'pw:protocol')

const PORT = 9225
const VERIFICATION_TIMEOUT = 10000

const runVerificationChecks = async (page: Page): Promise<void> => {
  console.log('Running verification checks...')
  
  // 1. Check if synthetic execution contexts were created
  if (!syntheticContextCreated) {
    throw new Error('❌ No synthetic execution context created')
  }
  console.log('✅ Synthetic execution context was created')

  // 2. Basic functionality check
  const title = await page.evaluate(() => document.title)
    .catch((e: Error) => { throw new Error('❌ Page functionality broken: ' + e.message) })
  console.log(`✅ Page loaded with title: ${title}`)
}

// Track synthetic context creation
let syntheticContextCreated = false

const proxy = await startProxy(PORT)
const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`)
const context = await browser.newContext()
const page = await context.newPage()

// Get the CDP session for the page
const cdpSession = await page.context().newCDPSession(page)

// Add a listener to check for synthetic execution contexts
cdpSession.on('Runtime.executionContextCreated', (event: { context?: { auxData?: { isDefault?: boolean } } }) => {
  console.log('Execution context created:', event)
  // The plugin sends an empty context when Runtime.enable is called
  syntheticContextCreated = syntheticContextCreated || 
    event.context?.auxData?.isDefault === true || 
    !event.context // Empty context case
})

// Explicitly enable Runtime and verify the response
console.log('Enabling Runtime...')
const runtimeResponse = await cdpSession.send('Runtime.enable')
console.log('Runtime.enable response:', runtimeResponse)

// The plugin should return an empty response since it intercepts the call
if (Object.keys(runtimeResponse).length > 0) {
  throw new Error('❌ Plugin did not intercept Runtime.enable call')
}
console.log('✅ Plugin intercepted Runtime.enable call')

await page.goto('https://google.com')
await new Promise(resolve => setTimeout(resolve, VERIFICATION_TIMEOUT))

try {
  await runVerificationChecks(page)
} finally {
  // Cleanup
  await page.close()
  await context.close()
  await browser.close()
  await proxy.cleanup()
}
