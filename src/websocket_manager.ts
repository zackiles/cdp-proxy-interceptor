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
    { close: () => void; error: () => void }
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

  setPluginManager(pluginManager: PluginManager): void {
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
    this.socketToSession.set(clientSocket, sessionId)
    this.socketToSession.set(chromeSocket, sessionId)

    const setupTasks: [string, () => void][] = [
      ['heartbeat', () => this.setupHeartbeat(clientSocket)],
      [
        'message handling',
        () => this.setupMessageHandling(clientSocket, chromeSocket, sessionId),
      ],
      [
        'error handling',
        () => this.setupErrorHandling(clientSocket, chromeSocket, sessionId),
      ],
    ]

    for (const [task, fn] of setupTasks) {
      console.log(`[CDP PROXY] Setting up ${task} for session ${sessionId}`)
      fn()
    }

    console.log(
      `[CDP PROXY] WebSocket connection initialization complete for session ${sessionId}`,
    )
  }

  private ensureSessionState = (
    sessionId: string,
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
  ): void => {
    !this.connectionStates.has(sessionId) &&
      this.connectionStates.set(sessionId, {
        clientReady: false,
        chromeReady: false,
        clientSocket,
        chromeSocket,
      })
    !this.pendingMessages.has(sessionId) &&
      this.pendingMessages.set(sessionId, [])
  }

  private setupHeartbeat = (ws: WebSocket): void => {
    this.clearHeartbeat(ws)
    const pingInterval = setInterval(
      () =>
        ws.readyState === WebSocket.OPEN
          ? (() => {
              try {
                ws.send('ping')
              } catch {
                this.clearHeartbeat(ws)
              }
            })()
          : this.clearHeartbeat(ws),
      WEBSOCKET_MANAGER.HEARTBEAT_INTERVAL,
    )

    const listeners = {
      close: () => this.clearHeartbeat(ws),
      error: () => this.clearHeartbeat(ws),
    }
    this.heartbeatListeners.set(ws, listeners)
    for (const [event, handler] of Object.entries(listeners)) {
      ws.addEventListener(event, handler)
    }
    this.heartbeatIntervals.set(ws, pingInterval)
  }

  private clearHeartbeat = (ws: WebSocket): void => {
    const interval = this.heartbeatIntervals.get(ws)
    interval && clearInterval(interval)
    this.heartbeatIntervals.delete(ws)

    const listeners = this.heartbeatListeners.get(ws)
    if (listeners) {
      for (const [event, handler] of Object.entries(listeners)) {
        ws.removeEventListener(event, handler)
      }
      this.heartbeatListeners.delete(ws)
    }
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
      const path = source._path || 'unknown'
      logMessage(direction, data, path)

      try {
        const message =
          data instanceof ArrayBuffer ? new TextDecoder().decode(data) : data
        const parsedMessage = JSON.parse(message) as CDPMessage
        console.debug(
          `[CDP PROXY] Parsed message from ${direction}:`,
          parsedMessage,
        )

        const processedMessage = this.pluginManager
          ? !isClientSource &&
            'id' in parsedMessage &&
            !('method' in parsedMessage)
            ? await this.pluginManager.processResponse(
                parsedMessage as CDPCommandResponse,
              )
            : await this.pluginManager.processMessage(parsedMessage)
          : parsedMessage

        if (!processedMessage) {
          console.debug('[CDP PROXY] Message blocked by plugin')
          return
        }

        const outDirection = isClientSource ? 'PROXY→BROWSER' : 'PROXY→CLIENT'
        const outMessage = JSON.stringify(processedMessage)
        const state = this.connectionStates.get(sessionId)

        if (!state) {
          this.bufferMessage(sessionId, isClientSource, outMessage)
          return
        }

        const canSendMessage = isClientSource
          ? chromeSocket.readyState === WebSocket.OPEN &&
            clientSocket.readyState === WebSocket.OPEN
          : clientSocket.readyState === WebSocket.OPEN

        if (canSendMessage) {
          logMessage(outDirection, outMessage, path)
          target.send(outMessage)
        } else {
          this.bufferMessage(
            sessionId,
            isClientSource,
            outMessage,
            isClientSource
              ? chromeSocket.readyState !== WebSocket.OPEN
                ? `Chrome socket not ready (state: ${chromeSocket.readyState})`
                : `Client socket not ready (state: ${clientSocket.readyState})`
              : `Client socket not ready (state: ${clientSocket.readyState})`,
          )
        }
      } catch (error) {
        console.error(`[CDP PROXY] Error handling message:`, error)
        this.handleWebSocketError(
          isClientSource ? 'client' : 'chrome',
          error,
          sessionId,
        )
      }
    }

    clientSocket.onmessage = ({ data }) =>
      handleMessage(clientSocket, chromeSocket, data)
    chromeSocket.onmessage = ({ data }) =>
      handleMessage(chromeSocket, clientSocket, data)
  }

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
    const logConnection = (
      type: WebSocketSource,
      status: WebSocketConnectionStatus,
    ) =>
      console.debug(
        `[CDP PROXY] %c${type === 'client' ? 'CLIENT' : 'BROWSER'} CONNECTED%c | Session ${sessionId} | ${status}`,
        WEBSOCKET_MANAGER.LOG_STYLE,
        '',
      )

    const handleSocketEvent =
      (source: WebSocketSource, eventType: 'close' | 'error' | 'open') =>
      (event?: CloseEvent | Event) => {
        const socket = source === 'client' ? clientSocket : chromeSocket
        const sessionId = this.socketToSession.get(socket) ?? 'unknown'

        if (eventType === 'close') {
          const closeEvent = event as CloseEvent
          logConnection(source, 'DISCONNECTED')
          console.debug(`[CDP PROXY] Socket closed for ${source}:`, {
            sessionId,
            code: closeEvent?.code,
            reason: closeEvent?.reason,
            wasClean: closeEvent?.wasClean,
            cleanupInProgress: this.cleanupInProgress.has(sessionId),
          })

          if (!this.cleanupInProgress.has(sessionId)) {
            const state = this.connectionStates.get(sessionId)
            if (state) {
              const prevState = {
                clientReady: state.clientReady,
                chromeReady: state.chromeReady,
              }
              if (source === 'client') {
                state.clientReady = false
              } else {
                state.chromeReady = false
              }
              console.debug(
                `[CDP PROXY] Updated connection state after ${source} close:`,
                {
                  prevState,
                  newState: {
                    clientReady: state.clientReady,
                    chromeReady: state.chromeReady,
                  },
                },
              )
            }
          }
        } else if (eventType === 'error') {
          this.handleWebSocketError(source, event, sessionId)
          socket.readyState === WebSocket.OPEN &&
            socket.close(1006, 'Error occurred')
        } else if (eventType === 'open') {
          logConnection(source, 'CONNECTED')
          const state = this.connectionStates.get(sessionId) ?? {
            clientReady: source === 'client',
            chromeReady: source === 'chrome',
            clientSocket,
            chromeSocket,
          }

          if (source === 'client') {
            state.clientReady = true
          } else {
            state.chromeReady = true
          }
          this.connectionStates.set(sessionId, state)

          if (
            state.clientReady &&
            state.chromeReady &&
            clientSocket.readyState === WebSocket.OPEN &&
            chromeSocket.readyState === WebSocket.OPEN
          ) {
            this.processPendingMessages(sessionId, clientSocket, chromeSocket)
          }
        }
      }

    const setupSocket = (socket: WebSocket, source: WebSocketSource) => {
      socket.onopen = handleSocketEvent(source, 'open')
      socket.onclose = handleSocketEvent(source, 'close')
      socket.onerror = handleSocketEvent(source, 'error')
    }

    setupSocket(clientSocket, 'client')
    setupSocket(chromeSocket, 'chrome')

    chromeSocket.readyState === WebSocket.OPEN &&
      handleSocketEvent('chrome', 'open')()
  }

  private processPendingMessages = (
    sessionId: string,
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
  ): void => {
    const pending = this.pendingMessages.get(sessionId) ?? []
    const canSendToChrome =
      chromeSocket.readyState === WebSocket.OPEN &&
      clientSocket.readyState === WebSocket.OPEN
    const canSendToClient = clientSocket.readyState === WebSocket.OPEN

    const processMessages = (
      messages: WebSocketPendingMessage[],
      target: WebSocket,
    ) => {
      for (const { message } of messages) {
        target.send(message)
      }
    }

    canSendToChrome &&
      processMessages(
        pending.filter((m) => m.source === 'client'),
        chromeSocket,
      )
    canSendToClient &&
      processMessages(
        pending.filter((m) => m.source === 'chrome'),
        clientSocket,
      )

    canSendToChrome &&
      canSendToClient &&
      this.pendingMessages.set(sessionId, [])
  }

  private handleWebSocketError = (
    source: WebSocketSource,
    error: unknown,
    sessionId: string,
  ): void => {
    const errorMessage =
      error instanceof Error
        ? error.message
        : error instanceof ErrorEvent
          ? (error.error?.message ?? error.message)
          : String(error)

    const isDisconnectionError = errorMessage
      .toLowerCase()
      .match(/(disconnected|unexpected eof|connection.*closed)/i)
    isDisconnectionError
      ? console.debug(
          `[CDP PROXY] ${source} WebSocket disconnected: ${errorMessage}`,
        )
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
  public cleanup(sessionId: string): void {
    console.debug(`[CDP PROXY] Starting cleanup for session ${sessionId}:`, {
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
