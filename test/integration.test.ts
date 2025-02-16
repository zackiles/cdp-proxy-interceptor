import { assertExists } from 'jsr:@std/assert'
import startProxy from '../src/main.ts'
import { chromium } from 'npm:playwright'
import { BaseCDPPlugin } from '../src/base_cdp_plugin.ts'
import type { CDPCommandRequest } from '../src/types.ts'

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

  // Create test plugin
  class TestPlugin extends BaseCDPPlugin {
    name = "TestPlugin";
    
    override async onRequest(request: CDPCommandRequest): Promise<CDPCommandRequest | null> {
      if (request.method === "Page.navigate") {
        console.log(`[TestPlugin] Intercepted navigation to: ${request.params?.url}`);
      }
      return request;
    }
  }

  await t.step(
    'should successfully connect to proxy and navigate',
    async () => {
      try {
        console.log('[TEST] Starting proxy...')
        const proxyResult = await startProxy(port)
        cleanup = proxyResult.cleanup

        // Register test plugin directly with the proxy
        proxyResult.components.pluginManager.registerPlugin(new TestPlugin())

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

        // Clean up context and page
        await context.close()
      } catch (error) {
        console.error('[TEST] Test failed with error:', error)
        if (error instanceof Error && error.stack) {
          console.error('[TEST] Error stack:', error.stack)
        }
        throw error
      }
    },
  )

  await t.step('should successfully use the plugin', async () => {
    try {
      // Create a new page and navigate
      console.log('[TEST] Creating new page for plugin test...')
      const page = await browser.newPage()
      console.log('[TEST] Navigating to example.com...')
      await page.goto('https://example.com')
      console.log('[TEST] Navigation complete')

      // Cleanup page
      await page.close()
    } catch (error) {
      console.error('[TEST] Plugin test failed:', error)
      throw error
    }
  })

  await t.step('cleanup', async () => {
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
  })
})
