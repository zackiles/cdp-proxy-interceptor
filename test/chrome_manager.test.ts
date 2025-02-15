import './test_setup.ts'
import { assertExists, assertEquals, assertNotEquals, assertRejects } from 'jsr:@std/assert'
import { ChromeManager } from '../src/chrome_manager.ts'
import { delay } from 'jsr:@std/async'
import { ErrorHandler } from '../src/error_handler.ts'
import { getChromiumPaths } from '../src/utils.ts'
import { MockWebSocket } from './mock_websocket.ts'

const TEST_TIMEOUT = 5000
const WEBSOCKET_CLOSE_TIMEOUT = 1000

const mockErrorHandler = new ErrorHandler()

/**
 * Verifies that a CDP endpoint is responding correctly with all required fields
 * @param port The port number to check
 * @returns True if the endpoint is valid and responding correctly
 */
const verifyCDPEndpoint = async (port: number): Promise<boolean> => {
  try {
    const response = await fetch(`http://localhost:${port}/json/version`)
    if (!response.ok) return false
    
    const data = await response.json()
    return (
      typeof data === 'object' &&
      data !== null &&
      ['Browser', 'Protocol-Version', 'User-Agent', 'V8-Version', 'WebKit-Version']
        .every(field => typeof data[field] === 'string') &&
      typeof data.webSocketDebuggerUrl === 'string' &&
      data.webSocketDebuggerUrl.startsWith('ws://localhost:')
    )
  } catch {
    return false
  }
}

/**
 * Safely closes a WebSocket connection with timeout
 * @param ws The WebSocket to close
 */
const safeCloseWebSocket = async (ws: WebSocket | undefined): Promise<void> => {
  if (!ws?.readyState || ws.readyState === MockWebSocket.CLOSED) return

  try {
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        ws.removeEventListener('close', closeHandler)
        clearTimeout(timeoutId)
        resolve()
      }
      
      const closeHandler = () => cleanup()
      const timeoutId = setTimeout(() => {
        console.warn('WebSocket close timed out')
        cleanup()
      }, WEBSOCKET_CLOSE_TIMEOUT)
      
      ws.addEventListener('close', closeHandler)
      ws.close()
    })
  } catch (error) {
    console.warn('Error closing WebSocket:', error)
  }
}

async function waitForWebSocketState(
  ws: WebSocket,
  predicate: () => boolean,
  timeout: number,
): Promise<void> {
  let intervalId: number | undefined
  let timeoutId: number | undefined
  const controller = new AbortController()

  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        if (intervalId !== undefined) clearInterval(intervalId)
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        controller.abort()
        ws.removeEventListener('open', checkState)
        ws.removeEventListener('error', handleError)
      }

      const checkState = () => {
        if (predicate()) {
          cleanup()
          resolve()
        }
      }

      const handleError = (event: Event) => {
        cleanup()
        const errorMessage =
          event instanceof ErrorEvent ? event.message : String(event)
        reject(new Error(`WebSocket error: ${errorMessage}`))
      }

      ws.addEventListener('open', checkState, { signal: controller.signal })
      ws.addEventListener('error', handleError, { signal: controller.signal })
      intervalId = setInterval(checkState, 100)
      timeoutId = setTimeout(() => {
        cleanup()
        reject(new Error(`WebSocket state change timeout after ${timeout}ms`))
      }, timeout)

      // Initial check
      checkState()
    })
  } catch (error) {
    if (intervalId !== undefined) clearInterval(intervalId)
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    controller.abort()
    throw error
  }
}

/**
 * Tests for the ChromeManager class
 */
Deno.test('ChromeManager', async (t) => {
  await t.step('should start Chrome and get WebSocket URL', async () => {
    const chromeManager = new ChromeManager(mockErrorHandler)
    try {
      console.log('Starting Chrome...')
      const wsUrl = await chromeManager.start()
      console.log('Chrome started with WebSocket URL:', wsUrl)

      const port = chromeManager.port
      if (port === undefined) {
        throw new Error('Chrome port is not defined')
      }
      const isEndpointValid = await verifyCDPEndpoint(port)
      assertEquals(
        isEndpointValid,
        true,
        'CDP endpoint should return valid version info',
      )

      assertExists(wsUrl)
      assertEquals(typeof wsUrl, 'string')
      assertEquals(wsUrl.startsWith('ws://'), true)
    } finally {
      console.log('Stopping Chrome...')
      await chromeManager.stop()
      console.log('Chrome stopped')
    }
  })

  await t.step('should verify CDP endpoint response format', async () => {
    const chromeManager = new ChromeManager(mockErrorHandler)
    try {
      await chromeManager.start()
      const port = chromeManager.port
      if (port === undefined) {
        throw new Error('Chrome port is not defined')
      }

      const response = await fetch(`http://localhost:${port}/json/version`)
      assertEquals(response.ok, true, 'CDP endpoint should return 200 OK')

      const data = await response.json()
      assertExists(data.Browser, 'Response should include Browser info')
      assertExists(data['Protocol-Version'], 'Response should include Protocol-Version')
      assertExists(data['User-Agent'], 'Response should include User-Agent')
      assertExists(data['V8-Version'], 'Response should include V8-Version')
      assertExists(data['WebKit-Version'], 'Response should include WebKit-Version')
      assertExists(data.webSocketDebuggerUrl, 'Response should include webSocketDebuggerUrl')

      assertEquals(
        data.webSocketDebuggerUrl.startsWith(`ws://localhost:${port}/devtools/browser/`),
        true,
        'webSocketDebuggerUrl should have correct format'
      )
    } finally {
      await chromeManager.stop()
    }
  })

  await t.step('should transparently proxy requests to Chrome', async () => {
    const chromeManager = new ChromeManager(mockErrorHandler)
    try {
      await chromeManager.start()
      const port = chromeManager.port
      if (!port) throw new Error('Chrome port is not defined')

      // Test various CDP endpoints
      const endpoints = ['/json', '/json/list', '/json/version']
      for (const endpoint of endpoints) {
        const response: Response = await fetch(`http://localhost:${port}${endpoint}`)
        assertEquals(response.ok, true, `${endpoint} should return 200 OK`)
        
        const contentType = response.headers.get('content-type')
        assertEquals(
          contentType?.includes('application/json'),
          true,
          `${endpoint} should return JSON content`
        )

        const data: unknown = await response.json()
        assertExists(data, `${endpoint} should return valid JSON`)
      }

      // Test creating new target
      const newTargetResponse = await fetch(`http://localhost:${port}/json/new`, {
        method: 'PUT'
      })
      assertEquals(newTargetResponse.ok, true, '/json/new should return 200 OK')
      
      const targetData = await newTargetResponse.json()
      assertExists(targetData.webSocketDebuggerUrl, 'New target should have WebSocket URL')
      assertEquals(
        targetData.webSocketDebuggerUrl.startsWith('ws://'),
        true,
        'WebSocket URL should have correct format'
      )
    } finally {
      await chromeManager.stop()
    }
  })

  await t.step('should track WebSocket connections', async () => {
    const chromeManager = new ChromeManager(mockErrorHandler)
    let mockWs: MockWebSocket | undefined
    try {
      await chromeManager.start()
      mockWs = new MockWebSocket('ws://localhost:1234')

      // WebSocket starts in CONNECTING state by default
      assertEquals(mockWs.readyState, MockWebSocket.CONNECTING)
      chromeManager.registerConnection(mockWs)
      assertEquals(chromeManager.getConnectionCount(), 1)

      // Simulate successful connection
      mockWs.simulateOpen()
      assertEquals(mockWs.readyState, MockWebSocket.OPEN)

      // Test unregistering
      chromeManager.unregisterConnection(mockWs)
      assertEquals(chromeManager.getConnectionCount(), 0)
    } finally {
      await safeCloseWebSocket(mockWs)
      await chromeManager.stop()
    }
  })

  await t.step('should rewrite all WebSocket URLs in responses', async () => {
    const chromeManager = new ChromeManager(mockErrorHandler)
    try {
      await chromeManager.start()
      const port = chromeManager.port
      if (!port) throw new Error('Chrome port is not defined')

      const verifyWebSocketHostname = (value: string) => {
        if (value.startsWith('ws://')) {
          assertEquals(
            value.includes('localhost:'),
            true,
            'WebSocket URL should use localhost'
          )
        }
      }

      const verifyWebSocketUrls = (obj: unknown) => {
        Object.entries(obj as Record<string, unknown>).forEach(([key, value]) => {
          if (typeof value === 'string') {
            if (value.startsWith('ws://')) {
              verifyWebSocketHostname(value)
              assertEquals(
                value.includes(`:${port}`),
                true,
                `WebSocket URL in ${key} should use Chrome port`
              )
            } else if (value.includes('ws=')) {
              const wsParam = decodeURIComponent(value.split('ws=')[1].split('&')[0])
              verifyWebSocketHostname(wsParam.startsWith('ws://') ? wsParam : `ws://${wsParam}`)
              assertEquals(
                value.includes(`:${port}`),
                true,
                `WebSocket parameter in ${key} should use Chrome port`
              )
            }
          }
        })
      }

      const endpoints = ['/json/version', '/json/list', '/json/new']
      for (const endpoint of endpoints) {
        const response = await fetch(
          `http://localhost:${port}${endpoint}`,
          endpoint === '/json/new' ? { method: 'PUT' } : undefined
        )
        assertEquals(response.ok, true, `${endpoint} should succeed`)
        
        const data = await response.json()
        if (Array.isArray(data)) {
          data.forEach(item => verifyWebSocketUrls(item))
        } else {
          verifyWebSocketUrls(data)
        }
      }
    } finally {
      await chromeManager.stop()
    }
  })

  await t.step('should validate Chrome configuration', async () => {
    const originalExecPath = Deno.env.get('CHROMIUM_EXECUTABLE_PATH')
    const originalDir = Deno.env.get('CHROMIUM_DIRECTORY')
    const originalVersion = Deno.env.get('CHROMIUM_STATIC_VERSION')

    try {
      Deno.env.delete('CHROMIUM_EXECUTABLE_PATH')
      Deno.env.delete('CHROMIUM_DIRECTORY')
      Deno.env.delete('CHROMIUM_STATIC_VERSION')
      try {
        getChromiumPaths()
        throw new Error('Should have thrown')
      } catch (error: unknown) {
        assertEquals(error instanceof Error, true)
        if (error instanceof Error) {
          assertEquals(
            error.message.includes('Either CHROMIUM_EXECUTABLE_PATH must be set'),
            true
          )
        }
      }

      Deno.env.set('CHROMIUM_EXECUTABLE_PATH', '/path/to/chrome')
      Deno.env.set('CHROMIUM_DIRECTORY', '/path/to/dir')
      try {
        getChromiumPaths()
        throw new Error('Should have thrown')
      } catch (error: unknown) {
        assertEquals(error instanceof Error, true)
        if (error instanceof Error) {
          assertEquals(
            error.message.includes('When CHROMIUM_EXECUTABLE_PATH is set'),
            true
          )
        }
      }

      Deno.env.delete('CHROMIUM_DIRECTORY')
      Deno.env.delete('CHROMIUM_STATIC_VERSION')
      const execPathConfig = getChromiumPaths()
      assertEquals(execPathConfig.executablePath, '/path/to/chrome')

      Deno.env.delete('CHROMIUM_EXECUTABLE_PATH')
      Deno.env.set('CHROMIUM_DIRECTORY', '/path/to/dir')
      Deno.env.set('CHROMIUM_STATIC_VERSION', '123456')
      const managedConfig = getChromiumPaths()
      assertEquals(managedConfig.directory, '/path/to/dir')
    } finally {
      originalExecPath 
        ? Deno.env.set('CHROMIUM_EXECUTABLE_PATH', originalExecPath)
        : Deno.env.delete('CHROMIUM_EXECUTABLE_PATH')
      originalDir
        ? Deno.env.set('CHROMIUM_DIRECTORY', originalDir)
        : Deno.env.delete('CHROMIUM_DIRECTORY')
      originalVersion
        ? Deno.env.set('CHROMIUM_STATIC_VERSION', originalVersion)
        : Deno.env.delete('CHROMIUM_STATIC_VERSION')
    }
  })
})
