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

interface CDPBindingCalledEvent extends CDPEvent {
  params: {
    name: string
    payload: string
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

  // Track binding names for addBinding mode
  bindingNames: Map<string, string> = new Map() // key=frameId, value=bindingName

  // Configuration
  private readonly fixMode = Deno.env.get('REBROWSER_PATCHES_RUNTIME_FIX_MODE') || 'addBinding'
  private readonly utilityWorldName = Deno.env.get('REBROWSER_PATCHES_UTILITY_WORLD_NAME') !== '0' 
    ? (Deno.env.get('REBROWSER_PATCHES_UTILITY_WORLD_NAME') || 'util') 
    : '__playwright_utility_world__'

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
        console.debug(`[onRequest] Runtime.enable intercepted for session: ${request.sessionId}`)
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
    console.debug(`[onResponse] Received response for method: ${response.id}`)
    return response
  }

  override async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    if (!event?.method) return event

    try {
      // Handle binding called events for addBinding mode
      if (event.method === 'Runtime.bindingCalled' && event.params) {
        console.debug(`[onEvent] Runtime.bindingCalled event: ${event.params.name}`)
        return await this.handleBindingCalled(event as CDPBindingCalledEvent)
      }

      // Handle frame lifecycle events
      if (
        event.method === 'Page.frameAttached' ||
        event.method === 'Page.frameNavigated'
      ) {
        console.debug(`[onEvent] Frame event: ${event.method}`)
        return await this.handleFrameEvent(event)
      }

      // Handle frame cleanup
      if (event.method === 'Page.frameDetached') {
        console.debug(`[onEvent] Page.frameDetached event`)
        return await this.handleFrameDetached(event)
      }

      // Handle worker events
      if (event.method === 'Target.attachedToTarget') {
        console.debug(`[onEvent] Target.attachedToTarget event`)
        return await this.handleWorkerEvent(event)
      }

      // Handle worker cleanup
      if (event.method === 'Target.detachedFromTarget') {
        console.debug(`[onEvent] Target.detachedFromTarget event`)
        return await this.handleWorkerDetached(event)
      }

      console.debug(`[onEvent] Other event: ${event.method}`)
      return event
    } catch (error) {
      console.error(`Failed to handle event ${event.method}:`, error)
      return event // Return original event on error
    }
  }

  private async handleBindingCalled(event: CDPBindingCalledEvent): Promise<CDPEvent | null> {
    const { sessionId } = event
    if (!sessionId || !event.params) return event

    // Filter out non-JSON binding payloads in addBinding mode
    if (this.fixMode === 'addBinding' && !event.params.payload?.includes('{')) {
      return null
    }

    return event
  }

  private async handleFrameEvent(event: CDPEvent): Promise<CDPEvent> {
    const { sessionId } = event
    if (!sessionId || !this.sessionsRuntimeEnabled.get(sessionId)) {
      return event
    }

    const frameId =
      (event as CDPFrameEvent).params?.frame?.id ||
      (event as CDPFrameEvent).params?.frameId
    if (!frameId) return event

    // Emit executionContextsCleared on navigation
    if (event.method === 'Page.frameNavigated') {
      console.debug(`[handleFrameEvent] Page.frameNavigated - Clearing contexts for session: ${sessionId}`)
      await this.emitClientEvent(sessionId, {
        method: 'Runtime.executionContextsCleared',
        params: {},
      })
    }

    // Create context based on fix mode
    if (!this.frameContexts.has(frameId)) {
      try {
        console.debug(`[handleFrameEvent] Creating context for frameId: ${frameId}, mode: ${this.fixMode}`)
        if (this.fixMode === 'addBinding') {
          await this.setupAddBindingMode(sessionId, frameId)
        } else {
          // alwaysIsolated mode
          const response = await this.createIsolatedContext(sessionId, frameId)
          if (!response?.result?.executionContextId) {
            console.error('Failed to get executionContextId for frame context')
            return event
          }
          this.frameContexts.set(frameId, response.result.executionContextId)
          await this.emitSyntheticContext(sessionId, response.result.executionContextId, frameId, true)
        }
      } catch (error) {
        console.error(`Failed to create context for frame ${frameId}:`, error)
      }
    }

    return event
  }

  private async setupAddBindingMode(sessionId: string, frameId: string): Promise<void> {
    // Generate random binding name
    console.debug(`[setupAddBindingMode] Setting up addBinding mode for frameId: ${frameId}`)
    const randomName = [...Array(Math.floor(Math.random() * (10 + 1)) + 10)]
      .map(() => Math.random().toString(36)[2])
      .join('')
    
    this.bindingNames.set(frameId, randomName)

    // Add binding
    await this.sendCDPCommand(
      `/devtools/page/${frameId}`,
      sessionId,
      {
        id: Date.now(),
        method: 'Runtime.addBinding',
        params: { name: randomName },
      }
    )

    // Add script to evaluate
    await this.sendCDPCommand(
      `/devtools/page/${frameId}`,
      sessionId,
      {
        id: Date.now(),
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: {
          source: `document.addEventListener('${randomName}', (e) => self['${randomName}'](e.detail.frameId))`,
          runImmediately: true,
        },
      }
    )

    // Create isolated world and trigger binding
    const isolatedWorldResponse = await this.createIsolatedContext(sessionId, frameId, randomName)
    if (!isolatedWorldResponse?.result?.executionContextId) {
      throw new Error('Failed to get executionContextId from isolated world creation')
    }

    await this.sendCDPCommand(
      `/devtools/page/${frameId}`,
      sessionId,
      {
        id: Date.now(),
        method: 'Runtime.evaluate',
        params: {
          expression: `document.dispatchEvent(new CustomEvent('${randomName}', { detail: { frameId: '${frameId}' } }))`,
          contextId: isolatedWorldResponse.result.executionContextId,
        },
      }
    )

    // Store the context ID for this frame
    this.frameContexts.set(frameId, isolatedWorldResponse.result.executionContextId)
    await this.emitSyntheticContext(sessionId, isolatedWorldResponse.result.executionContextId, frameId, true)
  }

  private async handleFrameDetached(event: CDPEvent): Promise<CDPEvent> {
    const frameId = (event as CDPFrameEvent).params?.frameId
    if (frameId) {
      console.debug(`[handleFrameDetached] Detaching frameId: ${frameId}`)
      this.frameContexts.delete(frameId)
      this.bindingNames.delete(frameId)
    }
    return event
  }

  private async handleWorkerEvent(event: CDPEvent): Promise<CDPEvent> {
    const { sessionId } = event
    if (!sessionId || !this.sessionsRuntimeEnabled.get(sessionId)) {
      return event
    }

    const targetInfo = (event as CDPTargetEvent).params?.targetInfo
    if (!targetInfo) return event

    const { type, targetId: workerId } = targetInfo
    if (!workerId || (type !== 'worker' && type !== 'service_worker')) {
      return event
    }

    if (!this.workerContexts.has(workerId)) {
      try {
        console.debug(`[handleWorkerEvent] Creating context for workerId: ${workerId}, mode: ${this.fixMode}`)
        if (this.fixMode === 'addBinding') {
          await this.setupWorkerAddBindingMode(sessionId, workerId)
        } else {
          const response = await this.createIsolatedContext(sessionId, workerId)
          if (!response?.result?.executionContextId) {
            console.error('Failed to get executionContextId for worker context')
            return event
          }
          this.workerContexts.set(workerId, response.result.executionContextId)
          await this.emitSyntheticContext(sessionId, response.result.executionContextId, workerId, false)
        }
      } catch (error) {
        console.error(`Failed to create context for worker ${workerId}:`, error)
      }
    }

    return event
  }

  private async handleWorkerDetached(event: CDPEvent): Promise<CDPEvent> {
    const workerId = (event as CDPTargetEvent).params?.targetInfo?.targetId
    if (workerId) {
      console.debug(`[handleWorkerDetached] Detaching workerId: ${workerId}`)
      this.workerContexts.delete(workerId)
      this.bindingNames.delete(workerId)
    }
    return event
  }

  private async setupWorkerAddBindingMode(sessionId: string, workerId: string): Promise<void> {
    console.debug(`[setupWorkerAddBindingMode] Setting up addBinding mode for workerId: ${workerId}`)
    const randomName = [...Array(Math.floor(Math.random() * (10 + 1)) + 10)]
      .map(() => Math.random().toString(36)[2])
      .join('')
    
    this.bindingNames.set(workerId, randomName)

    // Add binding
    await this.sendCDPCommand(
      `/devtools/page/${workerId}`,
      sessionId,
      {
        id: Date.now(),
        method: 'Runtime.addBinding',
        params: { name: randomName },
      }
    )

    // For workers, directly evaluate the binding call
    const response = await this.sendCDPCommand(
      `/devtools/page/${workerId}`,
      sessionId,
      {
        id: Date.now(),
        method: 'Runtime.evaluate',
        params: {
          expression: `this['${randomName}']('${workerId}')`,
        },
      }
    ) as CDPIsolatedWorldResponse

    if (!response?.result?.executionContextId) {
      throw new Error('Failed to get executionContextId from worker evaluation')
    }

    // Store the context ID for this worker
    this.workerContexts.set(workerId, response.result.executionContextId)
    await this.emitSyntheticContext(sessionId, response.result.executionContextId, workerId, false)
  }

  private async emitSyntheticContext(
    sessionId: string,
    contextId: number,
    frameId: string,
    isDefault: boolean,
  ): Promise<void> {
    console.debug(`[emitSyntheticContext] Emitting context: ${contextId} for frameId: ${frameId}, isDefault: ${isDefault}, session: ${sessionId}`)
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

  private async createIsolatedContext(
    sessionId: string,
    frameId: string,
    worldName?: string,
  ): Promise<CDPIsolatedWorldResponse> {
    if (!this.sendCDPCommand) {
      throw new Error('sendCDPCommand not available')
    }

    try {
      const effectiveWorldName = worldName || `${this.utilityWorldName}_${frameId}`
      console.debug(`[createIsolatedContext] Creating isolated context for frameId: ${frameId}, worldName: ${effectiveWorldName}`)
      
      const result = await this.sendCDPCommand(
        `/devtools/page/${frameId}`,
        sessionId,
        {
          id: Date.now(),
          method: 'Page.createIsolatedWorld',
          params: {
            frameId,
            worldName: effectiveWorldName,
            grantUniveralAccess: true,
          },
        },
      ) as CDPIsolatedWorldResponse

      if (!result?.result?.executionContextId) {
        throw new Error('Failed to get executionContextId from isolated world creation')
      }

      return result
    } catch (error) {
      console.error(`Failed to create isolated context for ${frameId}:`, error)
      throw error
    }
  }

  override async cleanup(): Promise<void> {
    this.sessionsRuntimeEnabled.clear()
    this.frameContexts.clear()
    this.workerContexts.clear()
    this.bindingNames.clear()
  }
}

export default new RuntimeEnableMitMPlugin()
