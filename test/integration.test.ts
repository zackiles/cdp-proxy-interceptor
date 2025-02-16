import { assertExists } from 'jsr:@std/assert'
import startProxy from '../src/main.ts'
import { chromium } from 'npm:playwright'

Deno.env.set('DEBUG', 'pw:protocol')
Deno.env.set('DENO_ENV', 'test')

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function retryConnect(port: number, maxRetries = 5, retryDelay = 2000) {
  let lastError: unknown
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(
        `[TEST] Attempting to connect to proxy (attempt ${i + 1}/${maxRetries})...`,
      )
      const browser = await chromium.connectOverCDP(`http://localhost:${port}`)
      console.log(`[TEST] Successfully connected to proxy`)
      return browser
    } catch (error) {
      console.error(`[TEST] Connection attempt ${i + 1} failed:`, error)
      lastError = error
      if (i < maxRetries - 1) {
        console.log(`[TEST] Waiting ${retryDelay}ms before next attempt...`)
        await delay(retryDelay)
      }
    }
  }
  throw lastError
}

Deno.test('Integration Test', async (t) => {
  const port = 9222
  let browser: any = null
  let launchServer: any = null
  let cleanup: (() => Promise<void>) | null = null

  await t.step(
    'should successfully connect to proxy and navigate',
    async () => {
      try {
        console.log('[TEST] Starting proxy...')
        const proxy = await startProxy(port)
        cleanup = proxy.cleanup

        // Wait longer for the proxy to be fully ready
        console.log('[TEST] Waiting for proxy to be ready...')
        //await delay(5000)

        // Try to get the WebSocket URL directly first
        try {
          console.log('[TEST] Checking WebSocket URL availability...')
          const response = await fetch(`http://localhost:${port}/json/version`)
          if (!response.ok) {
            console.error(
              '[TEST] WebSocket URL not available:',
              response.status,
              response.statusText,
            )
          } else {
            const data = await response.json()
            console.log('[TEST] WebSocket URL response:', data)
          }
        } catch (error) {
          console.error('[TEST] Error checking WebSocket URL:', error)
        }

        // Connect browser through proxy with more retries and longer delays
        console.log('[TEST] Attempting to connect browser...')
        browser = await retryConnect(port)

        // Create new context and page with debug logging
        console.log('[TEST] Creating browser context...')
        const context = await browser.newContext()
        console.log('[TEST] Creating new page...')
        const page = await context.newPage()

        // Navigate and get launch server with debug logging
        console.log('[TEST] Navigating to about:blank...')
        await page.goto('about:blank')
        console.log('[TEST] Getting browser launch server...')
        launchServer = await browser.browserType().launchServer()
        const wsEndpoint = launchServer.wsEndpoint()
        console.log('[TEST] WebSocket endpoint:', wsEndpoint)
        assertExists(wsEndpoint, 'WebSocket endpoint should exist')
      } catch (error) {
        console.error('[TEST] Test failed with error:', error)
        if (error instanceof Error && error.stack) {
          console.error('[TEST] Error stack:', error.stack)
        }
        throw error
      } finally {
        // Clean up all resources in reverse order
        console.log('[TEST] Starting cleanup...')
        if (launchServer) {
          console.log('[TEST] Closing launch server...')
          await launchServer.close()
        }
        if (browser) {
          console.log('[TEST] Closing browser...')
          await browser.close()
        }
        if (cleanup) {
          console.log('[TEST] Running proxy cleanup...')
          await cleanup()
        }
        console.log('[TEST] Cleanup complete')
      }
    },
  )
})
