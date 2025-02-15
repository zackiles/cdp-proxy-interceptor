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

type PluginMethod = 'onRequest' | 'onResponse' | 'onEvent'
type ProcessResult<T> = Promise<T | null>
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

    this.plugins.push(plugin)
  }

  unregisterPlugin(plugin: CDPPlugin): void {
    const index = this.plugins.indexOf(plugin)
    index !== -1 && this.plugins.splice(index, 1)
  }

  async processRequest(request: CDPCommandRequest): ProcessResult<CDPCommandRequest> {
    return this.processPluginChain(request, 'onRequest')
  }

  async processResponse(response: CDPCommandResponse): ProcessResult<CDPCommandResponse> {
    return this.processPluginChain(response, 'onResponse')
  }

  async processEvent(event: CDPEvent): ProcessResult<CDPEvent> {
    return this.processPluginChain(event, 'onEvent')
  }

  async processMessage(message: unknown): Promise<CDPMessage | null> {
    const cdpMessage = message as CDPMessage
    
    // Add debug logging
    console.debug(`[CDP PLUGIN] Processing message:`, cdpMessage)
    
    // Check if this is a response to a plugin-initiated command
    if (this.isCommandResponse(cdpMessage)) {
      const { id } = cdpMessage
      const pendingRequest = this.pluginRequestIdMap.get(id)
      if (pendingRequest) {
        console.debug(`[CDP PLUGIN] Found pending request for ID ${id}`)
        const { resolve, reject, timeoutId } = pendingRequest
        clearTimeout(timeoutId)
        this.pluginRequestIdMap.delete(id)
        
        if ('error' in cdpMessage && cdpMessage.error) {
          console.debug(`[CDP PLUGIN] Rejecting pending request with error:`, cdpMessage.error)
          reject(new Error(cdpMessage.error.message || 'Unknown CDP error'))
        } else {
          console.debug(`[CDP PLUGIN] Resolving pending request with result:`, cdpMessage.result)
          resolve(cdpMessage)
        }
        return null // Don't forward plugin responses to the client
      }
    }
    
    let processedMessage: CDPMessage | null = cdpMessage
    for (const plugin of this.plugins) {
      if (!processedMessage) {
        console.debug(`[CDP PLUGIN] Message blocked by previous plugin`)
        break
      }
      
      try {
        if ('id' in processedMessage) {
          if ('result' in processedMessage || 'error' in processedMessage) {
            console.debug(`[CDP PLUGIN] Processing response through plugin ${plugin.name}`)
            processedMessage = await plugin.onResponse?.(processedMessage as CDPCommandResponse) ?? processedMessage
          } else {
            console.debug(`[CDP PLUGIN] Processing request through plugin ${plugin.name}`)
            processedMessage = await plugin.onRequest?.(processedMessage as CDPCommandRequest) ?? processedMessage
          }
        } else if ('method' in processedMessage) {
          console.debug(`[CDP PLUGIN] Processing event through plugin ${plugin.name}`)
          processedMessage = await plugin.onEvent?.(processedMessage as CDPEvent) ?? processedMessage
        }
      } catch (error) {
        console.error(`[CDP PLUGIN] Error in plugin ${plugin.name}:`, error)
        this.handlePluginError(plugin, 'processMessage', error)
      }
    }
    
    console.debug(`[CDP PLUGIN] Final processed message:`, processedMessage)
    return processedMessage
  }

  private async processPluginChain<T>(
    initial: T,
    method: PluginMethod,
  ): ProcessResult<T> {
    let current: T | null = initial

    for (const plugin of this.plugins) {
      try {
        const handler = plugin[method] as ((data: T) => Promise<T | null>) | undefined
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

  private handlePluginError(plugin: CDPPlugin, method: string, error: unknown): void {
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

  clearPlugins = (): void => {
    this.plugins.length = 0
  }

  /**
   * Sends a CDP command on behalf of a plugin
   */
  async sendCDPCommand(
    plugin: CDPPlugin,
    endpoint: string,
    proxySessionId: string,
    message: CDPCommandRequest
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
            reject(new Error(`CDP command timed out after ${PluginManager.PLUGIN_COMMAND_TIMEOUT}ms`))
          }
        }, PluginManager.PLUGIN_COMMAND_TIMEOUT)

        // Store the promise handlers
        this.pluginRequestIdMap.set(pluginMessageId, { resolve, reject, timeoutId })

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
    event: CDPEvent
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
      throw new Error(`Failed to emit client event: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private isCommandResponse = (msg: CDPMessage): msg is CDPCommandResponse =>
    'id' in msg && !('method' in msg)
}
