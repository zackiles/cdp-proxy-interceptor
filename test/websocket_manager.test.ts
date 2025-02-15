import './test_setup.ts'
import { assertEquals, assertNotEquals } from 'jsr:@std/assert'
import { WebSocketManager } from '../src/websocket_manager.ts'
import { ErrorHandler } from '../src/error_handler.ts'
import { SchemaValidator } from '../src/schema_validator.ts'
import { PluginManager } from '../src/plugin_manager.ts'
import { CDPErrorType, CDPError } from '../src/types.ts'
import { SessionManager } from '../src/session_manager.ts'
import { MockWebSocket } from './mock_websocket.ts'

Deno.test('WebSocketManager', async (t) => {
  const createDependencies = () => {
    const errorHandler = new ErrorHandler()
    const validator = new SchemaValidator()
    const sessionManager = new SessionManager(errorHandler)
    const wsManager = new WebSocketManager(errorHandler, validator, null)
    const pluginManager = new PluginManager(errorHandler, sessionManager, wsManager)
    wsManager.setPluginManager(pluginManager)
    return {
      errorHandler,
      validator,
      pluginManager,
      manager: wsManager
    }
  }

  const cleanup = async (clientSocket: MockWebSocket, chromeSocket: MockWebSocket) => {
    // Close both sockets
    clientSocket.close()
    chromeSocket.close()
    // Wait for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  await t.step('should handle complete messages correctly', async () => {
    const { manager } = createDependencies()
    const clientSocket = new MockWebSocket('client')
    const chromeSocket = new MockWebSocket('chrome')
    const sessionId = 'test-session'

    try {
      manager.handleConnection(
        clientSocket as unknown as WebSocket,
        chromeSocket as unknown as WebSocket,
        sessionId
      )

      clientSocket.simulateOpen()
      chromeSocket.simulateOpen()

      const messages = Array(5).fill(null).map((_, i) => 
        JSON.stringify({ id: i, method: `test.method${i}` })
      )

      // Send messages
      for (const msg of messages) {
        clientSocket.simulateMessage(msg)
        await new Promise(resolve => setTimeout(resolve, 1))
      }

      await new Promise(resolve => setTimeout(resolve, 10))

      const sentMessages = chromeSocket.getSentMessages()
      assertEquals(sentMessages.length, messages.length, 'All messages should be processed')
      messages.forEach((msg, i) => {
        assertEquals(sentMessages[i], msg, `Message ${i} should be processed correctly`)
      })
    } finally {
      await cleanup(clientSocket, chromeSocket)
    }
  })

  await t.step('should handle WebSocket errors gracefully', async () => {
    const { manager, errorHandler } = createDependencies()
    const capturedErrors: CDPError[] = []
    const clientSocket = new MockWebSocket('client')
    const chromeSocket = new MockWebSocket('chrome')
    const sessionId = 'test-session'
    
    try {
      errorHandler.handleError = (error: CDPError) => {
        capturedErrors.push(error)
        console.debug('Captured error:', error)
      }

      manager.handleConnection(
        clientSocket as unknown as WebSocket,
        chromeSocket as unknown as WebSocket,
        sessionId
      )

      // Simulate connections opening
      clientSocket.simulateOpen()
      chromeSocket.simulateOpen()

      // 1. Trigger error event on client socket
      clientSocket.onerror?.(new ErrorEvent('error', { error: new Error('Client connection error') }))
      await new Promise(resolve => setTimeout(resolve, 50))

      // 2. Trigger abnormal closure on client socket - this is a disconnection error, should be suppressed
      clientSocket.onclose?.({ code: 1006, reason: 'Connection lost', wasClean: false } as CloseEvent)
      await new Promise(resolve => setTimeout(resolve, 50))

      // 3. Trigger send failure by closing Chrome socket and attempting to send message - this is a disconnection error, should be suppressed
      chromeSocket.close()
      clientSocket.simulateMessage(JSON.stringify({ id: 1, method: "test" }))
      await new Promise(resolve => setTimeout(resolve, 50))

      // Wait for all errors to be processed
      await new Promise(resolve => setTimeout(resolve, 100))

      assertEquals(capturedErrors.length, 1, 'Should only capture non-disconnection errors')
      
      // Verify the error: client error event
      assertEquals(capturedErrors[0].type, CDPErrorType.CONNECTION, 'Should handle network errors')
      assertEquals(capturedErrors[0].code, 1006, 'Should use correct error code for connection error')
      assertEquals(capturedErrors[0].recoverable, true, 'Connection errors should be marked recoverable')
    } finally {
      await cleanup(clientSocket, chromeSocket)
    }
  })

  await t.step('should handle message buffer limits correctly', async () => {
    const { manager } = createDependencies()
    const clientSocket = new MockWebSocket('client')
    const chromeSocket = new MockWebSocket('chrome')
    const sessionId = 'test-session'

    try {
      manager.handleConnection(
        clientSocket as unknown as WebSocket,
        chromeSocket as unknown as WebSocket,
        sessionId
      )

      // Only open client connection and ensure Chrome is not open
      clientSocket.simulateOpen()
      chromeSocket.setReadyState(WebSocket.CONNECTING) // Ensure Chrome appears not ready
      await new Promise(resolve => setTimeout(resolve, 10)) // Wait for connection state setup

      // Send exactly maxMessages to match implementation
      const maxMessages = 1000 // This matches WebSocketManager.MAX_PENDING_MESSAGES
      const messages = Array(maxMessages).fill(null).map((_, i) => 
        JSON.stringify({ id: i, method: `test.method${i}` })
      )

      // Send all messages
      for (const msg of messages) {
        clientSocket.simulateMessage(msg)
        await new Promise(resolve => setTimeout(resolve, 1))
      }

      // Now open Chrome connection
      chromeSocket.setReadyState(WebSocket.OPEN)
      chromeSocket.simulateOpen()
      await new Promise(resolve => setTimeout(resolve, 100))

      // Verify all messages were kept and sent
      const sentMessages = chromeSocket.getSentMessages()
      assertEquals(sentMessages.length, maxMessages, 'Should keep all messages within limit')
      
      messages.forEach((msg, i) => {
        assertEquals(sentMessages[i], msg, `Message ${i} should be delivered in order`)
      })
    } finally {
      await cleanup(clientSocket, chromeSocket)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  })

  await t.step('should maintain session isolation', async () => {
    const { manager } = createDependencies()
    
    // Create two separate sessions
    const session1 = {
      clientSocket: new MockWebSocket('client1'),
      chromeSocket: new MockWebSocket('chrome1'),
      id: 'session-1'
    }
    
    const session2 = {
      clientSocket: new MockWebSocket('client2'),
      chromeSocket: new MockWebSocket('chrome2'),
      id: 'session-2'
    }

    try {
      // Set up both sessions
      manager.handleConnection(
        session1.clientSocket as unknown as WebSocket,
        session1.chromeSocket as unknown as WebSocket,
        session1.id
      )

      manager.handleConnection(
        session2.clientSocket as unknown as WebSocket,
        session2.chromeSocket as unknown as WebSocket,
        session2.id
      )

      // Open only client connections
      session1.clientSocket.simulateOpen()
      session2.clientSocket.simulateOpen()

      // Send different messages for each session
      const messages1 = Array(3).fill(null).map((_, i) => 
        JSON.stringify({ id: i, method: `session1.method${i}` })
      )

      const messages2 = Array(3).fill(null).map((_, i) => 
        JSON.stringify({ id: i, method: `session2.method${i}` })
      )

      // Send messages to both sessions
      for (const msg of messages1) {
        session1.clientSocket.simulateMessage(msg)
      }

      for (const msg of messages2) {
        session2.clientSocket.simulateMessage(msg)
      }

      await new Promise(resolve => setTimeout(resolve, 10))

      // Open Chrome connections one at a time and verify isolation
      session1.chromeSocket.simulateOpen()
      await new Promise(resolve => setTimeout(resolve, 10))

      session2.chromeSocket.simulateOpen()
      await new Promise(resolve => setTimeout(resolve, 10))

      // Verify each session got only its own messages
      const sent1 = session1.chromeSocket.getSentMessages()
      const sent2 = session2.chromeSocket.getSentMessages()

      assertEquals(sent1.length, messages1.length, 'Session 1 should get only its messages')
      assertEquals(sent2.length, messages2.length, 'Session 2 should get only its messages')

      messages1.forEach((msg, i) => {
        assertEquals(sent1[i], msg, `Session 1 message ${i} should match`)
        assertNotEquals(sent2[i], msg, `Session 2 should not get Session 1's message ${i}`)
      })

      messages2.forEach((msg, i) => {
        assertEquals(sent2[i], msg, `Session 2 message ${i} should match`)
        assertNotEquals(sent1[i], msg, `Session 1 should not get Session 2's message ${i}`)
      })
    } finally {
      // Clean up both sessions
      await cleanup(session1.clientSocket, session1.chromeSocket)
      await cleanup(session2.clientSocket, session2.chromeSocket)
      await new Promise(resolve => setTimeout(resolve, 100)) // Wait for cleanup to complete
    }
  })

  await t.step('should handle WebSocket connection edge cases', async () => {
    const { manager } = createDependencies()
    const clientSocket = new MockWebSocket('client')
    const chromeSocket = new MockWebSocket('chrome')
    const sessionId = 'test-session'

    try {
      // Test rapid connect/disconnect scenarios
      manager.handleConnection(
        clientSocket as unknown as WebSocket,
        chromeSocket as unknown as WebSocket,
        sessionId
      )

      // Simulate client connecting before Chrome
      clientSocket.simulateOpen()
      
      // Send messages before Chrome is ready
      const messages = Array(10).fill(null).map((_, i) => 
        JSON.stringify({ id: i, method: `test.method${i}` })
      )
      
      for (const msg of messages) {
        clientSocket.simulateMessage(msg)
      }

      // Simulate Chrome connection dropping and reconnecting
      chromeSocket.simulateOpen()
      chromeSocket.close(1006, 'Connection lost')
      
      const newChromeSocket = new MockWebSocket('chrome2')
      manager.handleConnection(
        clientSocket as unknown as WebSocket,
        newChromeSocket as unknown as WebSocket,
        sessionId
      )
      newChromeSocket.simulateOpen()

      await new Promise(resolve => setTimeout(resolve, 50))

    } finally {
      await cleanup(clientSocket, chromeSocket)
    }
  })

}) 