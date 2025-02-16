import './test_setup.ts'
import { assertEquals, assertExists } from 'jsr:@std/assert'
import { Logger } from '../src/logger.ts'
import type { LogLevelName } from '../src/logger.ts'

Deno.test('Logger', async (t) => {
  // Store original env value and console methods
  const originalLogLevel = Deno.env.get('PROXY_LOG_LEVEL')
  const originalConsole = { ...console }

  // Setup log capture
  let logs: string[] = []
  let errors: string[] = []

  // Reset logs before each test
  function resetLogs() {
    logs = []
    errors = []
    console.log = (...args: unknown[]) => {
      const message = args.join(' ')
      // Only capture non-debug messages
      if (!message.startsWith('Debug -')) {
        logs.push(message)
      }
    }
    console.error = (...args: unknown[]) => {
      const message = args.join(' ')
      // Only capture non-debug messages
      if (!message.startsWith('Debug -')) {
        errors.push(message)
      }
    }
  }

  // Reset environment and logs
  function resetEnvironment(level: LogLevelName) {
    // Reset environment first
    Deno.env.set('PROXY_LOG_LEVEL', level)
    Logger.clearInstances()

    // Then reset logs
    resetLogs()
  }

  // Reset logs initially
  resetLogs()

  await t.step('should create logger instance', () => {
    const logger = Logger.get('TEST')
    assertExists(logger)
    assertEquals(logger instanceof Logger, true)
  })

  await t.step('should log messages at different levels', () => {
    // Reset environment to verbose to test all levels
    resetEnvironment('verbose')

    const logger = Logger.get('TEST')

    // Test each log level with unique messages
    logger.error('Error test message')
    logger.warn('Warning test message')
    logger.info('Info test message')
    logger.debug('Debug test message')
    logger.log('Log test message')
    logger.verbose('Verbose test message')

    // Verify logs were captured
    const allLogs = [...logs, ...errors]
    assertEquals(allLogs.length, 6, 'Should have captured all 6 log messages')

    // Verify each message type was logged
    assertEquals(
      allLogs.some((log) => log.includes('Error test message')),
      true,
      'Error message not found',
    )
    assertEquals(
      allLogs.some((log) => log.includes('Warning test message')),
      true,
      'Warning message not found',
    )
    assertEquals(
      allLogs.some((log) => log.includes('Info test message')),
      true,
      'Info message not found',
    )
    assertEquals(
      allLogs.some((log) => log.includes('Debug test message')),
      true,
      'Debug message not found',
    )
    assertEquals(
      allLogs.some((log) => log.includes('Log test message')),
      true,
      'Log message not found',
    )
    assertEquals(
      allLogs.some((log) => log.includes('Verbose test message')),
      true,
      'Verbose message not found',
    )
  })

  await t.step('should handle errors correctly', () => {
    // Reset environment to error level
    resetEnvironment('error')

    const logger = Logger.get('TEST')
    const testError = new Error('Test error')

    logger.error(testError)
    assertEquals(errors.length, 1, 'Should have 1 error log')
    assertEquals(errors[0].includes('Test error'), true)
    const errorStack = testError.stack
    if (errorStack) {
      assertEquals(errors[0].includes(errorStack), true)
    }

    // Test error in data
    errors.length = 0
    logger.error('Message with error', { error: testError })
    assertEquals(errors.length, 1, 'Should have 1 error log')
    assertEquals(errors[0].includes('Message with error'), true)
    if (errorStack) {
      assertEquals(errors[0].includes(errorStack), true)
    }
  })

  await t.step('should always log errors unless silent', () => {
    // Test error logging at each log level
    const levels: LogLevelName[] = [
      'verbose',
      'log',
      'debug',
      'info',
      'warn',
      'error',
    ]

    for (const level of levels) {
      resetEnvironment(level)
      const logger = Logger.get('TEST')

      // Try to log an error
      logger.error('This error should be logged')

      // Verify error was logged
      assertEquals(
        errors.length,
        1,
        `Error should be logged when level is '${level}'`,
      )
      assertEquals(
        errors[0].includes('This error should be logged'),
        true,
        `Error message should be in logs when level is '${level}'`,
      )

      // Clear errors for next test
      errors = []
    }

    // Special case: silent level should suppress even errors
    resetEnvironment('silent')
    const logger = Logger.get('TEST')

    // Try to log an error in silent mode
    logger.error('This error should NOT be logged')

    // Verify nothing was logged
    assertEquals(
      errors.length,
      0,
      'No errors should be logged when level is silent',
    )
  })

  await t.step('should handle tags', () => {
    // Reset environment to info level
    resetEnvironment('info')

    const logger = Logger.get('TEST').withTags(['tag1', 'tag2'])

    logger.info('Tagged message')
    assertEquals(logs.length, 1, 'Should have 1 log')
    assertEquals(logs[0].includes('#tag1'), true)
    assertEquals(logs[0].includes('#tag2'), true)
  })

  await t.step('should handle inline tags with method chaining', () => {
    resetEnvironment('info')
    const logger = Logger.get('TEST')

    // Test array of tags - only check message content, not log count
    logger.info('Message with array tags').tags(['tag1', 'tag2'])
    const taggedLog = logs.find(
      (log) =>
        log.includes('Message with array tags') &&
        log.includes('#tag1') &&
        log.includes('#tag2'),
    )
    assertEquals(!!taggedLog, true, 'Should find log with correct tags')

    // Reset logs
    logs = []

    // Test single tag string - only check message content, not log count
    logger.info('Message with single tag').tags('tag3')
    const singleTagLog = logs.find(
      (log) => log.includes('Message with single tag') && log.includes('#tag3'),
    )
    assertEquals(!!singleTagLog, true, 'Should find log with single tag')
  })

  // Final cleanup step
  await t.step('cleanup', () => {
    // Restore original console methods
    console.log = originalConsole.log
    console.error = originalConsole.error

    // Restore original log level if it existed, otherwise delete it
    if (originalLogLevel !== undefined) {
      Deno.env.set('PROXY_LOG_LEVEL', originalLogLevel)
    } else {
      Deno.env.delete('PROXY_LOG_LEVEL')
    }

    // Clear logger instances
    Logger.clearInstances()
  })
})
