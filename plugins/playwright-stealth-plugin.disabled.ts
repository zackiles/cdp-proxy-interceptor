import type {
  CDPCommandRequest,
  CDPCommandResponse,
  CDPEvent,
} from '../src/types.ts'
import { BaseCDPPlugin } from '../src/base_cdp_plugin.ts'

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
export class RuntimeEnableMitMPlugin extends BaseCDPPlugin {
  name = 'RuntimeEnableMitMPlugin'

  // Tracks if a session thinks "Runtime is enabled" so we can
  // give them synthetic contexts and skip real calls.
  sessionsRuntimeEnabled: Map<string, boolean> = new Map() // key=CDP sessionId, value=boolean

  // Track known frames and their assigned contextIds:
  frameContexts: Map<string, number> = new Map() // key=frameId, value=executionContextId

  // Track worker contexts separately
  workerContexts: Map<string, number> = new Map() // key=workerId, value=executionContextId

  override async onRequest(
    request: CDPCommandRequest,
  ): Promise<CDPCommandRequest | null> {
    if (!request?.method) return request

    if (request.method === 'Runtime.enable') {
      if (!request.sessionId) {
        console.warn('Runtime.enable called without sessionId')
        return request
      }

      try {
        this.sessionsRuntimeEnabled.set(request.sessionId, true)

        const mockResponse = {
          id: request.id,
          result: {},
        }

        await this.emitClientEvent?.(request.sessionId, {
          method: 'Runtime.enable',
          params: mockResponse,
        })
        return null // Drop the original request
      } catch (error) {
        console.error('Failed to handle Runtime.enable:', error)
        throw error // Let the proxy handle the error
      }
    }

    return request
  }

  override async onResponse(
    response: CDPCommandResponse,
  ): Promise<CDPCommandResponse | null> {
    // Typically do not manipulate responses here for this patch approach.
    return response
  }

  override async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    if (!event?.method) return event

    try {
      // Handle frame lifecycle events
      if (
        event.method === 'Page.frameAttached' ||
        event.method === 'Page.frameNavigated'
      ) {
        return await this.handleFrameEvent(event)
      }

      // Handle frame cleanup
      if (event.method === 'Page.frameDetached') {
        return await this.handleFrameDetached(event)
      }

      // Handle worker events
      if (event.method === 'Target.attachedToTarget') {
        return await this.handleWorkerEvent(event)
      }

      // Handle worker cleanup
      if (event.method === 'Target.detachedFromTarget') {
        return await this.handleWorkerDetached(event)
      }

      return event
    } catch (error) {
      console.error(`Failed to handle event ${event.method}:`, error)
      return event // Return original event on error
    }
  }

  private async handleFrameEvent(event: CDPEvent): Promise<CDPEvent> {
    const { sessionId } = event
    if (!sessionId || !this.sessionsRuntimeEnabled.get(sessionId)) {
      return event
    }

    const frameId =
      (event as CDPFrameEvent).params.frame?.id ||
      (event as CDPFrameEvent).params.frameId
    if (!frameId) return event

    // If we haven't created a context yet for this frame, do it now
    if (!this.frameContexts.has(frameId)) {
      try {
        const contextId = await this.createIsolatedContext(sessionId, frameId)
        this.frameContexts.set(frameId, contextId)

        await this.emitSyntheticContext(sessionId, contextId, frameId, true)
      } catch (error) {
        console.error(`Failed to create context for frame ${frameId}:`, error)
      }
    }

    return event
  }

  private async handleFrameDetached(event: CDPEvent): Promise<CDPEvent> {
    const frameId = (event as CDPFrameEvent).params.frameId
    if (frameId) {
      this.frameContexts.delete(frameId)
    }
    return event
  }

  private async handleWorkerEvent(event: CDPEvent): Promise<CDPEvent> {
    const { sessionId } = event
    if (!sessionId || !this.sessionsRuntimeEnabled.get(sessionId)) {
      return event
    }

    const { targetInfo } = (event as CDPTargetEvent).params
    if (!targetInfo) return event

    const { type, targetId: workerId } = targetInfo
    if (type !== 'worker' && type !== 'service_worker') {
      return event
    }

    if (!this.workerContexts.has(workerId)) {
      try {
        const contextId = await this.createIsolatedContext(sessionId, workerId)
        this.workerContexts.set(workerId, contextId)

        await this.emitSyntheticContext(sessionId, contextId, workerId, false)
      } catch (error) {
        console.error(`Failed to create context for worker ${workerId}:`, error)
      }
    }

    return event
  }

  private async handleWorkerDetached(event: CDPEvent): Promise<CDPEvent> {
    const workerId = (event as CDPTargetEvent).params.targetInfo?.targetId
    if (workerId) {
      this.workerContexts.delete(workerId)
    }
    return event
  }

  private async emitSyntheticContext(
    sessionId: string,
    contextId: number,
    frameId: string,
    isDefault: boolean,
  ): Promise<void> {
    const syntheticEvent = {
      method: 'Runtime.executionContextCreated',
      params: {
        context: {
          id: contextId,
          origin: '', // RFC: Empty string
          name: '', // RFC: Empty string
          auxData: {
            frameId,
            isDefault,
          },
        },
      },
      sessionId,
    }

    await this.emitClientEvent(sessionId, syntheticEvent)
  }

  /**
   * Creates a new isolated context in the real browser by calling
   * Page.createIsolatedWorld and returns the executionContextId.
   */
  private async createIsolatedContext(
    sessionId: string,
    frameId: string,
  ): Promise<number> {
    if (!this.sendCDPCommand) {
      throw new Error('sendCDPCommand not available')
    }

    try {
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

      if (!result?.result?.executionContextId) {
        throw new Error('Failed to get executionContextId from isolated world creation')
      }

      return result.result.executionContextId
    } catch (error) {
      console.error(`Failed to create isolated context for ${frameId}:`, error)
      throw error
    }
  }

  /**
   * Cleanup method to be called when the plugin is being disposed
   */
  override async cleanup(): Promise<void> {
    this.sessionsRuntimeEnabled.clear()
    this.frameContexts.clear()
    this.workerContexts.clear()
  }
}

export default new RuntimeEnableMitMPlugin()
