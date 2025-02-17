import 'jsr:@std/dotenv/load'

import { ChromeManager } from './chrome_manager.ts'
import { ErrorHandler } from './error_handler.ts'
import { HttpManager } from './http_manager.ts'
import { PluginManager } from './plugin_manager.ts'
import { SchemaValidator } from './schema_validator.ts'
import { SessionManager } from './session_manager.ts'
import { WebSocketManager } from './websocket_manager.ts'
import type { ProxyComponents } from './types.ts'

/** Creates and initializes all proxy components */
const createComponents = async () => {
  const components = {
    errorHandler: new ErrorHandler(),
    schemaValidator: new SchemaValidator(),
    chromeManager: null,
    sessionManager: null,
    wsManager: null,
    pluginManager: null,
    httpManager: null,
  } as unknown as ProxyComponents

  components.chromeManager = new ChromeManager(components.errorHandler)
  components.sessionManager = new SessionManager(components.errorHandler)
  components.wsManager = new WebSocketManager(components.errorHandler, components.schemaValidator, null)
  components.pluginManager = new PluginManager(components.errorHandler, components.sessionManager, components.wsManager)
  components.wsManager.setPluginManager(components.pluginManager)
  components.httpManager = new HttpManager(components.chromeManager, components.errorHandler)

  const loadPlugins = async () => {
    try {
      const plugins = Deno.readDir('./plugins')
      for await (const { isFile, name } of plugins) {
        if (!isFile || !/\.[jt]s$/.test(name) || name.toLowerCase().includes('.disabled.')) {
          name.toLowerCase().includes('.disabled.') && console.log(`[PLUGINS] Skipping disabled plugin: ${name}`)
          continue
        }

        try {
          const module = await import(`../plugins/${name}`)
          const PluginClass = module?.default ?? Object.values(module ?? {})[0]
          if (typeof PluginClass === 'function') {
            components.pluginManager.registerPlugin(new PluginClass())
            console.log(`[PLUGINS] Loaded plugin from ${name}`)
          }
        } catch (error) {
          console.error(`[PLUGINS] Failed to load plugin from ${name}:`, error)
        }
      }
    } catch (error) {
      console.error('[PLUGINS] Error reading plugins directory:', error)
    }
  }

  await Promise.all([
    loadPlugins(),
    components.schemaValidator.initialize(),
    components.chromeManager.start(),
  ])

  return components
}

const handleWebSocketUpgrade = async (
  req: Request,
  { chromeManager, sessionManager, wsManager }: ProxyComponents,
): Promise<Response> => {
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req)
  const url = new URL(req.url)
  const path = `${url.pathname}${url.search}`
  console.log(`[CDP PROXY] Handling WebSocket upgrade for ${req.url}`)

  try {
    const chromeWsUrl = url.pathname.includes('/devtools/browser')
      ? await chromeManager.getWebSocketUrl()
      : req.url.replace(url.host, `localhost:${chromeManager.port}`)

    console.log(`[CDP PROXY] Connecting to Chrome at ${chromeWsUrl}`)
    const chromeSocket = new WebSocket(chromeWsUrl)

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Chrome WebSocket connection timeout after 30 seconds')), 30000)
        chromeSocket.onopen = () => {
          clearTimeout(timeout)
          console.log(`[CDP PROXY] Chrome WebSocket connection established`)
          resolve()
        }
        chromeSocket.onerror = event => {
          clearTimeout(timeout)
          reject(new Error(`Chrome WebSocket connection failed: ${event}`))
        }
      })
    } catch (error) {
      chromeSocket.close()
      throw error
    }

    Object.assign(clientSocket, { _path: path })
    Object.assign(chromeSocket, { _path: path })
    const session = sessionManager.createSession(clientSocket, chromeSocket, chromeWsUrl)
    await wsManager.handleConnection(clientSocket, chromeSocket, session.id)

    return response
  } catch (error) {
    console.error(`[CDP PROXY] WebSocket upgrade failed:`, error)
    throw error
  }
}

/** Starts a Chrome DevTools Protocol proxy server */
export default async function startProxy(port: number) {
  console.log(`[CDP PROXY] Starting CDP proxy on port ${port}...`)
  const abortController = new AbortController()
  const components = await createComponents()
  await components.chromeManager.getWebSocketUrl()

  const server = Deno.serve({
    port,
    signal: abortController.signal,
    onError: error => {
      console.error(`[CDP PROXY] Server error:`, error)
      return new Response('Internal Server Error', { status: 500 })
    },
    handler: async req => {
      try {
        if (req.headers.get('upgrade') === 'websocket') {
          const response = await handleWebSocketUpgrade(req, components)
          // Ensure the WebSocket is ready before returning
          await new Promise(resolve => setTimeout(resolve, 100))
          return response
        }
        return await components.httpManager.handleRequest(req, new URL(req.url), port)
      } catch (error) {
        console.error(`[CDP PROXY] Request handler error:`, error)
        throw error
      }
    },
  })

  return {
    server,
    components,
    cleanup: async () => {
      console.log(`[CDP PROXY] Cleaning up...`)
      abortController.abort()
      try {
        await Promise.all([
          ...components.sessionManager.getActiveSessions().map(session => components.wsManager.cleanup(session.id)),
          components.chromeManager.stop(),
        ])
      } catch (error) {
        console.error(`[CDP PROXY] Cleanup failed:`, error)
      }
    },
  }
}

const setupSignalHandlers = (cleanup: () => Promise<void>) =>
  ['SIGTERM', 'SIGINT'].forEach(signal =>
    Deno.addSignalListener(signal as Deno.Signal, async () => {
      console.log(`\nReceived ${signal}, cleaning up...`)
      try {
        await cleanup()
        Deno.exit(0)
      } catch (error) {
        console.error('Error during cleanup:', error)
        Deno.exit(1)
      }
    })
  )

async function main() {
  const port = Number(Deno.env.get('CDP_PROXY_PORT'))
  if (isNaN(port)) throw new Error('CDP_PROXY_PORT environment variable must be a number')

  try {
    const { cleanup, server } = await startProxy(port)
    setupSignalHandlers(cleanup)
    await server.finished
    return cleanup
  } catch (error) {
    console.error('Error during startup:', error)
    if (error && typeof error === 'object' && 'cleanup' in error) {
      try {
        await (error.cleanup as () => Promise<void>)()
      } catch (cleanupError) {
        console.error('Error during cleanup:', cleanupError)
      }
    }
    throw error
  }
}

export { startProxy, setupSignalHandlers }

if (import.meta.main) {
  main().catch(() => Deno.exit(1))
}
