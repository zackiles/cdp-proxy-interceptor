import type {
  CDPPlugin,
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
  CDPMessage,
} from './types.ts'
import type { ErrorHandler } from './error_handler.ts'
import type { SessionManager } from './session_manager.ts'
import type { WebSocketManager } from './websocket_manager.ts'
import { CDPErrorType } from './types.ts'
import { BaseCDPPlugin } from './base_cdp_plugin.ts'

type PluginMethod = 'onRequest' | 'onResponse' | 'onEvent'
type PluginError = {
  name: string
  message: string
  stack?: string
}

interface PluginRequestPromise {
  resolve: (value: CDPCommandResponse) => void
  reject: (reason?: unknown) => void
  timeoutId: number
}

/**
 * Manages CDP plugins for request/response/event processing
 */
export class PluginManager {
  private static readonly PLUGIN_ERROR_CODE = 2002
  private static readonly INVALID_PLUGIN_CODE = 2001
  private static readonly PLUGIN_MESSAGE_ID_BASE = 1000000000
  private static readonly PLUGIN_COMMAND_TIMEOUT = 5000 // 5 seconds
  private static readonly CLEANUP_TIMEOUT = 5000 // 5 seconds

  private readonly plugins: CDPPlugin[] = []
  private pluginMessageIdCounter = PluginManager.PLUGIN_MESSAGE_ID_BASE
  private readonly pluginRequestIdMap = new Map<number, PluginRequestPromise>()

  constructor(
    private readonly errorHandler: ErrorHandler,
    private readonly sessionManager: SessionManager,
    private readonly wsManager: WebSocketManager,
  ) {}

  registerPlugin(plugin: CDPPlugin): void {
    if (!this.isValidPlugin(plugin)) {
      this.errorHandler.handleError({
        type: CDPErrorType.PLUGIN,
        code: PluginManager.INVALID_PLUGIN_CODE,
        message: 'Invalid plugin: missing required methods',
        recoverable: true,
        details: { plugin },
      })
      return
    }

    // IMPORTANT: Check if the plugin extends BaseCDPPlugin
    if (!(plugin instanceof BaseCDPPlugin)) {
      this.errorHandler.handleError({
        type: CDPErrorType.PLUGIN,
        code: PluginManager.INVALID_PLUGIN_CODE,
        message: 'Invalid plugin: must extend BaseCDPPlugin',
        recoverable: true, //  arguably *not* recoverable, but we'll keep it consistent
        details: { plugin },
      })
      return;
    }

    // Inject helper methods before adding plugin
    this.injectPluginHelpers(plugin)
    this.plugins.push(plugin)
  }

  unregisterPlugin(plugin: CDPPlugin): void {
    const index = this.plugins.indexOf(plugin)
    if (index !== -1) {
      // Call cleanup if plugin implements it
      if ('cleanup' in plugin && typeof plugin.cleanup === 'function') {
        try {
          const result = plugin.cleanup()
          // Handle async cleanup
          if (result instanceof Promise) {
            result.catch(error => {
              this.handlePluginError(plugin, 'cleanup', error)
            })
          }
        } catch (error) {
          this.handlePluginError(plugin, 'cleanup', error)
        }
      }
      this.plugins.splice(index, 1)
    }
  }

  async processRequest(
    request: CDPCommandRequest,
  ): Promise<CDPCommandRequest | null> {
    return this.processPluginChain(request, 'onRequest')
  }

  async processResponse(
    response: CDPCommandResponse,
  ): Promise<CDPCommandResponse | null> {
    return this.processPluginChain(response, 'onResponse')
  }

  async processEvent(event: CDPEvent): Promise<CDPEvent | null> {
    return this.processPluginChain(event, 'onEvent')
  }

  async processMessage(message: unknown): Promise<CDPMessage | null> {
    const cdpMessage = message as CDPMessage
    let processedMessage: CDPMessage | null = cdpMessage

    for (const plugin of this.plugins) {
      if (!processedMessage || plugin._state?.cleaning) continue
      
      try {
        processedMessage = await this.processPluginMessage(plugin, processedMessage)
      } catch (error) {
        this.handlePluginError(plugin, 'processMessage', error)
      }
    }

    return processedMessage
  }

  private async processPluginMessage(plugin: CDPPlugin, message: CDPMessage): Promise<CDPMessage | null> {
    if ('id' in message) {
      return 'result' in message || 'error' in message
        ? await plugin.onResponse?.(message as CDPCommandResponse) ?? message
        : await plugin.onRequest?.(message as CDPCommandRequest) ?? message
    }
    
    return 'method' in message
      ? await plugin.onEvent?.(message as CDPEvent) ?? message
      : message
  }

  private async processPluginChain<T>(
    initial: T,
    method: PluginMethod,
  ): Promise<T | null> {
    let current: T | null = initial

    for (const plugin of this.plugins) {
      try {
        const handler = plugin[method] as
          | ((data: T) => Promise<T | null>)
          | undefined
        if (handler) {
          const result = await handler(current!)
          if (!result) return null
          current = result
        }
      } catch (error) {
        this.handlePluginError(plugin, method, error)
      }
    }

    return current
  }

  private isValidPlugin = (plugin: CDPPlugin): boolean =>
    Boolean(plugin.onRequest || plugin.onResponse || plugin.onEvent)

  private handlePluginError(
    plugin: CDPPlugin,
    method: string,
    error: unknown,
  ): void {
    this.errorHandler.handleError({
      type: CDPErrorType.PLUGIN,
      code: PluginManager.PLUGIN_ERROR_CODE,
      message: `Plugin error in ${method}: ${error instanceof Error ? error.message : String(error)}`,
      recoverable: true,
      details: {
        plugin: plugin.name || 'unnamed',
        method,
        error: this.formatError(error),
      },
    })
  }

  private formatError = (error: unknown): PluginError | string =>
    error instanceof Error
      ? {
          name: error.name,
          message: error.message,
          stack: error.stack,
        }
      : String(error)

  getPlugins = (): CDPPlugin[] => [...this.plugins]

  hasPlugins = (): boolean => this.plugins.length > 0

  clearPlugins = async (): Promise<void> => {
    const cleanupPromises: Promise<void>[] = []
    
    for (const plugin of this.plugins) {
      if (!('cleanup' in plugin) || typeof plugin.cleanup !== 'function') continue

      try {
        plugin._state = { cleaning: true, cleanupStarted: Date.now() }
        
        const cleanupPromise = Promise.race([
          plugin.cleanup(),
          new Promise<void>((_, reject) => 
            setTimeout(() => reject(new Error(
              `Plugin ${plugin.name} cleanup timed out after ${PluginManager.CLEANUP_TIMEOUT}ms`
            )), PluginManager.CLEANUP_TIMEOUT)
          )
        ]).catch(error => {
          this.handlePluginError(plugin, 'cleanup', error)
          plugin._state = undefined
        })

        cleanupPromises.push(cleanupPromise)
      } catch (error) {
        this.handlePluginError(plugin, 'cleanup', error)
        plugin._state = undefined
      }
    }

    cleanupPromises.length && await Promise.all(cleanupPromises)
    this.plugins.length = 0
  }

  /**
   * Sends a CDP command on behalf of a plugin
   */
  async sendCDPCommand(
    endpoint: string,
    proxySessionId: string,
    message: CDPCommandRequest,
  ): Promise<CDPCommandResponse> {
    const session = this.sessionManager.getSession(proxySessionId)
    if (!session) {
      throw new Error(`Invalid proxy session ID: ${proxySessionId}`)
    }

    const { chromeSocket } = session
    if (chromeSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Chrome WebSocket connection is not open')
    }

    // Generate a unique plugin message ID
    const pluginMessageId = this.pluginMessageIdCounter++
    message.id = pluginMessageId

    return new Promise<CDPCommandResponse>((resolve, reject) => {
      try {
        // Set up timeout
        const timeoutId = setTimeout(() => {
          const pendingRequest = this.pluginRequestIdMap.get(pluginMessageId)
          if (pendingRequest) {
            this.pluginRequestIdMap.delete(pluginMessageId)
            reject(
              new Error(
                `CDP command timed out after ${PluginManager.PLUGIN_COMMAND_TIMEOUT}ms`,
              ),
            )
          }
        }, PluginManager.PLUGIN_COMMAND_TIMEOUT)

        // Store the promise handlers
        this.pluginRequestIdMap.set(pluginMessageId, {
          resolve,
          reject,
          timeoutId,
        })

        // Send the message
        chromeSocket.send(JSON.stringify(message))
      } catch (error) {
        this.pluginRequestIdMap.delete(pluginMessageId)
        reject(error)
      }
    })
  }

  /**
   * Emits a CDP event to the client on behalf of a plugin
   */
  async emitClientEvent(
    proxySessionId: string,
    event: CDPEvent,
  ): Promise<void> {
    const session = this.sessionManager.getSession(proxySessionId)
    if (!session) {
      throw new Error(`Invalid proxy session ID: ${proxySessionId}`)
    }

    const { clientSocket } = session
    if (clientSocket.readyState !== WebSocket.OPEN) {
      throw new Error('Client WebSocket connection is not open')
    }

    try {
      clientSocket.send(JSON.stringify(event))
    } catch (error) {
      throw new Error(
        `Failed to emit client event: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private isCommandResponse = (msg: CDPMessage): msg is CDPCommandResponse =>
    'id' in msg && !('method' in msg)

  // Add method to inject the helper functions into plugins
  private injectPluginHelpers(plugin: CDPPlugin): void {
    // Bind the helper methods to the *PluginManager* instance,
    // but assign them to the *plugin* instance.  This makes them
    // available via `this` within the plugin.
    plugin.sendCDPCommand = this.sendCDPCommand.bind(this);
    plugin.emitClientEvent = this.emitClientEvent.bind(this);
  }
}
