import './test_setup.ts'
import { assertEquals } from 'jsr:@std/assert'
import { ErrorHandler } from '../src/error_handler.ts'
import { CDPErrorType } from '../src/types.ts'

Deno.test('ErrorHandler', async (t) => {
  const errorHandler = new ErrorHandler()

  await t.step('should track error counts', () => {
    const sessionId = 'test-session'
    const error = {
      type: CDPErrorType.PROTOCOL,
      code: 1000,
      message: 'Test error',
      recoverable: true,
    }

    // Handle error and check count
    errorHandler.handleError(error, { id: sessionId } as any)
    assertEquals(
      errorHandler.getErrorCount(CDPErrorType.PROTOCOL, sessionId),
      1,
    )

    // Handle another error and check count
    errorHandler.handleError(error, { id: sessionId } as any)
    assertEquals(
      errorHandler.getErrorCount(CDPErrorType.PROTOCOL, sessionId),
      2,
    )

    // Clear error counts
    errorHandler.clearErrorCounts(sessionId)
    assertEquals(
      errorHandler.getErrorCount(CDPErrorType.PROTOCOL, sessionId),
      0,
    )
  })

  await t.step('should handle different error types', () => {
    const sessionId = 'test-session'
    const errors = [
      {
        type: CDPErrorType.CONNECTION,
        code: 1001,
        message: 'Connection error',
        recoverable: true,
      },
      {
        type: CDPErrorType.PROTOCOL,
        code: 1002,
        message: 'Protocol error',
        recoverable: true,
      },
      {
        type: CDPErrorType.VALIDATION,
        code: 1003,
        message: 'Validation error',
        recoverable: true,
      },
      {
        type: CDPErrorType.RESOURCE,
        code: 1004,
        message: 'Resource error',
        recoverable: true,
      },
      {
        type: CDPErrorType.PLUGIN,
        code: 1005,
        message: 'Plugin error',
        recoverable: true,
      },
    ]

    // Handle each error type
    for (const error of errors) {
      errorHandler.handleError(error, { id: sessionId } as any)
      assertEquals(errorHandler.getErrorCount(error.type, sessionId), 1)
    }

    // Clear all error counts
    errorHandler.clearErrorCounts(sessionId)
    for (const error of errors) {
      assertEquals(errorHandler.getErrorCount(error.type, sessionId), 0)
    }
  })

  await t.step('should handle global errors', () => {
    const error = {
      type: CDPErrorType.PROTOCOL,
      code: 1000,
      message: 'Global error',
      recoverable: true,
    }

    // Handle error without session
    errorHandler.handleError(error)
    assertEquals(errorHandler.getErrorCount(CDPErrorType.PROTOCOL, 'global'), 1)

    // Clear global error counts
    errorHandler.clearErrorCounts('global')
    assertEquals(errorHandler.getErrorCount(CDPErrorType.PROTOCOL, 'global'), 0)
  })

  await t.step('should handle unrecoverable errors', () => {
    const error = {
      type: CDPErrorType.CONNECTION,
      code: 1000,
      message: 'Unrecoverable error',
      recoverable: false,
    }

    // Mock Deno.exit to prevent test from actually exiting
    const originalExit = Deno.exit
    let exitCalled = false
    let exitCode: number | undefined
    Deno.exit = ((code?: number) => {
      exitCalled = true
      exitCode = code
      return undefined as never
    }) as typeof Deno.exit

    // Handle unrecoverable error
    errorHandler.handleError(error)
    assertEquals(exitCalled, true)
    assertEquals(exitCode, 1)

    // Restore original Deno.exit
    Deno.exit = originalExit
  })
})
