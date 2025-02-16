import type { Session } from './types.ts'
import type { ErrorHandler } from './error_handler.ts'
import { CDPErrorType } from './types.ts'

const ERROR_CODES = {
  SESSION_NOT_FOUND: 4001,
  CLEANUP_FAILED: 1001,
} as const

/**
 * Manages CDP session lifecycle and WebSocket connections
 * Handles session creation, cleanup, and tracking
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly errorHandler: ErrorHandler
  private totalSessionsCreated = 0

  constructor(errorHandler: ErrorHandler) {
    this.errorHandler = errorHandler
  }

  /**
   * Creates a new session with proper initialization and validation
   * @param clientSocket WebSocket connection from the client
   * @param chromeSocket WebSocket connection to Chrome
   * @param chromeWsUrl Chrome WebSocket URL
   * @param sessionId Optional session ID (will be generated if not provided)
   * @returns The created session
   */
  createSession(
    clientSocket: WebSocket,
    chromeSocket: WebSocket,
    chromeWsUrl: string,
    sessionId = crypto.randomUUID(),
  ): Session {
    const session: Session = {
      id: sessionId,
      clientSocket,
      chromeSocket,
      chromeWsUrl,
      active: true,
      createdAt: Date.now(),
    }

    this.sessions.set(session.id, session)
    this.totalSessionsCreated++
    return session
  }

  /**
   * Gets a session by ID
   * @param sessionId The session ID to look up
   * @returns The session if found, undefined otherwise
   */
  getSession(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.errorHandler.handleError({
        type: CDPErrorType.CONNECTION,
        code: ERROR_CODES.SESSION_NOT_FOUND,
        message: `Session not found: ${sessionId}`,
        recoverable: true,
        details: { sessionId },
      })
    }
    return session
  }

  /**
   * Safely removes a session and cleans up resources
   * @param sessionId The session ID to remove
   */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    try {
      session.active = false
      this.closeWebSockets(session)
    } catch (error) {
      this.errorHandler.handleError(
        {
          type: CDPErrorType.CONNECTION,
          code: ERROR_CODES.CLEANUP_FAILED,
          message: 'Failed to cleanup session',
          recoverable: true,
          details: error,
        },
        session,
      )
    } finally {
      this.sessions.delete(sessionId)
    }
  }

  /**
   * Returns all active sessions
   * @returns Array of active sessions
   */
  getActiveSessions(): Session[] {
    return Array.from(this.sessions.values()).filter((s) => s.active)
  }

  /**
   * Gets statistics about all sessions for monitoring and debugging purposes
   * @returns Object containing detailed session statistics including:
   * - total: Total number of sessions created since startup
   * - active: Current number of active sessions
   * - sessions: Detailed array of session information including connection states
   * @testing Used in tests to verify session lifecycle management
   * @monitoring Can be used for health checks and debugging session issues
   */
  getSessionStats(): {
    total: number
    active: number
    sessions: Array<{
      id: string
      active: boolean
      createdAt: number
      clientConnected: boolean
      chromeConnected: boolean
    }>
  } {
    const sessions = Array.from(this.sessions.values())
    const stats = sessions.map((session) => ({
      id: session.id,
      active: session.active,
      createdAt: session.createdAt,
      clientConnected: session.clientSocket.readyState === WebSocket.OPEN,
      chromeConnected: session.chromeSocket.readyState === WebSocket.OPEN,
    }))

    return {
      total: this.totalSessionsCreated,
      active: sessions.filter((s) => s.active).length,
      sessions: stats,
    }
  }

  /**
   * Cleans up all sessions and their resources
   */
  cleanup(): void {
    const activeSessions = this.getActiveSessions()

    for (const session of activeSessions) {
      try {
        this.closeWebSockets(session)
        this.removeSession(session.id)
      } catch (error) {
        this.errorHandler.handleError(
          {
            type: CDPErrorType.CONNECTION,
            code: ERROR_CODES.CLEANUP_FAILED,
            message: `Failed to cleanup session ${session.id}`,
            recoverable: true,
            details: error,
          },
          session,
        )
      }
    }

    this.sessions.clear()
  }

  private closeWebSockets(session: Session): void {
    if (session.clientSocket.readyState === WebSocket.OPEN) {
      session.clientSocket.close()
    }
    if (session.chromeSocket.readyState === WebSocket.OPEN) {
      session.chromeSocket.close()
    }
  }
}
