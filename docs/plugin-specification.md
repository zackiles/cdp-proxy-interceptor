### **Plugin Interface Specification & Capabilities **

## **1. Plugin Structure**

Each plugin must export a class that extends `BaseCDPPlugin`.  The `BaseCDPPlugin` class provides the `sendCDPCommand` and `emitClientEvent` methods, and defines the optional lifecycle interceptor methods.

```typescript
import { BaseCDPPlugin } from '../src/base_cdp_plugin.ts';
import type { CDPCommandRequest, CDPCommandResponse, CDPEvent } from '../src/types.ts';

export default class MyPlugin extends BaseCDPPlugin {
  name = "MyPlugin";

  override async onRequest(request: CDPCommandRequest): Promise<CDPCommandRequest | null> { /*...*/ }

  override async onResponse(response: CDPCommandResponse): Promise<CDPCommandResponse | null> { /*...*/ }

  override async onEvent(event: CDPEvent): Promise<CDPEvent | null> { /*...*/ }

  async cleanup() {
    // Clean up any resources, state, or event listeners
  }
}
```

The `onRequest`, `onResponse`, `onEvent`, and `cleanup` methods must use the `override` keyword.

### **1.1 `onRequest(request)`**
- **Intercepts outgoing CDP requests** from Playwright to the browser.
- **Modifications**: 
  - The plugin can **allow** the request to continue to the browser, **modify** it, **block** it, or **respond** immediately with a fake success/failure.  
- **Return Value**:
  - Return **the original or a modified request** to let it pass to the browser.
  - Return **null** to **drop** the request (the browser never sees it).
  - Or **short-circuit** the request by returning a custom **synthetic response** to the client if your proxy architecture supports direct responses from `onRequest`.

##### **Example Usage**
```js
async onRequest(request) {
  console.log("Intercepted Request →", request);

  if (request.method === "Runtime.enable") {
    // Possibly handle detection-evasion by dropping or faking a response
    return null; // Drop it
  }

  return request; // Let other requests pass
}
```

---

### **1.2 `onResponse(response)`**
- **Intercepts CDP responses** from the browser before they reach Playwright.
- **Modifications**:
  - Inspect or edit the response payload (e.g., remove or alter fields).
  - Suppress entirely by returning null.
- **Return Value**:
  - Return **the original** or a **modified** response to forward it to the client.
  - Return **null** to discard it. The client never receives anything for that request.

##### **Example Usage**
```js
async onResponse(response) {
  console.log("Intercepted Response →", response);

  // Example: block or tamper with some domain
  if (response.result?.extraDebugInfo) {
    delete response.result.extraDebugInfo;
  }

  return response; // Forward the sanitized response
}
```

---

### **1.3 `onEvent(event)`**
- **Intercepts asynchronous CDP events** from the browser to Playwright.
- **Modifications**:
  - Change the event structure (e.g., rename, remove fields).
  - Inject brand-new or alternative events to the client.
  - Or fully suppress the event by returning null.
- **Return Value**:
  - Original or modified event → Playwright sees it.
  - **null** → The client never sees this event.

##### **Example Usage**
```js
async onEvent(event) {
  console.log("Intercepted Event →", event);

  // Suppose we want to block 'Target.attachedToTarget'
  if (event.method === "Target.attachedToTarget") {
    return null;
  }

  return event; // Forward it otherwise
}
```

---

### **1.4 `cleanup()`**
- **Called when the plugin is being unregistered** or when the proxy is shutting down.
- **Purpose**:
  - Clean up any resources, state, or event listeners the plugin has created
  - Ensure proper memory management and prevent leaks
  - Handle any necessary async cleanup operations
- **Return Value**:
  - Can return `void` for synchronous cleanup
  - Can return `Promise<void>` for asynchronous cleanup operations
  - The proxy will await any async cleanup before proceeding

##### **Example Usage**
```js
async cleanup() {
  // Clear any maps or sets
  this.sessionMap.clear();
  this.eventListeners.clear();

  // Close any open connections
  for (const connection of this.connections) {
    await connection.close();
  }

  // Clean up any timers
  clearInterval(this.cleanupInterval);
  
  console.log("Plugin cleanup completed");
}
```

---

## **2. Injected Methods**

The following methods are injected into your plugin by the `BaseCDPPlugin` class and are available as `this.methodName`:

### **2.1 `sendCDPCommand(endpoint: string, proxySessionId: string, message: CDPCommandRequest): Promise<CDPCommandResponse>`**

```typescript
this.sendCDPCommand(
  "/devtools/page/" + frameId,
  sessionId,
  {
    method: "Page.createIsolatedWorld",
    params: {
      frameId,
      worldName: "__MITM_InvisibleWorld_" + frameId,
      grantUniveralAccess: true
    }
  }
);
```

This method allows plugins to send CDP commands to the browser.  It automatically handles message ID generation, response matching, timeouts, WebSocket state validation, and error handling.

*   **`endpoint`**:  The DevTools endpoint to target (e.g., `"/devtools/page/{targetId}"`).
*   **`proxySessionId`**:  The unique internal proxy session ID.
*   **`message`**:  The CDP command request.

### **2.2 `emitClientEvent(proxySessionId: string, event: CDPEvent): Promise<void>`**

This method allows plugins to emit CDP events to the client. This allows plugins to send custom events, simulate browser events, and provide plugin-specific notifications. Note that this method is specifically for events only, not responses.

```typescript
// Example: Send a custom event when a specific CDP event occurs
await this.emitClientEvent(sessionId, {
  method: "Custom.pageLoadComplete",
  params: {
    timestamp: Date.now(),
    metrics: await this.getPageMetrics(sessionId)
  }
});
```

## **3. Return Types**

All plugin methods (`onRequest`, `onResponse`, `onEvent`) return a Promise that resolves to either:
- The same type as the input (possibly modified)
- `null` to drop/block the message

For example:
```typescript
// Each method returns Promise<T | null> where T is the input type
async onRequest(request: CDPCommandRequest): Promise<CDPCommandRequest | null>
async onResponse(response: CDPCommandResponse): Promise<CDPCommandResponse | null>
async onEvent(event: CDPEvent): Promise<CDPEvent | null>
```

This means your plugin methods can:
1. Return a Promise that resolves to the message (modified or unmodified)
2. Return a Promise that resolves to null to block/drop the message

## **4. Message Format**

All requests, responses, and events follow **raw Chrome DevTools Protocol (CDP) JSON**.  
Notably, in this specification:
- **`sessionId`** shown in examples is not the **actual** CDP session ID, but rather a **proxy** identifier mapping.  

### **4.1 Example CDP Request**
```json
{
  "id": 38,
  "method": "Runtime.enable",
  "params": {},
  "sessionId": "AB3AC73A42915BAE2766B1EF2F1957DD"
}
```
*(`sessionId` is unique from the proxy's perspective, not the real devtools sessionId.)*

### **4.2 Example CDP Response**
```json
{
  "id": 38,
  "result": { "executionContextId": 2 },
  "sessionId": "AB3AC73A42915BAE2766B1EF2F1957DD"
}
```

### **4.3 Example CDP Event**
```json
{
  "method": "Page.frameNavigated",
  "params": {
    "frame": {
      "id": "493EF6368F31C307371D8E2CD26F7084",
      "url": "about:blank"
    }
  },
  "sessionId": "AB3AC73A42915BAE2766B1EF2F1957DD"
}
```

---

## **5. Typical Plugin Responsibilities & Use Cases**

**A. Security & Detection Evasion**  
- Filter or **block** calls that reveal automation (e.g., `Runtime.enable`).
- Insert **synthetic** responses that fool the client into thinking everything is normal.

**B. Automation Enhancements**  
- Inject or manipulate frames, service workers, or ephemeral devtools sessions, effectively **extending** Playwright's capability **without** modifying its source.

**C. Debugging & Monitoring**  
- Log or trace all CDP activity, e.g., saving every request and event to a database for debugging or replay.

**D. Feature Modification**  
- Override or modify certain calls to change how Playwright interacts with the browser (e.g., swapping user agent dynamically, stubbing out certain commands, or merging data from ephemeral sessions into the main session).

### **Helper Methods**
The `sendCDPCommand` and `emitClientEvent` methods are automatically injected into your plugin by the `BaseCDPPlugin` class. See section 2 for details.
