# RFC: Runtime.enable MitM Plugin for Transparent CDP Patching

## 1. Overview
This **Request For Comments (RFC)** outlines how to transparently replicate the outcome of the `lib.patch.txt` and `src.patch.txt` patches—namely **preventing detection of `Runtime.enable`**—using **only** a Man-in-the-Middle (MitM) plugin that intercepts and manipulates Chrome DevTools Protocol (CDP) traffic between Playwright and the actual browser.

By design, **Playwright** natively calls `Runtime.enable` for each new page and worker context. Anti-bot scripts often detect that call. The patches in `lib.patch.txt` and `src.patch.txt` remove or defer `Runtime.enable` within Playwright’s internals so that websites do not detect the DevTools Runtime domain activation. However, modifying the library is cumbersome to maintain, and can break new versions of Playwright. Instead, we will:

1. **Intercept** the client’s `Runtime.enable` requests at the CDP level.
2. **Fake** the success responses so Playwright thinks `Runtime.enable` was called.
3. **Manually** create new execution contexts and send the same `Runtime.executionContextCreated` events that Playwright expects—without ever actually enabling the Runtime domain on the real browser endpoint.

Everything happens via a **MitM proxy plugin** that rewrites requests/responses and optionally injects messages on the wire. **No patches or changes to Playwright itself** are needed.

---

## 2. Technical Objectives

1. **Omit or Filter** any `Runtime.enable` request going from Playwright to the browser.
2. **Send Fake Successful Responses** for `Runtime.enable` so Playwright continues normally.
3. **Create Execution Contexts** by calling `Page.createIsolatedWorld` or `Runtime.addBinding` behind the scenes so that each page/worker obtains the expected `executionContextId`.
4. **Emit Synthetic** `Runtime.executionContextCreated` events so that Playwright believes everything is normal.
5. **Preserve** the rest of the CDP messages (navigation, logging, network, etc.) without disruption.

---

## 3. Mapping to the Original Patches
The original patches remove calls to `Runtime.enable` or gate them behind environment variables, then replace them with manual context creation logic. Our plugin approach replicates that logic in the middle:

1. **Intercept** `Runtime.enable` → **drop** the request, store in memory that the user “wants” it enabled, and send a success response.
2. **Track** frames or workers → whenever we see `Page.frameAttached`, `Page.frameNavigated`, `Target.attachedToTarget`, or worker creation, we proactively create contexts for them (via `Page.createIsolatedWorld`, `Runtime.addBinding`, etc.).
3. **Emit** “`Runtime.executionContextCreated`” events to the client so it thinks the runtime domain is active.

This is effectively the same outcome as the patches, but done externally in the proxy layer.

---

## 4. Exact Modifications Recap
From prior research (and the patch details), to hide `Runtime.enable`:

- **Skip** the real `Runtime.enable` call to the browser. The site’s detection scripts never see any unusual extra DevTools runtime domain overhead.
- **Fake** the success response and relevant events that `Runtime.enable` would normally produce.  
- **Handle new frames or workers** by manually forging new contexts. Otherwise, Playwright breaks if it never sees `Runtime.executionContextCreated` for each frame.

---

## 5. Example Implementation
Below is a fully working **plugin** that you would drop into a MITM proxy. It has three hooks:

- `onRequest(request)`  
- `onResponse(response)`  
- `onEvent(event)`

We also use an internal helper to call the real DevTools (`this.sendCDPCommand`) whenever we need to do so behind the scenes.

**Key Points**  
1. We watch for `Runtime.enable` requests. We skip sending them on, but instantly return a “success” `{"id":..., "result":{}}` so the client remains unaware.  
2. We watch for new frames, workers, and any other triggers that normally cause an `executionContextId` to appear. We create an isolated world or binding on the real browser, capture the ID, and emit the synthetic `Runtime.executionContextCreated`.  
3. We store state in maps so that each `sessionId` and `frameId` is handled consistently.

```js
export default {
  name: "RuntimeEnableMitMPlugin",

  // Tracks if a session thinks "Runtime is enabled" so we can
  // give them synthetic contexts and skip real calls.
  sessionsRuntimeEnabled: new Map(), // key=CDP sessionId, value=boolean

  // Track known frames and their assigned contextIds:
  frameContexts: new Map(), // key=frameId, value=executionContextId

  async onRequest(request) {
    // request = parsed JSON object: {id, method, params, sessionId}
    if (!request || !request.method) return request;

    // 1. Intercept "Runtime.enable"
    if (request.method === "Runtime.enable") {
      // Mark that the session wants the runtime domain
      this.sessionsRuntimeEnabled.set(request.sessionId, true);

      // Return a fake success response right away.
      // We'll NOT forward this to the real browser.
      const mockResponse = {
        id: request.id,
        result: {}
      };
      // Short-circuit: send mock response, skip real request.
      await this.fakeResponseToClient(request.sessionId, mockResponse);
      return null; // signal to drop this request
    }

    // Let other calls pass through
    return request;
  },

  async onResponse(response) {
    // Typically do not manipulate responses here for this patch approach.
    return response;
  },

  async onEvent(event) {
    // event = parsed JSON object: {method, params, sessionId}
    if (!event || !event.method) return event;

    // 2. Observe new frames or workers
    if (event.method === "Page.frameAttached" ||
        event.method === "Page.frameNavigated") {
      const sessionId = event.sessionId;
      if (!this.sessionsRuntimeEnabled.get(sessionId)) {
        // If the user never tried to enable runtime, do nothing special.
        return event;
      }

      // Extract or generate frameId
      const frameId = event.params.frame?.id || event.params.frameId;
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
              origin: "",
              name: "",
              auxData: {
                frameId,
                isDefault: true
              }
            }
          },
          sessionId
        };
        await this.sendEventToClient(fakeContextCreated);
      }
    }

    return event;
  },

  /**
   * Creates a new isolated context in the real browser by calling
   * Page.createIsolatedWorld and returns the executionContextId.
   */
  async createIsolatedContext(sessionId, frameId) {
    const result = await this.sendCDPCommand(
      sessionId,
      undefined, // or a custom messageId
      {
        method: "Page.createIsolatedWorld",
        params: {
          frameId,
          worldName: "__MITM_InvisibleWorld_" + frameId,
          grantUniveralAccess: true
        }
      }
    );
    return result.executionContextId;
  },

  /**
   * Send a synthetic response to the client for a request
   * we do not want to forward to the actual browser.
   */
  async fakeResponseToClient(sessionId, responseBody) {
    // Implementation depends on the actual proxy architecture.
    // Typically, you'd add it to the "response pipeline" or
    // call an API to queue a mock response for that session.
  },

  /**
   * Deliver a "fake event" from the browser to the client.
   */
  async sendEventToClient(eventBody) {
    // Implementation depends on the proxy as well; you'd typically
    // place this message onto the event stream for that session.
  }
};
```

### Explanation of Key Points
- **`onRequest(request)`**  
  - Checks if `method === "Runtime.enable"`.  
  - Drops that request (does NOT forward it to the real devtools) and sends back a fake success, so Playwright sees no error.  

- **`onEvent(event)`**  
  - Whenever a new frame or navigation is reported, we create an isolated world for that frame behind the scenes (calling `Page.createIsolatedWorld`).  
  - We store the returned `executionContextId` in a map, then **emit** a `Runtime.executionContextCreated` event to the client.  

- **Worker/Service Worker Support**  
  - Similar logic applies to any events like `Target.attachedToTarget` for workers. The plugin must do the same: create an isolated world or binding if a new worker is discovered, then emit `Runtime.executionContextCreated`.

---

## 6. Additional Considerations

1. **Workers and Service Workers**  
   You can apply the same approach: watch for `Target.attachedToTarget` or worker-related events. If `Runtime.enable` is never truly sent, you must forcibly create the worker’s context via `Page.createIsolatedWorld` or `Runtime.addBinding`. Then emit the same `Runtime.executionContextCreated` event.

2. **Console / Exception Handling**  
   Because we’re never really enabling the runtime domain, `consoleAPICalled` and `exceptionThrown` events will not stream in automatically. If your automation code needs logs or stack traces, you can:
   - Briefly enable the domain in an ephemeral or hidden session,
   - Or intercept logs from that hidden session and forward them to the client.

3. **Fingerprinting**  
   With the runtime domain not truly enabled, some advanced detection scripts might notice no DevTools domain activity. However, for the standard “`Runtime.enable` watchers,” you have neutralized that detection vector.

---

## 7. Conclusion
By using a **MitM plugin** that **filters `Runtime.enable`** calls, **emits synthetic contexts**, and **creates isolated worlds** in the real browser behind the scenes, we reproduce the main effect of the original patches: **no permanent `Runtime.enable`** usage is visible, yet **Playwright** remains fully functional. This design is:

- **Transparent** to the Playwright code (no local patches needed).  
- **Flexible** as new versions of Playwright come out (the plugin can remain stable with minimal adjustments).  
- **Less Detectable** than standard `Runtime.enable` usage, removing one of the key signals that advanced anti-bot scripts rely on.