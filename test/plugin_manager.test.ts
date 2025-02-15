import './test_setup.ts'
import { assertExists, assertEquals, assertRejects } from 'jsr:@std/assert'
import { PluginManager } from '../src/plugin_manager.ts'
import { ErrorHandler } from '../src/error_handler.ts'
import { SessionManager } from '../src/session_manager.ts'
import { WebSocketManager } from '../src/websocket_manager.ts'
import { SchemaValidator } from '../src/schema_validator.ts'
import { CDPErrorType } from '../src/types.ts'
import type {
  CDPPlugin,
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
} from '../src/types.ts'
import { MockWebSocket } from './mock_websocket.ts'

Deno.test({
  name: 'PluginManager',
  async fn(t) {
    const mockErrorHandler = new ErrorHandler()
    const mockSessionManager = new SessionManager(mockErrorHandler)
    const mockSchemaValidator = new SchemaValidator()
    const mockWsManager = new WebSocketManager(mockErrorHandler, mockSchemaValidator, null)
    const pluginManager = new PluginManager(mockErrorHandler, mockSessionManager, mockWsManager)

    await t.step('should register and unregister plugins', () => {
      const plugin: CDPPlugin = {
        name: 'test-plugin',
        onRequest: async (req) => req,
      }

      pluginManager.registerPlugin(plugin)
      assertEquals(pluginManager.hasPlugins(), true)
      assertEquals(pluginManager.getPlugins().length, 1)

      pluginManager.unregisterPlugin(plugin)
      assertEquals(pluginManager.hasPlugins(), false)
      assertEquals(pluginManager.getPlugins().length, 0)
    })

    await t.step('should process requests through plugins', async () => {
      const plugin: CDPPlugin = {
        name: 'request-plugin',
        onRequest: async (req) => ({
          ...req,
          params: { ...req.params, modified: true },
        }),
      }

      pluginManager.registerPlugin(plugin)

      const request: CDPCommandRequest = {
        id: 1,
        method: 'test',
        params: { original: true },
      }

      const result = await pluginManager.processRequest(request)
      assertExists(result)
      assertEquals(result.params?.modified, true)
      assertEquals(result.params?.original, true)

      pluginManager.unregisterPlugin(plugin)
    })

    await t.step('should process responses through plugins', async () => {
      const plugin: CDPPlugin = {
        name: 'response-plugin',
        onResponse: async (res) => ({
          ...res,
          result: { ...res.result, modified: true },
        }),
      }

      pluginManager.registerPlugin(plugin)

      const response: CDPCommandResponse = {
        id: 1,
        result: { original: true },
      }

      const result = await pluginManager.processResponse(response)
      assertExists(result)
      assertEquals(result.result?.modified, true)
      assertEquals(result.result?.original, true)

      pluginManager.unregisterPlugin(plugin)
    })

    await t.step('should process events through plugins', async () => {
      const plugin: CDPPlugin = {
        name: 'event-plugin',
        onEvent: async (event) => ({
          ...event,
          params: { ...event.params, modified: true },
        }),
      }

      pluginManager.registerPlugin(plugin)

      const event: CDPEvent = {
        method: 'test.event',
        params: { original: true },
      }

      const result = await pluginManager.processEvent(event)
      assertExists(result)
      assertEquals(result.params?.modified, true)
      assertEquals(result.params?.original, true)

      pluginManager.unregisterPlugin(plugin)
    })

    await t.step('should handle plugin errors gracefully', async () => {
      const plugin: CDPPlugin = {
        name: 'error-plugin',
        onRequest: async () => {
          throw new Error('Plugin error')
        },
      }

      pluginManager.registerPlugin(plugin)

      const request: CDPCommandRequest = {
        id: 1,
        method: 'test',
      }

      // Should not throw and return the original request
      const result = await pluginManager.processRequest(request)
      assertExists(result)
      assertEquals(result, request)

      pluginManager.unregisterPlugin(plugin)
    })

    await t.step('should handle plugin message blocking', async () => {
      const plugin: CDPPlugin = {
        name: 'blocking-plugin',
        onRequest: async () => null, // Block all requests
        onResponse: async () => null, // Block all responses
        onEvent: async () => null, // Block all events
      }

      pluginManager.registerPlugin(plugin)

      const request: CDPCommandRequest = {
        id: 1,
        method: 'test',
      }

      const response: CDPCommandResponse = {
        id: 1,
        result: {},
      }

      const event: CDPEvent = {
        method: 'test.event',
      }

      // All messages should be blocked (return null)
      assertEquals(await pluginManager.processRequest(request), null)
      assertEquals(await pluginManager.processResponse(response), null)
      assertEquals(await pluginManager.processEvent(event), null)

      pluginManager.unregisterPlugin(plugin)
    })

    await t.step('should clear all plugins', () => {
      const plugins: CDPPlugin[] = [
        { name: 'plugin1', onRequest: async (req) => req },
        { name: 'plugin2', onResponse: async (res) => res },
        { name: 'plugin3', onEvent: async (event) => event },
      ]

      for (const plugin of plugins) {
        pluginManager.registerPlugin(plugin)
      }
      assertEquals(pluginManager.hasPlugins(), true)
      assertEquals(pluginManager.getPlugins().length, 3)

      pluginManager.clearPlugins()
      assertEquals(pluginManager.hasPlugins(), false)
      assertEquals(pluginManager.getPlugins().length, 0)
    })
  }
})

Deno.test({
  name: 'PluginManager - sendCDPCommand and emitClientEvent',
  async fn(t) {
    const mockErrorHandler = new ErrorHandler()
    const mockSessionManager = new SessionManager(mockErrorHandler)
    const mockSchemaValidator = new SchemaValidator()
    const mockWsManager = new WebSocketManager(mockErrorHandler, mockSchemaValidator, null)
    const pluginManager = new PluginManager(mockErrorHandler, mockSessionManager, mockWsManager)

    await t.step('sendCDPCommand - invalid session ID', async () => {
      const mockPlugin: CDPPlugin = {
        name: 'test-plugin',
      }

      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      await assertRejects(
        () => pluginManager.sendCDPCommand(mockPlugin, '/devtools/page/123', 'invalid-session', mockRequest),
        Error,
        'Invalid proxy session ID',
      )
    })

    await t.step('emitClientEvent - invalid session ID', async () => {
      const mockEvent: CDPEvent = {
        method: 'TestPlugin.customEvent',
        params: { data: 'test' },
      }

      await assertRejects(
        () => pluginManager.emitClientEvent('invalid-session', mockEvent),
        Error,
        'Invalid proxy session ID',
      )
    })

    await t.step('sendCDPCommand - message processing', async () => {
      const mockPlugin: CDPPlugin = {
        name: 'test-plugin',
      }

      // Create mock WebSocket and wait for it to be ready
      const mockSocket = new MockWebSocket('ws://localhost:9222')
      const openTimeout = setTimeout(() => {
        mockSocket.dispatchEvent(new Event('open'))
      }, 0)

      await new Promise<void>((resolve) => {
        const resolveTimeout = setTimeout(() => {
          clearTimeout(openTimeout)
          resolve()
        }, 0)
        // Clean up if promise resolves before timeout
        setTimeout(() => clearTimeout(resolveTimeout), 0)
      })

      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      // Start the command send and store promise
      const responsePromise = pluginManager.sendCDPCommand(
        mockPlugin,
        '/devtools/page/123',
        mockSession.id,
        mockRequest,
      )

      // Wait for the message to be sent
      const messageTimeout = setTimeout(() => {}, 100)
      await new Promise<void>(resolve => {
        const resolveTimeout = setTimeout(() => {
          clearTimeout(messageTimeout)
          resolve()
        }, 100)
        // Clean up if promise resolves before timeout
        setTimeout(() => clearTimeout(resolveTimeout), 100)
      })

      // Verify the sent message
      const sentMessage = (mockSocket as MockWebSocket).getLastSentMessage()
      const parsedMessage = JSON.parse(sentMessage!)
      assertEquals(parsedMessage.method, 'Page.navigate')
      assertEquals(parsedMessage.params.url, 'https://example.com')
      assertEquals(typeof parsedMessage.id, 'number')
      assertEquals(parsedMessage.id >= PluginManager['PLUGIN_MESSAGE_ID_BASE'], true)

      // Simulate response
      const mockResponse: CDPCommandResponse = {
        id: parsedMessage.id,
        result: { frameId: 'frame-123' },
      }

      // Process the response
      const processedResponse = await pluginManager.processMessage(mockResponse)
      assertEquals(processedResponse, null) // Plugin responses should be filtered out

      // Verify the command response
      const response = await responsePromise
      assertEquals(response.result?.frameId, 'frame-123')

      // Clean up
      mockSocket.close()
      mockSessionManager.removeSession(mockSession.id)
    })

    await t.step('sendCDPCommand - should handle timeout', async () => {
      const mockPlugin: CDPPlugin = {
        name: 'test-plugin',
      }

      const mockSocket = new MockWebSocket('ws://localhost:9222')
      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Wait for the WebSocket to be open
      await new Promise(resolve => setTimeout(resolve, 100))

      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      // Mock the WebSocket send method but don't send a response
      mockSocket.send = () => {}

      // The command should timeout after PLUGIN_COMMAND_TIMEOUT ms
      await assertRejects(
        () => pluginManager.sendCDPCommand(mockPlugin, '/devtools/page/123', mockSession.id, mockRequest),
        Error,
        'CDP command timed out',
      )

      // Clean up
      mockSocket.close()
      mockSessionManager.removeSession(mockSession.id)
    })

    await t.step('sendCDPCommand - should handle closed WebSocket', async () => {
      const mockPlugin: CDPPlugin = {
        name: 'test-plugin',
      }

      const mockSocket = new MockWebSocket('ws://localhost:9222')
      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Close the WebSocket before sending
      mockSocket.close()

      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      await assertRejects(
        () => pluginManager.sendCDPCommand(mockPlugin, '/devtools/page/123', mockSession.id, mockRequest),
        Error,
        'Chrome WebSocket connection is not open',
      )

      mockSessionManager.removeSession(mockSession.id)
    })

    await t.step('sendCDPCommand - should handle CDP error response', async () => {
      const mockPlugin: CDPPlugin = {
        name: 'test-plugin',
      }

      const mockSocket = new MockWebSocket('ws://localhost:9222')
      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Wait for the WebSocket to be open
      await new Promise(resolve => setTimeout(resolve, 100))

      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      // Start the command send
      const responsePromise = pluginManager.sendCDPCommand(
        mockPlugin,
        '/devtools/page/123',
        mockSession.id,
        mockRequest,
      )

      // Wait for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 100))

      // Verify the sent message
      const sentMessage = (mockSocket as MockWebSocket).getLastSentMessage()
      const parsedMessage = JSON.parse(sentMessage!)

      // Simulate an error response
      const mockResponse: CDPCommandResponse = {
        id: parsedMessage.id,
        error: {
          type: CDPErrorType.PROTOCOL,
          code: -32000,
          message: 'Navigation failed',
          recoverable: true,
        },
      }

      // Process the error response
      const processedResponse = await pluginManager.processMessage(mockResponse)
      assertEquals(processedResponse, null) // Plugin responses should be filtered out

      // The command should reject with the error
      await assertRejects(
        () => responsePromise,
        Error,
        'Navigation failed',
      )

      // Clean up
      mockSocket.close()
      mockSessionManager.removeSession(mockSession.id)
    })

    await t.step('emitClientEvent - event emission', async () => {
      const mockEvent: CDPEvent = {
        method: 'TestPlugin.customEvent',
        params: { data: 'test' },
      }

      // Create mock WebSocket
      const mockSocket = new MockWebSocket('ws://localhost:9222')
      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Wait for the WebSocket to be open
      await new Promise(resolve => setTimeout(resolve, 100))

      // Emit the event
      await pluginManager.emitClientEvent(mockSession.id, mockEvent)

      // Verify the sent message
      const sentMessage = (mockSocket as MockWebSocket).getLastSentMessage()
      const parsedMessage = JSON.parse(sentMessage!)
      assertEquals(parsedMessage.method, 'TestPlugin.customEvent')
      assertEquals(parsedMessage.params.data, 'test')

      // Clean up
      mockSocket.close()
      mockSessionManager.removeSession(mockSession.id)
    })

    await t.step('emitClientEvent - should handle closed WebSocket', async () => {
      const mockEvent: CDPEvent = {
        method: 'TestPlugin.customEvent',
        params: { data: 'test' },
      }

      const mockSocket = new MockWebSocket('ws://localhost:9222')
      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Close the WebSocket before sending
      mockSocket.close()

      await assertRejects(
        () => pluginManager.emitClientEvent(mockSession.id, mockEvent),
        Error,
        'Client WebSocket connection is not open',
      )

      mockSessionManager.removeSession(mockSession.id)
    })
  }
})
