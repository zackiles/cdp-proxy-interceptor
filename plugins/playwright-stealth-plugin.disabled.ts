import type { CDPPlugin, CDPCommandRequest, CDPCommandResponse, CDPEvent } from '../src/types.ts'

export class RuntimeEnableMitMPlugin implements CDPPlugin {
  name = "RuntimeEnableMitMPlugin";

  // Tracks if a session thinks "Runtime is enabled" so we can
  // give them synthetic contexts and skip real calls.
  sessionsRuntimeEnabled: Map<string, boolean> = new Map(); // key=CDP sessionId, value=boolean

  // Track known frames and their assigned contextIds:
  frameContexts: Map<string, number> = new Map(); // key=frameId, value=executionContextId

  async onRequest(request: CDPCommandRequest): Promise<CDPCommandRequest | null> {
    // request = parsed JSON object: {id, method, params, sessionId}
    if (!request || !request.method) return request;

    // 1. Intercept "Runtime.enable"
    if (request.method === "Runtime.enable") {
      // Mark that the session wants the runtime domain
      this.sessionsRuntimeEnabled.set(request.sessionId!, true);

      // Return a fake success response right away.
      // We'll NOT forward this to the real browser.
      const mockResponse = {
        id: request.id,
        result: {}
      };
      // Short-circuit: send mock response, skip real request.
      if (request.sessionId) {
        // Corrected: Use this.emitClientEvent
        await this.emitClientEvent(request.sessionId, { method: 'Runtime.enable', params: mockResponse });
      }
      return null; // signal to drop this request
    }

    // Let other calls pass through
    return request;
  }

  async onResponse(response: CDPCommandResponse): Promise<CDPCommandResponse | null> {
    // Typically do not manipulate responses here for this patch approach.
    return response;
  }

  async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    // event = parsed JSON object: {method, params, sessionId}
    if (!event || !event.method) return event;

    // 2. Observe new frames or workers
    if (event.method === "Page.frameAttached" ||
      event.method === "Page.frameNavigated") {
      const sessionId = event.sessionId;
      if (!sessionId || !this.sessionsRuntimeEnabled.get(sessionId)) {
        // If the user never tried to enable runtime, do nothing special.
        return event;
      }

      // Extract or generate frameId
      const frameId = (event.params as any).frame?.id || (event.params as any).frameId;
      if (!frameId) return event;

      // If we haven't created a context yet for this frame, do it now
      if (!this.frameContexts.has(frameId)) {
        const contextId = await this.createIsolatedContext(sessionId, frameId);
        // store the mapping
        this.frameContexts.set(frameId, contextId);

        // 3. Emit a synthetic Runtime.executionContextCreated event
        // so Playwright believes that a normal main-world context was created:
        const fakeContextCreated = {
          method: "Runtime.executionContextCreated",
          params: {
            context: {
              id: contextId,
              origin: "", //  RFC: Empty string
              name: "", // RFC: Empty string
              auxData: {
                frameId,
                isDefault: true
              }
            }
          },
          sessionId
        };
        // Corrected: Use this.emitClientEvent
        await this.emitClientEvent(sessionId, fakeContextCreated);
      }
    }

    // 2.b Observe new workers
    if (event.method === "Target.attachedToTarget") {
      const sessionId = event.sessionId;

      if (!sessionId || !this.sessionsRuntimeEnabled.get(sessionId)) {
        return event;
      }

      const { targetInfo } = event.params as any
      if (!targetInfo) {
        return event;
      }

      const { type, targetId: frameId } = targetInfo
      if (type !== 'worker' && type !== 'service_worker') {
          return event
      }

      if (!this.frameContexts.has(frameId)) {
          const contextId = await this.createIsolatedContext(sessionId, frameId);
          this.frameContexts.set(frameId, contextId);

          const fakeContextCreated = {
              method: "Runtime.executionContextCreated",
              params: {
                  context: {
                      id: contextId,
                      origin: "",
                      name: "",
                      auxData: {
                          frameId,
                          isDefault: false // Workers are not default contexts
                      }
                  }
              },
              sessionId
          };
          // Corrected: Use this.emitClientEvent
          await this.emitClientEvent(sessionId, fakeContextCreated);
      }
  }


    return event;
  }

  /**
   * Creates a new isolated context in the real browser by calling
   * Page.createIsolatedWorld and returns the executionContextId.
   */
  async createIsolatedContext(sessionId: string, frameId: string) {
    // Corrected: Use this.sendCDPCommand
    const result:any = await this.sendCDPCommand(
      "/devtools/page/" + frameId, //RFC: Use frameId and not targetId here
      sessionId,
      {
        method: "Page.createIsolatedWorld",
        params: {
          frameId,
          worldName: "__MITM_InvisibleWorld_" + frameId, // Consistent naming
          grantUniveralAccess: true // RFC: Set this to true
        }
      }
    );
    return result.result.executionContextId; //RFC: Access executionContextId correctly
  }

    // Remove placeholder methods, as they are provided by the interceptor
}

// RFC: Use named export
export default new RuntimeEnableMitMPlugin()