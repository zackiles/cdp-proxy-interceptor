import './test_setup.ts'
import { assertExists, assertEquals, assertRejects } from 'jsr:@std/assert'
import { PluginManager } from '../src/plugin_manager.ts'
import { ErrorHandler } from '../src/error_handler.ts'
import { SessionManager } from '../src/session_manager.ts'
import { WebSocketManager } from '../src/websocket_manager.ts'
import { SchemaValidator } from '../src/schema_validator.ts'
import { CDPErrorType } from '../src/types.ts'
import { BaseCDPPlugin } from '../src/base_cdp_plugin.ts'
import type {
  CDPPlugin,
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
} from '../src/types.ts'
import { MockWebSocket } from './mock_websocket.ts'

class TestPlugin extends BaseCDPPlugin {
  override name = 'test-plugin'
  override async onRequest(req: CDPCommandRequest): Promise<CDPCommandRequest | null> {
    return req
  }
}

class RequestPlugin extends BaseCDPPlugin {
  override name = 'request-plugin'
  override async onRequest(req: CDPCommandRequest): Promise<CDPCommandRequest | null> {
    return {
      ...req,
      params: { ...req.params, modified: true },
    }
  }
}

class ResponsePlugin extends BaseCDPPlugin {
  override name = 'response-plugin'
  override async onResponse(res: CDPCommandResponse): Promise<CDPCommandResponse | null> {
    return {
      ...res,
      result: { ...res.result, modified: true },
    }
  }
}

class EventPlugin extends BaseCDPPlugin {
  override name = 'event-plugin'
  override async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    return {
      ...event,
      params: { ...event.params, modified: true },
    }
  }
}

class ErrorPlugin extends BaseCDPPlugin {
  override name = 'error-plugin'
  override async onRequest(): Promise<CDPCommandRequest | null> {
    throw new Error('Plugin error')
  }
}

class BlockingPlugin extends BaseCDPPlugin {
  override name = 'blocking-plugin'
  override async onRequest(): Promise<CDPCommandRequest | null> {
    return null
  }
  override async onResponse(): Promise<CDPCommandResponse | null> {
    return null
  }
  override async onEvent(): Promise<CDPEvent | null> {
    return null
  }
}

Deno.test({
  name: 'PluginManager',
  async fn(t) {
    const mockErrorHandler = new ErrorHandler()
    const mockSessionManager = new SessionManager(mockErrorHandler)
    const mockSchemaValidator = new SchemaValidator()
    const mockWsManager = new WebSocketManager(mockErrorHandler, mockSchemaValidator, null)
    const pluginManager = new PluginManager(mockErrorHandler, mockSessionManager, mockWsManager)

    await t.step('should register and unregister plugins', () => {
      const plugin = new TestPlugin()

      pluginManager.registerPlugin(plugin)
      assertEquals(pluginManager.hasPlugins(), true)
      assertEquals(pluginManager.getPlugins().length, 1)

      pluginManager.unregisterPlugin(plugin)
      assertEquals(pluginManager.hasPlugins(), false)
      assertEquals(pluginManager.getPlugins().length, 0)
    })

    await t.step('should process requests through plugins', async () => {
      const plugin = new RequestPlugin()

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
      const plugin = new ResponsePlugin()

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
      const plugin = new EventPlugin()

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
      const plugin = new ErrorPlugin()

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
      const plugin = new BlockingPlugin()

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

    await t.step('should clear all plugins', async () => {
      const plugins = [
        new TestPlugin(),
        new ResponsePlugin(),
        new EventPlugin(),
      ]

      for (const plugin of plugins) {
        pluginManager.registerPlugin(plugin)
      }
      assertEquals(pluginManager.hasPlugins(), true)
      assertEquals(pluginManager.getPlugins().length, 3)

      await pluginManager.clearPlugins()
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
      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      await assertRejects(
        () => pluginManager.sendCDPCommand(
          '/devtools/page/123',
          'invalid-session',
          mockRequest
        ),
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
      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      // Create mock WebSocket and simulate open state
      const mockSocket = new MockWebSocket('ws://localhost:9222')
      mockSocket.simulateOpen()

      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Start the command send
      const responsePromise = pluginManager.sendCDPCommand(
        '/devtools/page/123',
        mockSession.id,
        mockRequest
      )

      // Wait a bit for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 50))

      // Verify the sent message
      const sentMessage = mockSocket.getLastSentMessage()
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

      // Simulate receiving the response message
      mockSocket.simulateMessage(JSON.stringify(mockResponse))

      // Verify the command response
      const response = await responsePromise
      assertEquals(response.id, mockResponse.id)
      assertEquals(response.result?.frameId, (mockResponse.result as { frameId: string }).frameId)

      // Clean up
      mockSocket.close()
      mockSessionManager.removeSession(mockSession.id)
    })

    await t.step('sendCDPCommand - should handle timeout', async () => {
      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      const mockSocket = new MockWebSocket('ws://localhost:9222')
      mockSocket.simulateOpen()
      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Mock the WebSocket send method but don't send a response
      mockSocket.send = () => {}

      // The command should timeout after PLUGIN_COMMAND_TIMEOUT ms
      await assertRejects(
        () => pluginManager.sendCDPCommand(
          '/devtools/page/123',
          mockSession.id,
          mockRequest
        ),
        Error,
        'CDP command timed out',
      )

      // Clean up
      mockSocket.close()
      mockSessionManager.removeSession(mockSession.id)
    })

    await t.step('sendCDPCommand - should handle closed WebSocket', async () => {
      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      const mockSocket = new MockWebSocket('ws://localhost:9222')
      mockSocket.simulateOpen()
      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Close the WebSocket before sending
      mockSocket.setReadyState(WebSocket.CLOSED)

      await assertRejects(
        () => pluginManager.sendCDPCommand(
          '/devtools/page/123',
          mockSession.id,
          mockRequest
        ),
        Error,
        'Chrome WebSocket connection is not open',
      )

      mockSessionManager.removeSession(mockSession.id)
    })

    await t.step('sendCDPCommand - should handle CDP error response', async () => {
      const mockRequest: CDPCommandRequest = {
        id: 1,
        method: 'Page.navigate',
        params: { url: 'https://example.com' },
      }

      const mockSocket = new MockWebSocket('ws://localhost:9222')
      mockSocket.simulateOpen()
      const mockSession = mockSessionManager.createSession(mockSocket, mockSocket, 'ws://localhost:9222')

      // Start the command send
      const responsePromise = pluginManager.sendCDPCommand(
        '/devtools/page/123',
        mockSession.id,
        mockRequest
      )

      // Wait a bit for the message to be sent
      await new Promise(resolve => setTimeout(resolve, 50))

      // Get the sent message ID
      const sentMessage = mockSocket.getLastSentMessage()
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

      // Simulate receiving the error response
      mockSocket.simulateMessage(JSON.stringify(mockResponse))

      // The command should resolve with the error response
      const response = await responsePromise
      assertEquals(response.id, mockResponse.id)
      assertEquals(response.error?.code, mockResponse.error?.code)
      assertEquals(response.error?.message, mockResponse.error?.message)

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
