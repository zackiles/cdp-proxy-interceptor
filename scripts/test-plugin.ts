import startProxy from '../src/main.ts'
import { chromium } from 'npm:playwright'
Deno.env.set('DEBUG', 'pw:protocol')


const port = 9225
const proxy = await startProxy(port)

const browser = await chromium.connectOverCDP(`http://localhost:${port}`)
const context = await browser.newContext()
const page = await context.newPage()

await page.goto('about:blank')
await page.close()
await context.close()
await browser.close()
await proxy.cleanup()
Deno.exit(0)
