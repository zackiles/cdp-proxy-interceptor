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
  const pluginManager = new PluginManager(errorHandler)
  const wsManager = new WebSocketManager(errorHandler, schemaValidator, pluginManager)
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
  const { socket: clientSocket, response } = Deno.upgradeWebSocket(req)
  const url = new URL(req.url)
  const path = `${url.pathname}${url.search}`
  
  const chromeWsUrl = url.pathname.includes('/devtools/browser')
    ? await chromeManager.getWebSocketUrl()
    : req.url.replace(url.host, `localhost:${chromeManager.port}`)
  
  const chromeSocket = new WebSocket(chromeWsUrl)
  
  // Use object spread for socket properties
  Object.assign(clientSocket, { _path: path })
  Object.assign(chromeSocket, { _path: path })
  
  const session = sessionManager.createSession(clientSocket, chromeSocket, chromeWsUrl)
  await wsManager.handleConnection(clientSocket, chromeSocket, session.id)
  
  return response
}

/**
 * Starts a Chrome DevTools Protocol proxy server
 */
export default async function startProxy(port: number) {
  console.log(`Starting CDP proxy on port ${port}...`)
  const abortController = new AbortController()
  
  try {
    const components = await createComponents()
    
    const cleanup = async () => {
      try {
        await components.chromeManager.stop()
        abortController.abort()
        await server.finished
      } catch (error) {
        console.error('Error during cleanup:', error)
        throw error
      }
    }

    // Create server after all setup is complete
    const server = Deno.serve(
      { port, signal: abortController.signal },
      req => {
        const url = new URL(req.url)
        return req.headers.get('upgrade')?.toLowerCase() === 'websocket'
          ? handleWebSocketUpgrade(req, components)
          : components.httpManager.handleRequest(req, url, port)
      }
    )

    return { cleanup, abortController, server }
  } catch (error) {
    abortController.abort()
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
