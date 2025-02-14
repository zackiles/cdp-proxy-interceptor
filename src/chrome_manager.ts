import { launch, type LaunchedChrome } from 'npm:chrome-launcher'
import { getAvailablePort} from 'jsr:@std/net'
import { doesProcessWithPortExist } from './utils.ts'
import { CDPErrorType } from './types.ts'
import { ErrorHandler } from './error_handler.ts'

const BROWSER_NAME = 'Chromium'
const DEFAULT_RETRY_CONFIG = { retries: 3, baseDelay: 100 }
const CHROME_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--disable-accelerated-video-decode',
  '--no-sandbox',
  '--enable-logging',
  '--v=1',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--allow-pre-commit-input',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--enable-automation',
  '--password-store=basic'
]

interface ExtendedChrome extends LaunchedChrome {
  destroyTmp?: () => Promise<void>
}

interface BusyError extends Error {
  code?: string
}

/**
 * Manages Chrome browser instance lifecycle and WebSocket connections
 * Handles browser startup, shutdown, and connection management
 */
export class ChromeManager {
  private chrome: LaunchedChrome | null = null
  private wsUrl = ''
  port?: number
  private connections = new Set<WebSocket>()
  private isStarting = false
  isKilling = false
  private readonly errorHandler: ErrorHandler

  constructor(errorHandler: ErrorHandler) {
    this.errorHandler = errorHandler
  }
  
  /**
   * Starts a Chrome instance with retry logic
   * @param retries Number of retry attempts
   * @param baseDelay Base delay between retries in ms
   * @returns WebSocket URL for Chrome DevTools Protocol
   */
  async start(retries = DEFAULT_RETRY_CONFIG.retries, baseDelay = DEFAULT_RETRY_CONFIG.baseDelay): Promise<string> {
    if (this.isStarting) throw new Error(`${BROWSER_NAME} is already starting`)
    this.isStarting = true

    try {
      for (let i = 0; i < retries; i++) {
        try {
          this.port = await getAvailablePort()
          await this.killExistingChromeOnPort()
          
          this.chrome = await launch({
            chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            port: this.port,
            chromeFlags: [...CHROME_FLAGS, `--remote-debugging-port=${this.port}`],
            handleSIGINT: true
          })

          if (!this.chrome?.pid) {
            await this.forceCleanup()
            throw new Error(`Failed to start ${BROWSER_NAME}!`) 
          }

          if (!await doesProcessWithPortExist(this.port)) {
            await this.forceCleanup()
            throw new Error(`Failed to find a process for ${BROWSER_NAME} with an open port of ${this.port}!`)
          }

          await this.waitForDebuggerEndpoint(this.port, baseDelay * 2 ** i)
          this.wsUrl = await this.getWebSocketUrl()
          console.log(`${BROWSER_NAME} started with PID: ${this.chrome.pid} on port ${this.port}`)
          return this.wsUrl
        } catch (e) {
          await this.forceCleanup()
          if (i === retries - 1) throw e
          await new Promise(r => setTimeout(r, baseDelay * 2 ** i))
        }
      }
      throw new Error(`Failed to start ${BROWSER_NAME} after ${retries} retries`)
    } finally {
      this.isStarting = false
    }
  }

  /**
   * Checks if a Chrome debugger response is valid
   * @param data Response data to validate
   * @param port Port number to validate against
   * @returns True if response is valid
   */
  private isValidDebuggerResponse(data: unknown, port: number): boolean {
    const requiredFields = [
      'Browser', 'Protocol-Version', 'User-Agent', 
      'V8-Version', 'WebKit-Version'
    ]
    
    return typeof data === 'object' && 
      data !== null &&
      requiredFields.every(field => 
        typeof (data as Record<string, unknown>)[field] === 'string'
      ) &&
      typeof (data as Record<string, unknown>).webSocketDebuggerUrl === 'string' &&
      (data as Record<string, string>).webSocketDebuggerUrl
        .startsWith(`ws://localhost:${port}/devtools/browser/`)
  }

  /**
   * Checks if Chrome is running on the current port
   * @returns True if Chrome is running and responding
   */
  private async checkExistingChrome(): Promise<boolean> {
    if (!this.port) return false
    try {
      const response = await fetch(`http://localhost:${this.port}/json/version`)
      return response.ok
    } catch {
      return false
    }
  }

  /**
   * Closes a WebSocket connection with timeout
   * @param connection WebSocket to close
   * @returns Promise that resolves when connection is closed
   */
  private async closeConnectionWithTimeout(connection: WebSocket): Promise<void> {
    return new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        console.warn('Connection close timed out')
        resolve()
      }, 2000)

      connection.addEventListener('close', () => {
        clearTimeout(timeout)
        resolve()
      })

      try {
        connection.close(1000, `${BROWSER_NAME} stopping`)
      } catch (error) {
        console.warn('Error closing connection:', error)
        clearTimeout(timeout)
        resolve()
      }
    })
  }

  private async killExistingChromeOnPort(): Promise<void> {
    if (!this.port) return
    
    const exists = await this.checkExistingChrome()
    if (!exists) return
    
    console.log(`Found existing ${BROWSER_NAME} instance, killing it...`)
    await this.killProcessByPort()
    await new Promise(r => setTimeout(r, 1000))
  }

  private async killProcessByPort(): Promise<void> {
    if (!this.port) return

    const cmdConfig = Deno.build.os === 'windows' 
      ? { cmd: 'taskkill', args: ['//F', '//IM', 'chrome.exe'] }
      : { cmd: 'pkill', args: ['-f', `(chrome|chromium).*--remote-debugging-port=${this.port}`] }
    
    try {
      await new Deno.Command(cmdConfig.cmd, { args: cmdConfig.args }).output()
    } catch (error) {
      !(error instanceof Deno.errors.NotFound) && 
        console.warn('Error killing browser process:', error)
    }
  }

  private async forceCleanup(): Promise<void> {
    try {
      await this.killChromeProcess()
      await this.killProcessByPort()
      await this.closeAllConnections()
      await this.cleanupTempFiles()
      
      this.resetState()
    } catch (error) {
      console.error('Error during force cleanup:', error)
    }
  }

  private async killChromeProcess(): Promise<void> {
    if (!this.chrome?.pid) return
    
    try {
      Deno.kill(this.chrome.pid, 'SIGKILL')
      await new Promise(r => setTimeout(r, 1000))
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn('Error force killing browser process:', error)
      }
    }
  }

  private async closeAllConnections(): Promise<void> {
    for (const connection of this.connections) {
      try {
        connection.close(1000, `${BROWSER_NAME} stopping`)
      } catch (error) {
        console.warn('Error closing connection:', error)
      }
    }
    this.connections.clear()
  }

  private async cleanupTempFiles(): Promise<void> {
    const extendedChrome = this.chrome as ExtendedChrome
    if (extendedChrome?.destroyTmp) {
      await this.retryOperation(
        () => extendedChrome.destroyTmp!(),
        3,
        (error) => (error as BusyError)?.code === 'EBUSY'
      )
    }
  }

  private resetState(): void {
    this.chrome = null
    this.wsUrl = ''
    this.port = undefined
  }

  private async retryOperation(
    operation: () => Promise<void>,
    maxRetries: number,
    shouldRetry: (error: unknown) => boolean
  ): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await operation()
        return
      } catch (error) {
        if (i === maxRetries - 1 || !shouldRetry(error)) throw error
        await new Promise(r => setTimeout(r, 1000 * (i + 1)))
      }
    }
  }

  private async waitForDebuggerEndpoint(port: number, timeout: number): Promise<void> {
    const start = Date.now()
    const minTimeout = 1000
    const actualTimeout = Math.max(timeout, minTimeout)

    while (Date.now() - start < actualTimeout) {
      try {
        const response = await fetch(`http://localhost:${port}/json/version`)
        if (!response.ok) {
          await new Promise(r => setTimeout(r, 100))
          continue
        }

        const data = await response.json()
        if (this.isValidDebuggerResponse(data, port)) return
        
        console.warn('CDP endpoint response missing required fields:', data)
      } catch (error) {
        console.debug('Waiting for CDP endpoint...', error)
        await new Promise(r => setTimeout(r, 100))
      }
    }
    throw new Error(`Debugger endpoint not ready after ${actualTimeout}ms`)
  }

  /**
   * Gets the WebSocket URL for the Chrome DevTools Protocol
   * @throws Error if Chrome is not started
   * @returns Promise resolving to the WebSocket URL
   */
  async getWebSocketUrl(): Promise<string> {
    if (!this.port) throw new Error(`${BROWSER_NAME} not started`)
    const response = await fetch(`http://localhost:${this.port}/json/version`)
    const { webSocketDebuggerUrl } = await response.json()
    return webSocketDebuggerUrl
  }

  /**
   * Stops the Chrome instance and cleans up all resources
   * Closes all WebSocket connections and kills the browser process
   */
  async stop(): Promise<void> {
    if (this.isKilling) return
    this.isKilling = true

    try {
      if (this.chrome) {
        await Promise.all(
          Array.from(this.connections).map(connection => 
            this.closeConnectionWithTimeout(connection)
          )
        )
        
        this.connections.clear()
        await this.killWithRetries()
      }
    } finally {
      this.isKilling = false
      this.port = undefined
    }
  }

  private async killWithRetries(
    retries = DEFAULT_RETRY_CONFIG.retries,
    baseDelay = DEFAULT_RETRY_CONFIG.baseDelay
  ): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        if (!this.chrome) return
        await this.chrome.kill()
        await new Promise(r => setTimeout(r, baseDelay * 2 ** i))
        
        const extendedChrome = this.chrome as ExtendedChrome
        if (extendedChrome.destroyTmp) {
          try {
            await extendedChrome.destroyTmp()
          } catch (error) {
            if ((error as BusyError)?.code === 'EBUSY') {
              await new Promise(r => setTimeout(r, 1000))
              await this.forceCleanup()
            } else {
              throw error
            }
          }
        }

        this.chrome = null
        this.wsUrl = ''
        return
      } catch (error) {
        if (i === retries - 1) {
          await this.forceCleanup()
          this.errorHandler.handleError({
            type: CDPErrorType.RESOURCE,
            code: 5001,
            message: `Failed to kill ${BROWSER_NAME} after ${retries} attempts`,
            recoverable: false,
            details: { error, attempts: retries }
          })
          return
        }
        await new Promise(r => setTimeout(r, baseDelay * 2 ** i))
      }
    }
  }

  /**
   * Registers a new WebSocket connection for tracking
   * @param ws WebSocket connection to register
   */
  registerConnection(ws: WebSocket): void {
    this.connections.add(ws)
  }

  /**
   * Unregisters a WebSocket connection from tracking
   * @param ws WebSocket connection to unregister
   */
  unregisterConnection(ws: WebSocket): void {
    this.connections.delete(ws)
  }

  /**
   * Gets the current number of active WebSocket connections
   * @returns Number of active connections
   */
  getConnectionCount(): number {
    return this.connections.size
  }

  /**
   * Checks if error handling should be suppressed during cleanup
   * @returns True if errors should be suppressed
   */
  shouldSuppressError(): boolean {
    return this.isKilling || !this.chrome
  }
}
