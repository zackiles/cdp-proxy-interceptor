import type {
  CDPPlugin,
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
} from '../src/types.ts'

// Extend base CDP types with specific params/results
interface CDPTargetInfo {
  type: string
  targetId: string
}

interface CDPFrameEvent extends CDPEvent {
  params: {
    frame?: { id: string }
    frameId?: string
  }
}

interface CDPTargetEvent extends CDPEvent {
  params: {
    targetInfo: CDPTargetInfo
  }
}

interface CDPIsolatedWorldResponse extends CDPCommandResponse {
  result: {
    executionContextId: number
  }
}

// NOTE: See RFC for this plugin in docs/playwright-stealth-plugin.md
export class RuntimeEnableMitMPlugin implements CDPPlugin {
  name = 'RuntimeEnableMitMPlugin'

  // Tracks if a session thinks "Runtime is enabled" so we can
  // give them synthetic contexts and skip real calls.
  sessionsRuntimeEnabled: Map<string, boolean> = new Map() // key=CDP sessionId, value=boolean

  // Track known frames and their assigned contextIds:
  frameContexts: Map<string, number> = new Map() // key=frameId, value=executionContextId

  // These will be injected by the plugin manager
  declare sendCDPCommand: (
    endpoint: string,
    proxySessionId: string,
    message: CDPCommandRequest,
  ) => Promise<CDPCommandResponse>
  declare emitClientEvent: (
    proxySessionId: string,
    event: CDPEvent,
  ) => Promise<void>

  async onRequest(
    request: CDPCommandRequest,
  ): Promise<CDPCommandRequest | null> {
    if (!request || !request.method) return request

    if (request.method === 'Runtime.enable') {
      if (!request.sessionId) {
        return request
      }

      this.sessionsRuntimeEnabled.set(request.sessionId, true)

      const mockResponse = {
        id: request.id,
        result: {},
      }

      await this.emitClientEvent?.(request.sessionId, {
        method: 'Runtime.enable',
        params: mockResponse,
      })
      return null
    }

    return request
  }

  async onResponse(
    response: CDPCommandResponse,
  ): Promise<CDPCommandResponse | null> {
    // Typically do not manipulate responses here for this patch approach.
    return response
  }

  async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    if (!event || !event.method) return event

    if (
      event.method === 'Page.frameAttached' ||
      event.method === 'Page.frameNavigated'
    ) {
      const { sessionId } = event
      if (!sessionId || !this.sessionsRuntimeEnabled.get(sessionId)) {
        return event
      }

      // Extract or generate frameId
      const frameId =
        (event as CDPFrameEvent).params.frame?.id ||
        (event as CDPFrameEvent).params.frameId
      if (!frameId) return event

      // If we haven't created a context yet for this frame, do it now
      if (!this.frameContexts.has(frameId)) {
        const contextId = await this.createIsolatedContext(sessionId, frameId)
        // store the mapping
        this.frameContexts.set(frameId, contextId as number)

        // 3. Emit a synthetic Runtime.executionContextCreated event
        // so Playwright believes that a normal main-world context was created:
        const fakeContextCreated = {
          method: 'Runtime.executionContextCreated',
          params: {
            context: {
              id: contextId,
              origin: '', //  RFC: Empty string
              name: '', // RFC: Empty string
              auxData: {
                frameId,
                isDefault: true,
              },
            },
          },
          sessionId,
        }
        // Corrected: Use this.emitClientEvent
        await this.emitClientEvent(sessionId, fakeContextCreated)
      }
    }

    // 2.b Observe new workers
    if (event.method === 'Target.attachedToTarget') {
      const sessionId = event.sessionId

      if (!sessionId || !this.sessionsRuntimeEnabled.get(sessionId)) {
        return event
      }

      const { targetInfo } = (event as CDPTargetEvent).params
      if (!targetInfo) {
        return event
      }

      const { type, targetId: frameId } = targetInfo
      if (type !== 'worker' && type !== 'service_worker') {
        return event
      }

      if (!this.frameContexts.has(frameId)) {
        const contextId = await this.createIsolatedContext(sessionId, frameId)
        this.frameContexts.set(frameId, contextId as number)

        const fakeContextCreated = {
          method: 'Runtime.executionContextCreated',
          params: {
            context: {
              id: contextId,
              origin: '',
              name: '',
              auxData: {
                frameId,
                isDefault: false, // Workers are not default contexts
              },
            },
          },
          sessionId,
        }
        // Corrected: Use this.emitClientEvent
        await this.emitClientEvent(sessionId, fakeContextCreated)
      }
    }

    return event
  }

  /**
   * Creates a new isolated context in the real browser by calling
   * Page.createIsolatedWorld and returns the executionContextId.
   */
  async createIsolatedContext(sessionId: string, frameId: string) {
    if (!this.sendCDPCommand) {
      throw new Error('sendCDPCommand not available')
    }

    const result = (await this.sendCDPCommand(
      `/devtools/page/${frameId}`,
      sessionId,
      {
        id: Date.now(),
        method: 'Page.createIsolatedWorld',
        params: {
          frameId,
          worldName: `__MITM_InvisibleWorld_${frameId}`,
          grantUniveralAccess: true,
        },
      },
    )) as CDPIsolatedWorldResponse
    return result.result.executionContextId
  }
}

export default new RuntimeEnableMitMPlugin()
