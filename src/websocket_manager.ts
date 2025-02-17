import type { ErrorHandler } from './error_handler.ts'
import type { SchemaValidator } from './schema_validator.ts'
import type { PluginManager } from './plugin_manager.ts'
import {
  type CDPCommandResponse,
  CDPErrorType,
  type CDPMessage,
  type WebSocketConnectionState,
  type WebSocketSource,
  type WebSocketConnectionStatus,
  type WebSocketPendingMessage,
} from './types.ts'
import { WEBSOCKET_MANAGER } from './constants.ts'

// Add WebSocket path property to global interface
declare global {
  interface WebSocket {
    _path?: string
  }
}

/**
 * Manages WebSocket connections and message handling between client and Chrome
 * @class WebSocketManager
 */
export class WebSocketManager {
  private readonly connectionStates = new Map<
    string,
    WebSocketConnectionState
  >()
  private readonly pendingMessages = new Map<
    string,
    WebSocketPendingMessage[]
  >()
  private readonly cleanupInProgress = new Set<string>()
  private readonly heartbeatIntervals = new Map<WebSocket, number>()
  private readonly heartbeatListeners = new Map<
    WebSocket,
    Record<'close' | 'error', () => void>
  >()
  private readonly socketToSession = new Map<WebSocket, string>()
  private pluginManager: PluginManager | null = null

  /**
   * Creates a new WebSocket manager instance
   * @param errorHandler - Handles CDP errors
   * @param validator - Validates CDP messages
   * @param pluginManager - Optional plugin manager (can be set later)
   */
  constructor(
    private readonly errorHandler: ErrorHandler,
    private readonly validator: SchemaValidator,
    pluginManager?: PluginManager | null,
  ) {
    this.pluginManager = pluginManager ?? null
  }

  setPluginManager = (pluginManager: PluginManager): void => {
    this.pluginManager = pluginManager
  }

  handleConnection = (
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
    sessionId: string,
  ): void => {
    console.log(
      `[CDP PROXY] WebSocketManager handling connection for session ${sessionId}`,
    )
    this.cleanupInProgress.has(sessionId)
      ? this.handlePendingCleanup(clientSocket, chromeSocket, sessionId)
      : this.initializeConnection(clientSocket, chromeSocket, sessionId)
  }

  private handlePendingCleanup = (
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
    sessionId: string,
  ): void => {
    console.log(`[CDP PROXY] Waiting for cleanup of session ${sessionId}`)
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
    console.log(
      `[CDP PROXY] Initializing WebSocket connection for session ${sessionId}`,
    )
    this.ensureSessionState(sessionId, clientSocket, chromeSocket)
    this.socketToSession.set(clientSocket, sessionId).set(chromeSocket, sessionId)

    const setupTasks = {
      heartbeat: () => this.setupHeartbeat(clientSocket),
      'message handling': () => this.setupMessageHandling(clientSocket, chromeSocket, sessionId),
      'error handling': () => this.setupErrorHandling(clientSocket, chromeSocket, sessionId),
    }

    Object.entries(setupTasks).forEach(([task, fn]) => {
      console.log(`[CDP PROXY] Setting up ${task} for session ${sessionId}`)
      fn()
    })

    console.log(
      `[CDP PROXY] WebSocket connection initialization complete for session ${sessionId}`,
    )
  }

  private ensureSessionState = (
    sessionId: string,
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
  ): void => {
    const defaultState = {
      clientReady: false,
      chromeReady: false,
      clientSocket,
      chromeSocket,
    }
    this.connectionStates.set(sessionId, this.connectionStates.get(sessionId) ?? defaultState)
    this.pendingMessages.set(sessionId, this.pendingMessages.get(sessionId) ?? [])
  }

  private setupHeartbeat = (ws: WebSocket): void => {
    this.clearHeartbeat(ws)
    
    const pingInterval = setInterval(
      () => ws.readyState === WebSocket.OPEN 
        ? Promise.resolve(ws.send('ping')).catch(() => this.clearHeartbeat(ws))
        : this.clearHeartbeat(ws),
      WEBSOCKET_MANAGER.HEARTBEAT_INTERVAL,
    )

    const listeners = {
      close: () => this.clearHeartbeat(ws),
      error: () => this.clearHeartbeat(ws),
    }

    Object.entries(listeners).forEach(([event, handler]) => 
      ws.addEventListener(event, handler))

    this.heartbeatListeners.set(ws, listeners)
    this.heartbeatIntervals.set(ws, pingInterval)
  }

  private clearHeartbeat = (ws: WebSocket): void => {
    const interval = this.heartbeatIntervals.get(ws)
    interval && clearInterval(interval)
    this.heartbeatIntervals.delete(ws)

    const listeners = this.heartbeatListeners.get(ws)
    listeners && Object.entries(listeners).forEach(([event, handler]) => 
      ws.removeEventListener(event, handler))
    this.heartbeatListeners.delete(ws)
  }

  private setupMessageHandling = (
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
    sessionId: string,
  ): void => {
    const logMessage = (
      direction: string,
      data: string | ArrayBuffer,
      path: string,
    ) =>
      console.debug(
        `[CDP PROXY] %c${direction}%c | Path ${path} |`,
        WEBSOCKET_MANAGER.LOG_STYLE,
        '',
        Deno.inspect(
          data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data,
          { colors: true, depth: 1 },
        ),
      )

    const handleMessage = async (
      source: WebSocket,
      target: WebSocket,
      data: string | ArrayBuffer,
    ) => {
      const isClientSource = source === clientSocket
      const direction = isClientSource ? 'CLIENT→PROXY' : 'BROWSER→PROXY'
      const path = source._path ?? 'unknown'
      
      logMessage(direction, data, path)

      try {
        const message =
          data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data
        const parsedMessage = JSON.parse(message) as CDPMessage
        
        const processedMessage = this.pluginManager
          ? await this.processPluginMessage(parsedMessage, isClientSource)
          : parsedMessage

        if (!processedMessage) return

        const outDirection = isClientSource ? 'PROXY→BROWSER' : 'PROXY→CLIENT'
        const outMessage = JSON.stringify(processedMessage)
        const state = this.connectionStates.get(sessionId)

        if (!state) {
          this.bufferMessage(sessionId, isClientSource, outMessage)
          return
        }

        const canSend = this.canSendMessage(isClientSource, clientSocket, chromeSocket)
        canSend
          ? (logMessage(outDirection, outMessage, path), target.send(outMessage))
          : this.bufferMessage(
              sessionId,
              isClientSource,
              outMessage,
              this.getSocketStateMessage(isClientSource, clientSocket, chromeSocket),
            )
      } catch (error) {
        console.error(`[CDP PROXY] Error handling message:`, error)
        this.handleWebSocketError(isClientSource ? 'client' : 'chrome', error, sessionId)
      }
    }

    clientSocket.onmessage = ({ data }) => handleMessage(clientSocket, chromeSocket, data)
    chromeSocket.onmessage = ({ data }) => handleMessage(chromeSocket, clientSocket, data)
  }

  private processPluginMessage = async (
    message: CDPMessage,
    isClientSource: boolean,
  ): Promise<CDPMessage | null> => {
    if (!this.pluginManager) return message
    
    return !isClientSource && 'id' in message && !('method' in message)
      ? await this.pluginManager.processResponse(message as CDPCommandResponse)
      : await this.pluginManager.processMessage(message)
  }

  private canSendMessage = (
    isClientSource: boolean,
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
  ): boolean =>
    isClientSource
      ? chromeSocket.readyState === WebSocket.OPEN && clientSocket.readyState === WebSocket.OPEN
      : clientSocket.readyState === WebSocket.OPEN

  private getSocketStateMessage = (
    isClientSource: boolean,
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
  ): string =>
    isClientSource
      ? chromeSocket.readyState !== WebSocket.OPEN
        ? `Chrome socket not ready (state: ${chromeSocket.readyState})`
        : `Client socket not ready (state: ${clientSocket.readyState})`
      : `Client socket not ready (state: ${clientSocket.readyState})`

  private bufferMessage = (
    sessionId: string,
    isClientSource: boolean,
    message: string,
    reason?: string,
  ): void => {
    reason &&
      console.debug(
        `[CDP PROXY] Cannot send message (${reason}), buffering message`,
      )
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
    const logConnection = (type: WebSocketSource, status: WebSocketConnectionStatus): void =>
      console.debug(
        `[CDP PROXY] %c${type.toUpperCase()} ${status}%c | Session ${sessionId}`,
        WEBSOCKET_MANAGER.LOG_STYLE,
        '',
      )

    const updateConnectionState = (source: WebSocketSource, isConnected: boolean): void => {
      const state = this.connectionStates.get(sessionId)
      if (!state || this.cleanupInProgress.has(sessionId)) return

      const prevState = { clientReady: state.clientReady, chromeReady: state.chromeReady }
      source === 'client' ? state.clientReady = isConnected : state.chromeReady = isConnected

      console.debug('[CDP PROXY] Updated connection state:', { prevState, newState: { 
        clientReady: state.clientReady, 
        chromeReady: state.chromeReady 
      }})
    }

    const handleSocketEvent = (source: WebSocketSource) => ({
      open: (_: Event) => {
        logConnection(source, 'CONNECTED')
        updateConnectionState(source, true)

        const state = this.connectionStates.get(sessionId) ?? {
          clientReady: source === 'client',
          chromeReady: source === 'chrome',
          clientSocket,
          chromeSocket,
        }
        this.connectionStates.set(sessionId, state)

        const bothReady = state.clientReady && 
          state.chromeReady && 
          clientSocket.readyState === WebSocket.OPEN && 
          chromeSocket.readyState === WebSocket.OPEN

        bothReady && this.processPendingMessages(sessionId, clientSocket, chromeSocket)
      },
      close: (ev: CloseEvent) => {
        logConnection(source, 'DISCONNECTED')
        console.debug(`[CDP PROXY] Socket closed for ${source}:`, {
          sessionId,
          code: ev?.code,
          reason: ev?.reason,
          wasClean: ev?.wasClean,
          cleanupInProgress: this.cleanupInProgress.has(sessionId),
        })
        !this.cleanupInProgress.has(sessionId) && updateConnectionState(source, false)
      },
      error: (ev: Event | ErrorEvent) => {
        this.handleWebSocketError(source, ev, sessionId)
        const socket = source === 'client' ? clientSocket : chromeSocket
        socket.readyState === WebSocket.OPEN && socket.close(1006, 'Error occurred')
      }
    })

    const setupSocket = (socket: WebSocket, source: WebSocketSource): void => {
      const handlers = handleSocketEvent(source)
      socket.onopen = handlers.open
      socket.onclose = handlers.close
      socket.onerror = handlers.error
    }

    setupSocket(clientSocket, 'client')
    setupSocket(chromeSocket, 'chrome')
    chromeSocket.readyState === WebSocket.OPEN && handleSocketEvent('chrome').open(new Event('open'))
  }

  private processPendingMessages = (
    sessionId: string,
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
  ): void => {
    const pending = this.pendingMessages.get(sessionId) ?? []
    const socketStates = {
      toChrome: chromeSocket.readyState === WebSocket.OPEN && clientSocket.readyState === WebSocket.OPEN,
      toClient: clientSocket.readyState === WebSocket.OPEN
    }

    const sendMessages = (messages: WebSocketPendingMessage[], target: WebSocket): void =>
      messages.forEach(({ message }) => target.send(message))

    socketStates.toChrome && sendMessages(
      pending.filter(m => m.source === 'client'),
      chromeSocket
    )

    socketStates.toClient && sendMessages(
      pending.filter(m => m.source === 'chrome'),
      clientSocket
    )

    socketStates.toChrome && socketStates.toClient && this.pendingMessages.set(sessionId, [])
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

    const isDisconnectionError = /disconnected|unexpected eof|connection.*closed/i.test(errorMessage)
    
    isDisconnectionError
      ? console.debug(`[CDP PROXY] ${source} WebSocket disconnected: ${errorMessage}`)
      : this.errorHandler.handleError({
          type: CDPErrorType.CONNECTION,
          code: 1006,
          message: `${source} WebSocket error: ${errorMessage}`,
          recoverable: true,
          details: { error, sessionId },
        })
  }

  /**
   * Cleans up resources for a specific session
   * @param sessionId - The ID of the session to clean up
   */
  public cleanup = (sessionId: string): void => {
    console.debug('[CDP PROXY] Starting cleanup:', {
      sessionId,
      hasState: this.connectionStates.has(sessionId),
      hasPendingMessages: this.pendingMessages.has(sessionId),
      socketToSessionSize: this.socketToSession.size,
    })

    this.cleanupInProgress.add(sessionId)
    try {
      const state = this.connectionStates.get(sessionId)
      state && [...this.heartbeatIntervals.keys()].forEach(this.clearHeartbeat)
      
      this.connectionStates.delete(sessionId)
      this.pendingMessages.delete(sessionId)
      this.socketToSession.clear()
      
      console.debug(`[CDP PROXY] Cleanup completed for session ${sessionId}`)
    } finally {
      this.cleanupInProgress.delete(sessionId)
    }
  }
}
