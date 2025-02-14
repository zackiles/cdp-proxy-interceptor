import './test_setup.ts'
import { assertRejects, assertExists, assertEquals } from 'jsr:@std/assert'
import { SessionManager } from '../src/session_manager.ts'
import { ErrorHandler } from '../src/error_handler.ts'

class MockWebSocket {
  readyState = 1 // WebSocket.OPEN
  onclose?: () => void
  onerror?: (error: Event) => void

  close() {
    this.readyState = 3 // WebSocket.CLOSED
    if (this.onclose) {
      this.onclose()
    }
  }

  // Add error simulation capability
  simulateError() {
    if (this.onerror) {
      this.onerror(new Event('error'))
    }
  }
}

Deno.test('SessionManager', async (t) => {
  const errorHandler = new ErrorHandler()
  let sessionManager: SessionManager

  // Setup function to create fresh SessionManager for each test
  const setup = () => {
    sessionManager = new SessionManager(errorHandler)
  }

  // Enhanced cleanup that ensures all resources are properly closed
  const cleanupSessions = async () => {
    console.log('Cleaning up sessions...')
    const activeSessions = sessionManager.getActiveSessions()
    console.log(`Found ${activeSessions.length} active sessions to clean up`)

    for (const session of activeSessions) {
      try {
        sessionManager.removeSession(session.id)
        console.log(`Successfully removed session ${session.id}`)
      } catch (error) {
        console.error(`Error cleaning up session ${session.id}:`, error)
      }
    }
  }

  // Run each test with fresh setup and cleanup
  await t.step({
    name: 'should create and retrieve sessions',
    fn: async () => {
      setup()
      const clientSocket = new MockWebSocket() as unknown as WebSocket
      const chromeSocket = new MockWebSocket() as unknown as WebSocket
      const chromeWsUrl = 'ws://test-url'

      const session = sessionManager.createSession(
        clientSocket,
        chromeSocket,
        chromeWsUrl,
      )
      assertExists(session, 'Session should be created')
      assertEquals(
        session.chromeWsUrl,
        chromeWsUrl,
        'WebSocket URL should match',
      )
      assertExists(session.createdAt, 'Creation timestamp should exist')

      const retrievedSession = sessionManager.getSession(session.id)
      assertEquals(
        retrievedSession,
        session,
        'Retrieved session should match created session',
      )
      await cleanupSessions()
    },
    sanitizeResources: false,
    sanitizeOps: false,
  })

  await t.step({
    name: 'should throw error when retrieving non-existent session',
    async fn() {
      await cleanupSessions()
      await assertRejects(
        async () => {
          const session = sessionManager.getSession('non-existent')
          if (!session) throw new Error('Session not found')
          return session
        },
        Error,
        'Session not found',
      )
      await cleanupSessions()
    },
    sanitizeResources: false,
    sanitizeOps: false,
  })

  await t.step({
    name: 'should remove sessions',
    async fn() {
      await cleanupSessions()
      const clientSocket = new MockWebSocket() as unknown as WebSocket
      const chromeSocket = new MockWebSocket() as unknown as WebSocket
      const chromeWsUrl = 'ws://test-url'

      const session = sessionManager.createSession(
        clientSocket,
        chromeSocket,
        chromeWsUrl,
      )
      assertExists(
        sessionManager.getSession(session.id),
        'Session should exist before removal',
      )

      sessionManager.removeSession(session.id)
      await assertRejects(
        async () => {
          const removedSession = sessionManager.getSession(session.id)
          if (!removedSession) throw new Error('Session not found')
          return removedSession
        },
        Error,
        'Session not found',
      )
      await cleanupSessions()
    },
    sanitizeResources: false,
    sanitizeOps: false,
  })

  await t.step({
    name: 'should get active sessions',
    fn: async () => {
      setup()
      await cleanupSessions()
      const clientSocket1 = new MockWebSocket() as unknown as WebSocket
      const chromeSocket1 = new MockWebSocket() as unknown as WebSocket
      const clientSocket2 = new MockWebSocket() as unknown as WebSocket
      const chromeSocket2 = new MockWebSocket() as unknown as WebSocket

      const session1 = sessionManager.createSession(
        clientSocket1,
        chromeSocket1,
        'ws://test-url-1',
      )
      const session2 = sessionManager.createSession(
        clientSocket2,
        chromeSocket2,
        'ws://test-url-2',
      )

      const activeSessions = sessionManager.getActiveSessions()
      assertEquals(activeSessions.length, 2, 'Should have two active sessions')
      assertEquals(
        activeSessions.includes(session1),
        true,
        'Should include first session',
      )
      assertEquals(
        activeSessions.includes(session2),
        true,
        'Should include second session',
      )
      await cleanupSessions()
    },
    sanitizeResources: false,
    sanitizeOps: false,
  })

  await t.step({
    name: 'should get session statistics',
    fn: async () => {
      setup()
      await cleanupSessions()
      const clientSocket1 = new MockWebSocket() as unknown as WebSocket
      const chromeSocket1 = new MockWebSocket() as unknown as WebSocket
      const clientSocket2 = new MockWebSocket() as unknown as WebSocket
      const chromeSocket2 = new MockWebSocket() as unknown as WebSocket

      const session1 = sessionManager.createSession(
        clientSocket1,
        chromeSocket1,
        'ws://test-url-1',
      )
      const session2 = sessionManager.createSession(
        clientSocket2,
        chromeSocket2,
        'ws://test-url-2',
      )

      const stats = sessionManager.getSessionStats()
      assertEquals(stats.active, 2, 'Should have two active sessions')
      assertEquals(
        stats.total >= 2,
        true,
        'Total sessions should be at least 2',
      )

      sessionManager.removeSession(session1.id)
      sessionManager.removeSession(session2.id)

      const updatedStats = sessionManager.getSessionStats()
      assertEquals(updatedStats.active, 0, 'Should have no active sessions')
      assertEquals(
        updatedStats.total >= 2,
        true,
        'Total sessions should still be at least 2',
      )
      await cleanupSessions()
    },
    sanitizeResources: false,
    sanitizeOps: false,
  })
})
