import { CDPError, CDPErrorType, Session } from './types.ts'

export class ErrorHandler {
  private static readonly ERROR_THRESHOLDS = {
    [CDPErrorType.CONNECTION]: 3,
    [CDPErrorType.PROTOCOL]: 5,
    [CDPErrorType.VALIDATION]: 10,
    [CDPErrorType.RESOURCE]: 1,
    [CDPErrorType.PLUGIN]: 3,
  }

  private errorCounts = new Map<string, Map<CDPErrorType, number>>()
  handleError(error: CDPError, session?: Session): void {
    console.error(`[${error.type}] ${error.message}`, {
      sessionId: session?.id,
      code: error.code,
      details: error.details,
      recoverable: error.recoverable,
    })

    this.incrementErrorCount(error.type, session?.id)

    if (error.recoverable) {
      this.attemptRecovery(error, session)
    } else {
      this.handleUnrecoverableError(
        {
          ...error,
          recoverable: false,
          message: `Error threshold exceeded for ${error.type}: ${error.message}`,
        },
        session,
      )
    }
  }

  /**
   * Increments the error count for a specific error type and session
   * @param type The type of error that occurred
   * @param sessionId The session ID, or undefined for global errors
   * @private Internal method for error count tracking
   */
  private incrementErrorCount(type: CDPErrorType, sessionId?: string): void {
    const key = sessionId || 'global'
    if (!this.errorCounts.has(key)) {
      this.errorCounts.set(key, new Map())
    }
    const counts = this.errorCounts.get(key)!
    counts.set(type, (counts.get(type) || 0) + 1)
  }

  /**
   * Attempts to recover from a recoverable error
   * @param error The error to attempt recovery from
   * @param session Optional session context for the error
   * @private Internal method for error recovery logic
   */
  private attemptRecovery(error: CDPError, session?: Session): void {
    const sessionId = session?.id || 'global'
    const counts = this.errorCounts.get(sessionId)
    const errorCount = counts?.get(error.type) || 0

    // Only handle as unrecoverable if threshold is exceeded AND not recoverable
    if (
      errorCount > ErrorHandler.ERROR_THRESHOLDS[error.type] &&
      !error.recoverable
    ) {
      this.handleUnrecoverableError(
        {
          ...error,
          recoverable: false,
          message: `Error threshold exceeded for ${error.type}: ${error.message}`,
        },
        session,
      )
      return
    }

    // Log error and let the respective managers handle recovery
    console.warn(`[${error.type}] Attempting recovery for error:`, {
      message: error.message,
      sessionId: session?.id,
      code: error.code,
      details: error.details,
    })
  }

  /**
   * Handles unrecoverable errors by logging and terminating the process
   * @param error The unrecoverable error
   * @param session Optional session context for the error
   * @private Internal method for fatal error handling
   */
  private handleUnrecoverableError(error: CDPError, session?: Session): void {
    console.error(`Unrecoverable error: ${error.message}`, error)
    Deno.exit(1)
  }

  /**
   * Gets the count of errors of a specific type for a given session
   * @param type The type of error to count
   * @param sessionId The session ID to check errors for
   * @returns The number of errors of the specified type for the session
   * @testing This method is primarily used in tests to verify error handling behavior
   */
  getErrorCount(type: CDPErrorType, sessionId: string): number {
    const counts = this.errorCounts.get(sessionId)
    return counts?.get(type) ?? 0
  }

  /**
   * Clears all error counts for a specific session
   * @param sessionId The session ID to clear error counts for
   * @testing This method is used in tests to reset error state between test cases
   * and to verify error count management functionality
   */
  clearErrorCounts(sessionId: string): void {
    this.errorCounts.delete(sessionId)
  }
}
