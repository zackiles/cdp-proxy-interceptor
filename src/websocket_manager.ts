import type { ErrorHandler } from './error_handler.ts'
import type { SchemaValidator } from './schema_validator.ts'
import type { PluginManager } from './plugin_manager.ts'
import { 
  CDPEvent, 
  CDPCommandResponse, 
  CDPCommandRequest, 
  CDPErrorType, 
  CDPError, 
  CDPMessage,
  WebSocketConnectionState,
  WebSocketSource,
  WebSocketConnectionStatus,
  WebSocketPendingMessage
} from './types.ts'
import type { ChromeManager } from './chrome_manager.ts'
import { WEBSOCKET_MANAGER } from './constants.ts'

/**
 * Manages WebSocket connections and message handling between client and Chrome
 * @class WebSocketManager
 */
export class WebSocketManager {
  private readonly connectionStates = new Map<string, WebSocketConnectionState>()
  private readonly pendingMessages = new Map<string, WebSocketPendingMessage[]>()
  private readonly cleanupInProgress = new Set<string>()
  private readonly heartbeatIntervals = new Map<WebSocket, number>()
  private readonly heartbeatListeners = new Map<WebSocket, { close: () => void; error: () => void }>()
  private readonly socketToSession = new Map<WebSocket, string>()

  /**
   * Creates a new WebSocket manager instance
   * @param errorHandler - Handles CDP errors
   * @param validator - Validates CDP messages
   * @param pluginManager - Processes CDP messages through plugins
   * @param chromeManager - Optional Chrome instance manager for cleanup coordination
   */
  constructor(
    private readonly errorHandler: ErrorHandler,
    private readonly validator: SchemaValidator,
    private readonly pluginManager: PluginManager,
    private readonly chromeManager?: ChromeManager,
  ) {}

  /**
   * Sets up WebSocket connection handlers and message processing
   */
  handleConnection = (clientSocket: WebSocket, chromeSocket: WebSocket, sessionId: string): void =>
    this.cleanupInProgress.has(sessionId)
      ? this.handlePendingCleanup(clientSocket, chromeSocket, sessionId)
      : this.initializeConnection(clientSocket, chromeSocket, sessionId)

  private handlePendingCleanup = (
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
    sessionId: string,
  ): void => {
    console.debug(`[CDP PROXY] Waiting for cleanup of session ${sessionId}`)
    setTimeout(
      () =>
        !this.cleanupInProgress.has(sessionId)
          ? this.initializeConnection(clientSocket, chromeSocket, sessionId)
          : this.errorHandler.handleError({
              type: CDPErrorType.CONNECTION,
              code: 1007,
              message: `Failed to initialize connection - cleanup timeout for session ${sessionId}`,
              recoverable: true,
              details: { sessionId },
            }),
      WEBSOCKET_MANAGER.CLEANUP_TIMEOUT,
    )
  }

  private initializeConnection = (
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
    sessionId: string,
  ): void => {
    this.ensureSessionState(sessionId, clientSocket, chromeSocket)
    this.socketToSession.set(clientSocket, sessionId)
    this.socketToSession.set(chromeSocket, sessionId)
    this.setupHeartbeat(clientSocket)
    this.setupMessageHandling(clientSocket, chromeSocket, sessionId)
    this.setupErrorHandling(clientSocket, chromeSocket, sessionId)
  }

  private ensureSessionState = (sessionId: string, clientSocket: WebSocket, chromeSocket: WebSocket): void => {
    !this.connectionStates.has(sessionId) && this.connectionStates.set(sessionId, {
      clientReady: false,
      chromeReady: false,
      clientSocket,
      chromeSocket
    })
    !this.pendingMessages.has(sessionId) && this.pendingMessages.set(sessionId, [])
  }

  private setupHeartbeat = (ws: WebSocket): void => {
    this.clearHeartbeat(ws)
    const pingInterval = setInterval(
      () => ws.readyState === WebSocket.OPEN
        ? (() => { try { ws.send('ping') } catch { this.clearHeartbeat(ws) } })()
        : this.clearHeartbeat(ws),
      WEBSOCKET_MANAGER.HEARTBEAT_INTERVAL,
    )

    const listeners = {
      close: () => this.clearHeartbeat(ws),
      error: () => this.clearHeartbeat(ws),
    }

    this.heartbeatListeners.set(ws, listeners)
    ws.addEventListener('close', listeners.close)
    ws.addEventListener('error', listeners.error)
    this.heartbeatIntervals.set(ws, pingInterval)
  }

  private clearHeartbeat = (ws: WebSocket): void => {
    const interval = this.heartbeatIntervals.get(ws)
    interval && clearInterval(interval)
    this.heartbeatIntervals.delete(ws)

    const listeners = this.heartbeatListeners.get(ws)
    if (listeners) {
      ws.removeEventListener('close', listeners.close)
      ws.removeEventListener('error', listeners.error)
      this.heartbeatListeners.delete(ws)
    }
  }

  private setupMessageHandling = (
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
    sessionId: string,
  ): void => {
    const logMessage = (direction: string, data: string | ArrayBuffer, path: string) => {
      const message = data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data
      console.debug(
        `[CDP PROXY] %c${direction}%c | Path ${path} |`,
        WEBSOCKET_MANAGER.LOG_STYLE,
        '',
        Deno.inspect(message, {colors: true, depth: 1}),
      )
    }

    const handleMessage = async (source: WebSocket, target: WebSocket, data: string | ArrayBuffer) => {
      const isClientSource = source === clientSocket
      const direction = isClientSource ? 'CLIENT→PROXY' : 'BROWSER→PROXY'
      const path = (source as any)._path || 'unknown'
      logMessage(direction, data, path)

      try {
        const message = data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data
        const parsedMessage = JSON.parse(message) as CDPMessage
        
        const processedMessage = await (isClientSource
          ? this.pluginManager.processRequest(parsedMessage as CDPCommandRequest)
          : this.validator.isEvent(parsedMessage)
            ? await this.pluginManager.processEvent(parsedMessage as CDPEvent)
            : await this.pluginManager.processResponse(parsedMessage as CDPCommandResponse))

        if (!processedMessage) {
          console.debug('[CDP PROXY] Message blocked by plugin')
          return
        }

        const outDirection = isClientSource ? 'PROXY→BROWSER' : 'PROXY→CLIENT'
        const outMessage = JSON.stringify(processedMessage)

        target.readyState === WebSocket.OPEN
          ? (logMessage(outDirection, outMessage, path), target.send(outMessage))
          : this.bufferMessage(sessionId, isClientSource, outMessage)
      } catch (error) {
        this.handleWebSocketError(isClientSource ? 'client' : 'chrome', error, sessionId)
      }
    }

    clientSocket.onmessage = ({ data }) => handleMessage(clientSocket, chromeSocket, data)
    chromeSocket.onmessage = ({ data }) => handleMessage(chromeSocket, clientSocket, data)
  }

  private bufferMessage = (sessionId: string, isClientSource: boolean, message: string): void => {
    const pending = this.pendingMessages.get(sessionId) ?? []
    pending.length >= WEBSOCKET_MANAGER.MAX_PENDING_MESSAGES && pending.shift()
    pending.push({ source: isClientSource ? 'client' : 'chrome', message })
    this.pendingMessages.set(sessionId, pending)
  }

  private setupErrorHandling = (
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
    sessionId: string,
  ): void => {
    const logConnection = (type: WebSocketSource, status: WebSocketConnectionStatus) =>
      console.debug(
        `[CDP PROXY] %c${type === 'client' ? 'CLIENT' : 'BROWSER'} CONNECTED%c | Session ${sessionId} | ${status}`,
        WEBSOCKET_MANAGER.LOG_STYLE,
        '',
      )

    const handleClose = (source: WebSocketSource) => (event: CloseEvent) => {
      const sessionId = this.socketToSession.get(source === 'client' ? clientSocket : chromeSocket) ?? 'unknown'
      logConnection(source, 'DISCONNECTED')
      
      if ((source === 'chrome' && this.chromeManager?.isKilling) || this.cleanupInProgress.has(sessionId)) {
        console.debug(`[CDP PROXY] Clean disconnect for ${source}`)
        return
      }

      const state = this.connectionStates.get(sessionId)
      state && (source === 'client' ? (state.clientReady = false) : (state.chromeReady = false))
    }

    const handleError = (source: WebSocketSource) => (error: Event) => {
      this.handleWebSocketError(source, error, sessionId)
      const socket = source === 'client' ? clientSocket : chromeSocket
      socket.readyState === WebSocket.OPEN && socket.close(1006, 'Error occurred')
    }

    const handleOpen = (source: WebSocketSource) => () => {
      logConnection(source, 'CONNECTED')
      const state = this.connectionStates.get(sessionId)
      if (state) {
        source === 'client' ? (state.clientReady = true) : (state.chromeReady = true)
      } else {
        this.connectionStates.set(sessionId, {
          clientReady: source === 'client',
          chromeReady: source === 'chrome',
          clientSocket,
          chromeSocket
        })
      }

      const updatedState = this.connectionStates.get(sessionId)!
      updatedState.clientReady && updatedState.chromeReady && this.processPendingMessages(sessionId, clientSocket, chromeSocket)
    }

    clientSocket.onopen = handleOpen('client')
    chromeSocket.onopen = handleOpen('chrome')
    clientSocket.onclose = handleClose('client')
    chromeSocket.onclose = handleClose('chrome')
    clientSocket.onerror = handleError('client')
    chromeSocket.onerror = handleError('chrome')
  }

  private processPendingMessages = (
    sessionId: string,
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
  ): void => {
    const pending = this.pendingMessages.get(sessionId) ?? []
    const clientMessages = pending.filter(m => m.source === 'client')
    const chromeMessages = pending.filter(m => m.source === 'chrome')

    clientMessages.forEach(
      ({ message }) => chromeSocket.readyState === WebSocket.OPEN && chromeSocket.send(message),
    )
    chromeMessages.forEach(
      ({ message }) => clientSocket.readyState === WebSocket.OPEN && clientSocket.send(message),
    )

    this.pendingMessages.set(sessionId, [])
  }

  private handleWebSocketError = (
    source: WebSocketSource,
    error: unknown,
    sessionId: string,
  ): void => {
    const errorMessage = error instanceof Error 
      ? error.message 
      : error instanceof ErrorEvent 
        ? error.error?.message ?? error.message 
        : String(error)

    // Check if this is a normal disconnection or if we should suppress the error
    const isDisconnectionError = errorMessage.toLowerCase().match(/(disconnected|unexpected eof|connection.*closed)/i)
    const shouldSuppressError = isDisconnectionError || (source === 'chrome' && this.chromeManager?.shouldSuppressError())

    if (shouldSuppressError) {
      console.debug(`[CDP PROXY] ${source} WebSocket disconnected: ${errorMessage}`)
      return
    }

    // Only report actual errors, not normal disconnections
    const cdpError: CDPError = {
      type: CDPErrorType.CONNECTION,
      code: 1006,
      message: `${source} WebSocket error: ${errorMessage}`,
      recoverable: true,
      details: { error, sessionId },
    }
    this.errorHandler.handleError(cdpError)
  }

  private cleanup = (sessionId: string): void => {
    this.cleanupInProgress.add(sessionId)
    try {
      const state = this.connectionStates.get(sessionId)
      state && [...this.heartbeatIntervals.keys()].forEach(this.clearHeartbeat)
      this.connectionStates.delete(sessionId)
      this.pendingMessages.delete(sessionId)
      this.socketToSession.clear()
    } finally {
      this.cleanupInProgress.delete(sessionId)
    }
  }
}
