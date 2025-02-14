import './test_setup.ts'
import { assertExists } from 'jsr:@std/assert'
import startProxy from "../src/main.ts"
import { chromium } from "npm:playwright"

Deno.test('Integration Test', async (t) => {
  const port = 9222
  let browser: any = null
  let launchServer: any = null
  let cleanup: (() => Promise<void>) | null = null

  await t.step('should successfully connect to proxy and navigate', async () => {
    try {

      // Start the proxy with cleanup function
      const proxy = await startProxy(port)
      cleanup = proxy.cleanup

      // Connect browser through proxy - this will throw if connection fails
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)

      // Create new context and page - this will throw if page creation fails
      const context = await browser.newContext()
      const page = await context.newPage()

      // Navigate and get launch server - this will throw if navigation fails
      await page.goto('about:blank')
      launchServer = await browser.browserType().launchServer()
      const wsEndpoint = launchServer.wsEndpoint()
      assertExists(wsEndpoint, 'WebSocket endpoint should exist')

    } catch (error) {
      console.error('Test failed:', error)
      throw error
    } finally {
      // Clean up all resources in reverse order
      if (launchServer) {
        await launchServer.close()
      }
      if (browser) {
        await browser.close()
      }
      if (cleanup) {
        await cleanup()
      }
    }
  })
}) 