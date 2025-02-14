import type {
  CDPPlugin,
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
  CDPMessage,
} from './types.ts'
import type { ErrorHandler } from './error_handler.ts'
import { CDPErrorType } from './types.ts'

type PluginMethod = 'onRequest' | 'onResponse' | 'onEvent'
type ProcessResult<T> = Promise<T | null>
type PluginError = {
  name: string
  message: string
  stack?: string
}

/**
 * Manages CDP plugins for request/response/event processing
 */
export class PluginManager {
  private static readonly PLUGIN_ERROR_CODE = 2002
  private static readonly INVALID_PLUGIN_CODE = 2001

  private readonly plugins: CDPPlugin[] = []

  constructor(private readonly errorHandler: ErrorHandler) {}

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
    
    let processedMessage: CDPMessage | null = cdpMessage
    for (const plugin of this.plugins) {
      if (!processedMessage) break
      
      if ('id' in processedMessage) {
        if ('result' in processedMessage || 'error' in processedMessage) {
          processedMessage = await plugin.onResponse?.(processedMessage as CDPCommandResponse) ?? processedMessage
        } else {
          processedMessage = await plugin.onRequest?.(processedMessage as CDPCommandRequest) ?? processedMessage
        }
      } else if ('method' in processedMessage) {
        processedMessage = await plugin.onEvent?.(processedMessage as CDPEvent) ?? processedMessage
      }
    }
    
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
}
