import { bold } from 'https://deno.land/std@0.224.0/fmt/colors.ts'

/** Supported log level names */
export type LogLevelName =
  | 'silent'
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'log'
  | 'verbose'

/** Configuration options for logger instances */
interface LoggerConfig {
  level?: LogLevelName
  tags?: string[]
  style?: string
}

/** Metadata that can be attached to log entries */
interface LogData {
  sessionId?: string
  error?: Error
  [key: string]: unknown
}

/** Helper function to generate RGB ANSI codes */
const rgbAnsi = (r: number, g: number, b: number, isBg = false) =>
  `\x1b[${isBg ? '48' : '38'};2;${r};${g};${b}m`

/** Mapping of log levels to their numeric values */
const LOG_LEVELS: Record<LogLevelName, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  log: 5,
  verbose: 6,
}

// Default context style using RGB values
const DEFAULT_CONTEXT_STYLE = `${rgbAnsi(0, 51, 153)}${rgbAnsi(51, 102, 204, true)}${bold('')}`
const TAG_STYLE = rgbAnsi(102, 217, 239) // Cyan
const RESET_STYLE = '\x1b[0m'

/** Styling configuration for different log levels */
const LEVEL_STYLES = {
  error: { text: '  ERROR ', style: '\x1b[31m' }, // Red
  warn: { text: '  WARN  ', style: '\x1b[33m' }, // Yellow
  info: { text: '  INFO  ', style: '\x1b[32m' }, // Green
  debug: { text: '  DEBUG ', style: '\x1b[90m' }, // Gray
  log: { text: '  LOG   ', style: '\x1b[34m' }, // Blue
  verbose: { text: 'VERBOSE ', style: '\x1b[35m' }, // Magenta
} as const

/**
 * Unified logging interface for the CDP Proxy
 * Provides consistent formatting, filtering, and log level control
 *
 * @example
 * ```ts
 * const logger = Logger.get('CDP PROXY')
 * logger.info('Server started', { port: 8080 })
 *
 * // With tags
 * const wsLogger = logger.withTags(['websocket'])
 * wsLogger.debug('Connection established')
 *
 * // With error
 * logger.error('Failed to start', { error: new Error('Port in use') })
 *
 * // Direct error handling
 * doSomething().catch(logger.error)
 *
 * // Error as first argument
 * logger.error(new Error('Failed to connect'))
 * ```
 */
export class Logger {
  private static readonly instances = new Map<string, Logger>()
  private static readonly globalTags =
    Deno.env.get('PROXY_LOG_TAGS')?.split(',') || []

  /** Normalize a log level string to a valid LogLevelName */
  private static normalizeLogLevel = (level?: string | null): LogLevelName =>
    !level
      ? 'info'
      : Object.prototype.hasOwnProperty.call(LOG_LEVELS, level.toLowerCase())
        ? (level.toLowerCase() as LogLevelName)
        : 'info'

  private static globalLevel: LogLevelName = Logger.normalizeLogLevel(
    Deno.env.get('PROXY_LOG_LEVEL'),
  )

  /** Clear all logger instances and refresh global configuration */
  static clearInstances(): void {
    Logger.instances.clear()
    Logger.globalLevel = Logger.normalizeLogLevel(
      Deno.env.get('PROXY_LOG_LEVEL'),
    )
  }

  private constructor(
    private readonly context: string,
    private config: LoggerConfig = {},
  ) {
    this.config = {
      style: DEFAULT_CONTEXT_STYLE,
      tags: [],
      level: Logger.globalLevel,
      ...config,
    }
  }

  /**
   * Get or create a logger instance for a specific context
   */
  static get(context: string, config?: LoggerConfig): Logger {
    const key = `${context}-${JSON.stringify(config)}`
    if (!Logger.instances.has(key)) {
      Logger.instances.set(key, new Logger(context, config))
    }
    return Logger.instances.get(key) ?? new Logger(context, config)
  }

  /** Create a new logger instance with additional tags */
  withTags = (tags: string[]): Logger =>
    Logger.get(this.context, {
      ...this.config,
      tags: [...(this.config.tags ?? []), ...tags],
    })

  /** Create a new logger instance with custom style */
  withStyle = (style: string): Logger =>
    Logger.get(this.context, { ...this.config, style })

  /** Internal method to handle log message formatting and output */
  private internalPrint(
    level: Exclude<LogLevelName, 'silent'>,
    messageOrError: string | Error,
    data?: LogData,
  ): void {
    if (!this.shouldLog(level)) return

    const message =
      messageOrError instanceof Error ? messageOrError.message : messageOrError
    const errorToLog =
      messageOrError instanceof Error ? messageOrError : data?.error
    const { error: _, ...restData } = data ?? {}

    let logMessage = [
      new Date().toISOString(),
      this.formatLevel(level),
      this.formatContext(),
      this.formatTags(),
      message,
      RESET_STYLE,
    ].join(' ')

    if (Object.keys(restData).length) {
      logMessage += `\n${Deno.inspect(restData, {
        depth: 4,
        colors: true,
        compact: false,
        sorted: true,
      })}`
    }

    if (errorToLog?.stack) {
      logMessage += `\n${errorToLog.stack}`
    }

    level === 'error' ? console.error(logMessage) : console.log(logMessage)
  }

  /**
   * Check if a message should be logged based on level and tags
   */
  private shouldLog(level: LogLevelName): boolean {
    const configLevel = this.config.level ?? Logger.globalLevel
    const isDebug = Deno.env.get('PROXY_LOG_LEVEL') === 'debug'

    if (isDebug) {
      console.log(
        'Debug -',
        'shouldLog check:',
        `\n  Message level: ${level}`,
        `\n  Config level: ${configLevel}`,
      )
    }

    if (level === 'error' && configLevel !== 'silent') {
      isDebug &&
        console.log('Debug - Result: true (Error message and not silent)')
      return true
    }

    if (LOG_LEVELS[level] > LOG_LEVELS[configLevel]) {
      isDebug &&
        console.log(
          'Debug - Result: false (Message level higher than config level)',
        )
      return false
    }

    if (
      Logger.globalTags.length &&
      !this.config.tags?.some((tag) => Logger.globalTags.includes(tag))
    ) {
      isDebug && console.log('Debug - Result: false (No matching tags)')
      return false
    }

    isDebug && console.log('Debug - Result: true (Passed all checks)')
    return true
  }

  private formatContext = (): string =>
    `${this.config.style}[${this.context}]${RESET_STYLE}`

  private formatTags = (): string =>
    this.config.tags?.length
      ? ` ${this.config.tags.map((tag) => `${TAG_STYLE}#${tag}${RESET_STYLE}`).join(' ')}`
      : ''

  private formatLevel = (level: Exclude<LogLevelName, 'silent'>): string =>
    `${LEVEL_STYLES[level].style}${LEVEL_STYLES[level].text}${RESET_STYLE}`

  // Log level methods
  verbose = (messageOrError: string | Error, data?: LogData): LogChain =>
    new LogChain(this, messageOrError, 'verbose', data)
  log = (messageOrError: string | Error, data?: LogData): LogChain =>
    new LogChain(this, messageOrError, 'log', data)
  debug = (messageOrError: string | Error, data?: LogData): LogChain =>
    new LogChain(this, messageOrError, 'debug', data)
  info = (messageOrError: string | Error, data?: LogData): LogChain =>
    new LogChain(this, messageOrError, 'info', data)
  warn = (messageOrError: string | Error, data?: LogData): LogChain =>
    new LogChain(this, messageOrError, 'warn', data)
  error = (messageOrError: string | Error, data?: LogData): LogChain =>
    new LogChain(this, messageOrError, 'error', data)
}

/** Chain interface for fluent logging operations */
class LogChain {
  constructor(
    private logger: Logger,
    private message: string | Error,
    private level: Exclude<LogLevelName, 'silent'>,
    private data?: LogData,
  ) {
    this.log()
  }

  private log(): void {
    // Access internal print through a method that exists on the logger instance
    const loggerAny = this.logger as any
    loggerAny.internalPrint(this.level, this.message, this.data)
  }

  tags(tags: string | string[]): LogChain {
    this.logger = this.logger.withTags(Array.isArray(tags) ? tags : [tags])
    this.log()
    return this
  }
}
