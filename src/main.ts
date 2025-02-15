import 'jsr:@std/dotenv/load'

import { ChromeManager } from './chrome_manager.ts'
import { ErrorHandler } from './error_handler.ts'
import { HttpManager } from './http_manager.ts'
import { PluginManager } from './plugin_manager.ts'
import { SchemaValidator } from './schema_validator.ts'
import { SessionManager } from './session_manager.ts'
import { WebSocketManager } from './websocket_manager.ts'
import type { ProxyComponents } from './types.ts'


/**
 * Creates and initializes all proxy components
 */
const createComponents = async () => {
  const errorHandler = new ErrorHandler()
  const chromeManager = new ChromeManager(errorHandler)
  const sessionManager = new SessionManager(errorHandler)
  const schemaValidator = new SchemaValidator()
  const wsManager = new WebSocketManager(errorHandler, schemaValidator, null)
  const pluginManager = new PluginManager(errorHandler, sessionManager, wsManager)
  wsManager.setPluginManager(pluginManager)
  const httpManager = new HttpManager(chromeManager, errorHandler)

  const loadPlugins = async () => {
    try {
      const entries = Deno.readDir('./plugins')
      for await (const { isFile, name } of entries) {
        if (!isFile || !name.match(/\.[jt]s$/) || name.toLowerCase().includes('.disabled.')) {
          name.toLowerCase().includes('.disabled.') && console.log(`[PLUGINS] Skipping disabled plugin: ${name}`)
          continue
        }

        const module = await import(`../plugins/${name}`).catch(error => {
          console.error(`[PLUGINS] Failed to load plugin from ${name}:`, error)
          return null
        })
        
        const PluginClass = module?.default ?? Object.values(module ?? {})[0]
        if (typeof PluginClass === 'function') {
          pluginManager.registerPlugin(new PluginClass())
          console.log(`[PLUGINS] Loaded plugin from ${name}`)
        }
      }
    } catch (error) {
      console.error('[PLUGINS] Error reading plugins directory:', error)
    }
  }

  await Promise.all([
    loadPlugins(),
    schemaValidator.initialize(),
    chromeManager.start()
  ])

  return {
    errorHandler,
    chromeManager,
    sessionManager,
    schemaValidator,
    pluginManager,
    wsManager,
    httpManager
  }
}


const handleWebSocketUpgrade = async (
  req: Request,
  { chromeManager, sessionManager, wsManager }: ProxyComponents
): Promise<Response> => {
  console.log(`[CDP PROXY] Handling WebSocket upgrade for ${req.url}`)
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req)
  const url = new URL(req.url)
  const path = `${url.pathname}${url.search}`
  
  try {
    const chromeWsUrl = url.pathname.includes('/devtools/browser')
      ? await chromeManager.getWebSocketUrl()
      : req.url.replace(url.host, `localhost:${chromeManager.port}`)
    
    console.log(`[CDP PROXY] Connecting to Chrome at ${chromeWsUrl}`)
    const chromeSocket = new WebSocket(chromeWsUrl)
    
    // Wait for Chrome socket to be ready with increased timeout
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Chrome WebSocket connection timeout after 30 seconds'))
      }, 30000) // Increased to match Playwright's timeout

      chromeSocket.onopen = () => {
        console.log(`[CDP PROXY] Chrome WebSocket connection established`)
        clearTimeout(timeout)
        resolve()
      }

      chromeSocket.onerror = (event) => {
        console.error(`[CDP PROXY] Chrome WebSocket connection error:`, event)
        clearTimeout(timeout)
        reject(new Error(`Chrome WebSocket connection failed: ${event}`))
      }
    })
    
    // Use object spread for socket properties
    console.log(`[CDP PROXY] Setting up socket properties for ${path}`)
    Object.assign(clientSocket, { _path: path })
    Object.assign(chromeSocket, { _path: path })
    
    console.log(`[CDP PROXY] Creating session for WebSocket connection`)
    const session = sessionManager.createSession(clientSocket, chromeSocket, chromeWsUrl)
    console.log(`[CDP PROXY] Handling WebSocket connection in WebSocketManager`)
    await wsManager.handleConnection(clientSocket, chromeSocket, session.id)
    
    console.log(`[CDP PROXY] Successfully established WebSocket connection for ${path}`)
    return response
  } catch (error) {
    console.error(`[CDP PROXY] WebSocket upgrade failed:`, error)
    throw error
  }
}

/**
 * Starts a Chrome DevTools Protocol proxy server
 */
export default async function startProxy(port: number) {
  console.log(`[CDP PROXY] Starting CDP proxy on port ${port}...`)
  const abortController = new AbortController()
  
  try {
    const components = await createComponents()
    
    // Verify Chrome is ready
    console.log(`[CDP PROXY] Waiting for Chrome to be ready...`)
    await components.chromeManager.getWebSocketUrl()
    console.log(`[CDP PROXY] Chrome is ready`)

    const server = Deno.serve({
      port,
      signal: abortController.signal,
      onError: (error) => {
        console.error(`[CDP PROXY] Server error:`, error)
        return new Response('Internal Server Error', { status: 500 })
      },
      handler: async (req: Request) => {
        try {
          if (req.headers.get("upgrade") === "websocket") {
            return await handleWebSocketUpgrade(req, components)
          }
          const url = new URL(req.url)
          return await components.httpManager.handleRequest(req, url, port)
        } catch (error) {
          console.error(`[CDP PROXY] Request handler error:`, error)
          throw error
        }
      },
    })

    console.log(`[CDP PROXY] Server started successfully on port ${port}`)

    return {
      server,
      cleanup: async () => {
        console.log(`[CDP PROXY] Cleaning up...`)
        abortController.abort()
        
        // Clean up any active sessions
        for (const session of components.sessionManager.getActiveSessions()) {
          await components.wsManager.cleanup(session.id)
        }
        
        await components.chromeManager.stop()
        console.log(`[CDP PROXY] Cleanup complete`)
      }
    }
  } catch (error) {
    console.error(`[CDP PROXY] Failed to start proxy:`, error)
    throw error
  }
}

const setupSignalHandlers = (cleanup: () => Promise<void>) => {
  const handleSignal = async (signal: string) => {
    console.log(`\nReceived ${signal}, cleaning up...`)
    try {
      await cleanup()
      Deno.exit(0)
    } catch (error) {
      console.error('Error during cleanup:', error)
      Deno.exit(1)
    }
  }

  ["SIGTERM", "SIGINT"].forEach(signal => 
    Deno.addSignalListener(signal as Deno.Signal, () => handleSignal(signal))
  )
}


async function main() {
  const port = Number(Deno.env.get('CDP_PROXY_PORT'))
  if (isNaN(port)) {
    throw new Error('CDP_PROXY_PORT environment variable must be a number')
  }

  const { cleanup, server } = await startProxy(port)
  setupSignalHandlers(cleanup)
  
  // Now we can await the server
  await server.finished
  return cleanup
}

export {
  startProxy,
  setupSignalHandlers,
}

if (import.meta.main) {
  main().catch(async error => {
    console.error('Error during startup:', error)
    try {
      if (typeof error === 'object' && error !== null && 'cleanup' in error) {
        await (error.cleanup as () => Promise<void>)()
      }
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError)
    } finally {
      Deno.exit(1)
    }
  })
}
