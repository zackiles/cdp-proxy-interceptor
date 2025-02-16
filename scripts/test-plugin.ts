import startProxy from '../src/main.ts'
import { chromium } from 'npm:playwright'
Deno.env.set('DEBUG', 'pw:protocol')


const port = 9225
const proxy = await startProxy(port)

const browser = await chromium.connectOverCDP(`http://localhost:${port}`)
const context = await browser.newContext()
const page = await context.newPage()

// Get the CDP session for the page
const cdpSession = await browser.newBrowserCDPSession()

// Add a listener to check for synthetic execution contexts
let syntheticContextCreated = false
cdpSession.on('Runtime.executionContextCreated', (event) => {
  console.log(event)
  if (event.context.auxData?.isDefault === true) {
    syntheticContextCreated = true
  }
})

// Explicitly enable Runtime (IMPORTANT for testing the plugin)
await cdpSession.send('Runtime.enable').catch(error => {
    console.error("Failed to enable Runtime:", error);
    Deno.exit(1); // Exit with error code
});

await page.goto('https://google.com')
await new Promise(resolve => setTimeout(resolve, 10000))

// Verification checks
console.log('Running verification checks...')

// 1. Check if synthetic execution contexts were created
if (syntheticContextCreated) {
  console.log('✅ Synthetic execution context was created')
} else {
  throw new Error('❌ No synthetic execution context created')
}
Deno.exit(0)

// 2. Basic functionality check
try {
  const title = await page.evaluate(() => document.title)
  console.log(`✅ Page loaded with title: ${title}`)
} catch (e) {
  console.error(e)
  throw new Error('❌ Page functionality broken')
}

// Cleanup
await page.close()
await context.close()
await browser.close()
await proxy.cleanup()
