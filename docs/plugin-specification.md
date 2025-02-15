### **Plugin Interface Specification & Capabilities **

## **1. Lifecycle Hooks**

Each plugin must export an **object** implementing the `CDPPlugin` interface with these optional lifecycle interceptors:

```typescript
interface CDPPlugin {
  name: string;
  onRequest?(request: CDPCommandRequest): Promise<CDPCommandRequest | null>;
  onResponse?(response: CDPCommandResponse): Promise<CDPCommandResponse | null>;
  onEvent?(event: CDPEvent): Promise<CDPEvent | null>;
  sendCDPCommand?(endpoint: string, proxySessionId: string, message: CDPCommandRequest): Promise<CDPCommandResponse>;
  emitClientEvent?(proxySessionId: string, event: CDPEvent): Promise<void>;
}

// Example implementation:
export default {
  name: "MyMitmPlugin",

  async onRequest(request: CDPCommandRequest) { /*...*/ },

  async onResponse(response: CDPCommandResponse) { /*...*/ },

  async onEvent(event: CDPEvent) { /*...*/ }
} as CDPPlugin;
```

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

## **2. CDP Command Proxying**

### **2.1 The `sendCDPCommand?(endpoint, proxySessionId, message)` Method**

Your plugin can optionally implement the ability to programmatically send additional CDP commands to the browser:

```typescript
async sendCDPCommand?(
  endpoint: string,
  proxySessionId: string, 
  message: CDPCommandRequest
): Promise<CDPCommandResponse>;
```

Where:

- **`endpoint`**: A string that designates the DevTools endpoint to target. Examples:
  - `"/devtools/page/{targetId}"`  
  - `"/json/close/{targetId}"`  
  - `"/json/new?{url}"`  
- **`proxySessionId`**: A **unique** internal ID that the plugin uses to keep track of this conversation. This is **not** Chrome's actual `sessionId`.  
- **`message`**: An object describing the CDP command, e.g.:
  ```js
  {
    "id": 42,
    "method": "Runtime.evaluate",
    "params": { "expression": "console.log('Hello!')" }
  }
  ```
  If you do not provide an `"id"`, the plugin may auto-generate one.

#### **Why This Matters**
- You can **manually trigger** DevTools actions (like `Runtime.enable` in an ephemeral session) **without** the client (Playwright) being aware.
- This is crucial for implementing advanced features such as ephemeral DevTools sessions to hide or mimic certain signals.

---

## **3. Emitting (Synthetic) Events to the Client**

### **3.1 The `emitClientEvent?(proxySessionId, event)` Method**

Your plugin can optionally implement the ability to emit events back to the client:

```typescript
async emitClientEvent?(proxySessionId: string, event: CDPEvent): Promise<void>;
```

Anytime you want to **fake** or **inject** an event back to Playwright, call:

```js
this.emitClientEvent(proxySessionId, event);
```

Where:

- **`proxySessionId`**: The same local ID used to correlate events to the correct client session.
- **`event`**: A JSON object representing a **CDP response** or **CDP event**. Typically includes:
  - A `"method"` (e.g., `"Runtime.executionContextCreated"`) if it's an event.
  - An `"id"` field if it's a response to a prior request.
  - `"params"` that hold any relevant data (e.g., an object describing the new execution context).

#### **Example Usage**
```js
await this.emitClientEvent(proxySessionId, {
  method: "Runtime.executionContextCreated",
  params: {
    context: {
      id: 99,
      auxData: { isDefault: true, frameId: "12345" }
    }
  }
});
```
In doing so, the client sees this as though it came **directly from the browser**.

---

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
