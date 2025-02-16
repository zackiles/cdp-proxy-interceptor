# **RFC: Chrome DevTools Protocol (CDP) Proxy Server**

## **1. Overview**
This document proposes a comprehensive design for a **WebSocket-based proxy** that intercepts and manipulates Chrome DevTools Protocol (CDP) traffic from **Playwright** to **Chromium**, enhanced with automated Chrome management, advanced debugging capabilities, **and a plugin system** enabling dynamic interception and modification of CDP messages.

**High-Level Objectives**  
- **CDP Transparent Proxy** acting as a WebSocket endpoint to MITM all traffic  
- **Intercept and Modify** specific CDP commands/responses with custom middleware and plugins  
- **Self Updating** server automatically pulls in the latest CDP schemas  
- **Advanced Debugging** support with time-travel debugging and advanced logging  
- **Fully Compliant Protocol** for any CDP client such as Playwright or Puppeteer  
- **Structured Plugin System** supporting dynamic hooking of CDP messages and event subscription  

**Key Design Principles**
- **Transparency**: Messages are forwarded without modification unless explicitly configured
- **Safety**: Resource limits and cleanup prevent memory leaks and overuse
- **Extensibility**: Plugin system for custom message handling
- **Reliability**: Robust reconnection and state management
- **Monitoring**: Built-in metrics and diagnostics

---

## **2. Core Components**

### **2.1 Schema Validator**

**CRITICAL NOTE ON VALIDATION**: The CDP proxy's primary goal is transparent message passing. Schema validation should be:
- **Optional**: Disabled by default
- **Non-blocking**: Never prevent message delivery due to schema issues
- **Diagnostic Only**: Used for debugging and monitoring, not enforcement
- **Zero Modification**: Never modify messages based on schema validation

The validator exists purely as a development and debugging tool. In production:
1. Let Chrome and clients handle their own validation
2. Log validation issues without blocking or modifying messages
3. Focus on reliable message delivery rather than correctness

```typescript
import { Ajv, ErrorObject } from "npm:ajv@8.12.0"; // Import Ajv and ErrorObject

export class SchemaValidator {
  private enabled: boolean = false; // Disabled by default
  private ajv: Ajv;
  private validate: { [key: string]: (data: any) => boolean } = {}; // Store compiled validators

  constructor() {
      this.ajv = new Ajv({ allErrors: true }); // Initialize Ajv with allErrors option
  }

  async initialize() {
    try {
      const [browserProto, jsProto] = await Promise.all([
        fetch(
          "https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json",
        ).then((res) => res.json()),
        fetch(
          "https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json",
        ).then((res) => res.json()),
      ]);

      // Merge schemas and compile validators
      this.compileValidators([...browserProto.domains, ...jsProto.domains]);
    } catch (error) {
      console.error("Failed to initialize SchemaValidator:", error);
      // Don't throw here; allow the proxy to run even without validation
    }
  }

    private compileValidators(domains: any[]) {
        for (const domain of domains) {
            const domainName = domain.domain;

            // Compile command validators
            if (domain.commands) {
                for (const command of domain.commands) {
                    const schema = {
                        type: "object",
                        properties: {
                            id: { type: "integer" },
                            method: { type: "string", const: `${domainName}.${command.name}` },
                            params: command.parameters ? this.convertParametersToSchema(command.parameters) : { type: "object" },
                        },
                        required: ["id", "method", "params"],
                        additionalProperties: false
                    };
                    this.validate[`${domainName}.${command.name}`] = this.ajv.compile(schema);
                }
            }

            // Compile event validators
            if (domain.events) {
                for (const event of domain.events) {
                    const schema = {
                        type: "object",
                        properties: {
                            method: { type: "string", const: `${domainName}.${event.name}` },
                            params: event.parameters ? this.convertParametersToSchema(event.parameters) : { type: "object" },
                        },
                        required: ["method", "params"],
                        additionalProperties: false
                    };
                    this.validate[`${domainName}.${event.name}`] = this.ajv.compile(schema);
                }
            }
        }
    }

    private convertParametersToSchema(parameters: any[]): any {
        const properties: { [key: string]: any } = {};
        for (const param of parameters) {
            properties[param.name] = this.convertTypeToSchema(param);
        }
        return { type: "object", properties, additionalProperties: false };
    }


    private convertTypeToSchema(param: any): any {
        let schema: any = {};

        switch (param.type) {
            case "string":
                schema.type = "string";
                break;
            case "integer":
                schema.type = "integer";
                break;
            case "number":
                schema.type = "number";
                break;
            case "boolean":
                schema.type = "boolean";
                break;
            case "array":
                schema.type = "array";
                schema.items = this.convertTypeToSchema(param.items);
                break;
            case "object":
                if (param.properties) {
                    schema.type = "object";
                    schema.properties = {};
                    for (const prop of param.properties) {
                        schema.properties[prop.name] = this.convertTypeToSchema(prop);
                    }
                } else {
                    schema.type = "object"; // Allow arbitrary objects if no properties specified
                }
                break;
            default:
                if (param.$ref) {
                    // Handle references (simplified for PoC)
                    schema.$ref = param.$ref;
                } else {
                    console.warn(`Unknown parameter type: ${param.type}`);
                    schema.type = "any"; // Allow any type as fallback
                }
        }
        if (param.enum) {
            schema.enum = param.enum;
        }
        return schema;
    }

  validateCDPRequest(msg: any): boolean {
    if (!this.enabled) return true; // Skip validation when disabled

    const validator = this.validate[msg.method];
      if (validator) {
          const valid = validator(msg);
          if (!valid) {
              console.warn('[SchemaValidator] Invalid CDP request:', validator.errors);
          }
          return true; // Always return true in the PoC
      }
    return true; // Always allow message through
  }

    validateCDPResponse(msg: any): boolean {
        if (!this.enabled) return true; // Skip validation when disabled

        // For responses, we need to find a validator based on the request ID.
        // This is complex and not necessary for the PoC.  We'll just log.
        if (msg.method) {
            const validator = this.validate[msg.method];
            if (validator) {
                const valid = validator(msg);
                if (!valid) {
                    console.warn('[SchemaValidator] Invalid CDP event:', validator.errors);
                }
                return true; // Always return true in the PoC
            }
        } else if (msg.id) {
            // We don't have a request ID -> validator mapping, so we can't validate.
            console.warn("[SchemaValidator] Cannot validate response without corresponding request validator.");
        }

        return true; // Always allow the message through
    }

    getErrors(): ErrorObject[] | null | undefined {
        return this.ajv.errors;
    }
}
```

One critical aspect is validating incoming/outgoing CDP messages against the official JSON schemas. **However**, the old approach incorrectly assumed that `browser_protocol.json` alone contained the full definitions for requests and responses. Instead, **Chrome DevTools Protocol** schemas are split across **`browser_protocol.json`** and **`js_protocol.json`**, with commands/events listed under a `domains` array. The validator must merge both schemas and dynamically generate validators for each command.

```typescript
// chrome_manager.ts
import { launch } from "npm:chrome-launcher";

export class ChromeManager {
  private chrome: any;
  private wsUrl: string = '';
  private port?: number;
  private connections: Set<WebSocket> = new Set();

  async start(retries = 3, baseDelay = 100): Promise<string> {
    for (let i = 0; i < retries; i++) {
      try {
        this.port = await this.findAvailablePort();
        this.chrome = await launch({
          chromeFlags: [
            `--remote-debugging-port=${this.port}`,
            "--headless",
            "--disable-gpu",
            "--no-sandbox"
          ]
        });

        // Verify debugger endpoint is actually ready
        await this.waitForDebuggerEndpoint(this.port, baseDelay * Math.pow(2, i));
        this.wsUrl = await this.getWebSocketUrl();
        
        console.log(`Chrome started on port ${this.port}`);
        return this.wsUrl;
      } catch (e) {
        if (i === retries - 1) throw e;
        // Exponential backoff between attempts
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
      }
    }
    throw new Error("Failed to start Chrome after retries");
  }

  private async findAvailablePort(): Promise<number> {
    const getPort = async (start: number, end: number): Promise<number> => {
      for (let port = start; port <= end; port++) {
        try {
          const server = Deno.listen({ port });
          server.close();
          return port;
        } catch {
          continue;
        }
      }
      throw new Error('No available ports');
    };
    return getPort(9222, 9230);
  }

  private async waitForDebuggerEndpoint(port: number, timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const response = await fetch(`http://localhost:${port}/json/version`);
        if (response.ok) return;
      } catch {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error(`Debugger endpoint not ready after ${timeout}ms`);
  }

  async getWebSocketUrl(): Promise<string> {
    if (!this.port) throw new Error("Chrome not started");
    
    // FIX: Create page target if none exists
    const versionResp = await fetch(`http://localhost:${this.port}/json/version`);
    const { webSocketDebuggerUrl } = await versionResp.json();
    const listResp = await fetch(`http://localhost:${this.port}/json/list`);
    let targets = await listResp.json();

    if (!targets.some((t: any) => t.type === 'page')) {
      const createTargetResp = await fetch(`http://localhost:${this.port}/json/new?about:blank`);
      if (!createTargetResp.ok) {
        throw new Error("Failed to create new page target");
      }
      targets = await (await fetch(`http://localhost:${this.port}/json/list`)).json();
    }

    const target = targets.find((t: any) => t.type === 'page');
    return target.webSocketDebuggerUrl || webSocketDebuggerUrl;
  }

  registerConnection(ws: WebSocket) {
    this.connections.add(ws);
  }

  unregisterConnection(ws: WebSocket) {
    this.connections.delete(ws);
  }

  async restart() {
    // Track existing connections
    const existingConnections = Array.from(this.connections);
    
    await this.stop();
    await this.start();
    
    // Reconnect existing sessions
    await Promise.all(existingConnections.map(conn => 
      this.reconnectWebSocket(conn)
    ));
  }

  private async reconnectWebSocket(ws: WebSocket) {
    try {
      const newWs = new WebSocket(this.wsUrl);
      // Wait for socket to open
      await new Promise(resolve => newWs.onopen = resolve)

      // Copy over any necessary state/handlers
      newWs.onmessage = ws.onmessage;
      newWs.onerror = ws.onerror;
      newWs.onclose = ws.onclose;
      this.connections.add(newWs);
    } catch (error) {
      console.error("Failed to reconnect WebSocket:", error);
    }
  }

  async stop() {
    // Close all active connections
    for (const ws of this.connections) {
      try {
        ws.close();
      } catch (e) {
        console.error("Error closing WebSocket:", e);
      }
    }
    this.connections.clear();

    if (this.chrome) {
      await this.chrome.kill();
      this.chrome = null;
      this.port = undefined;
      this.wsUrl = '';
      console.log("Chrome instance terminated");
    }
  }
}
```
---

### **2.2 Chrome Lifecycle Manager**

We continue to handle launching and shutting down Chrome. This remains mostly unchanged, but be mindful that if we re-launch Chrome for schema updates or other reasons, we must ensure sessions are reconnected properly.

```typescript
// partial_message_buffer.ts
export class PartialMessageBuffer {
  private buffers = new Map<string, string>();
  private readonly CLEANUP_INTERVAL = 30000; // 30 seconds
  private cleanup?: number;
  private timestamps = new Map<string, number>();
  private memoryUsageWarningThreshold = 50 * 1024 * 1024; // 50MB warning threshold

  constructor() {
    this.startCleanupInterval();
  }

  /**
   * Starts the automatic cleanup interval that removes stale message fragments
   * and monitors memory usage
   */
  private startCleanupInterval() {
    this.cleanup = setInterval(() => {
      this.cleanupOldBuffers();
      const memoryUsage = this.getBufferMemoryUsage();
      
      // Log buffer metrics for monitoring
      console.log(`Buffer metrics - Count: ${this.buffers.size}, Memory: ${memoryUsage} bytes`);
      
      // Warn if memory usage is high
      if (memoryUsage > this.memoryUsageWarningThreshold) {
        console.warn(`[PartialMessageBuffer] High memory usage: ${memoryUsage} bytes`);
      }
    }, this.CLEANUP_INTERVAL);
  }

  /**
   * Handles an incoming message fragment, attempting to reconstruct the complete message
   * @param raw The raw message fragment
   * @param sessionId The session ID this fragment belongs to
   * @returns The complete parsed message if successful, null if still incomplete
   */
  handleMessageFragment(raw: string, sessionId: string): any {
    const prevData = this.buffers.get(sessionId) || '';
    const combined = prevData + raw;
    
    try {
      const msg = JSON.parse(combined);
      // Successfully parsed - clear buffer and timestamp
      this.buffers.delete(sessionId);
      this.timestamps.delete(sessionId);
      return msg;
    } catch {
      // Still incomplete - store with timestamp
      this.buffers.set(sessionId, combined);
      this.timestamps.set(sessionId, Date.now());
      return null;
    }
  }

  /**
   * Removes message fragments that are older than the cleanup interval
   * to prevent memory leaks
   */
  private cleanupOldBuffers() {
    const now = Date.now();
    let freedBytes = 0;
    
    for (const [sessionId, timestamp] of this.timestamps.entries()) {
      if (now - timestamp > this.CLEANUP_INTERVAL) {
        const buffer = this.buffers.get(sessionId);
        if (buffer) {
          freedBytes += buffer.length * 2; // Rough estimate for string memory
        }
        this.buffers.delete(sessionId);
        this.timestamps.delete(sessionId);
      }
    }
    
    if (freedBytes > 0) {
      console.log(`[PartialMessageBuffer] Cleaned up ~${freedBytes} bytes of stale message fragments`);
    }
  }

  /**
   * Calculates the approximate memory usage of all stored buffers
   */
  private getBufferMemoryUsage(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) {
      total += buffer.length * 2; // Rough estimate for string memory
    }
    return total;
  }

  /**
   * Cleans up resources when the buffer is no longer needed
   */
  dispose() {
    if (this.cleanup) {
      clearInterval(this.cleanup);
      this.cleanup = undefined;
    }
    this.buffers.clear();
    this.timestamps.clear();
  }
}
```

---

### **2.3 Message Buffering**

**CRITICAL NOTE ON MESSAGE BUFFERING**: The proxy should only handle message assembly, not content:
- **Assembly Only**: Buffer only for incomplete WebSocket frames
- **No Message Queuing**: Don't queue complete messages (let WebSocket handle backpressure)
- **No Message Batching**: Don't combine or split messages
- **Minimal State**: Keep only the minimum state needed for frame assembly

```typescript
export class PartialMessageBuffer {
  private buffers = new Map<string, string>();
  private readonly CLEANUP_INTERVAL = 30000; // 30 seconds
  private cleanup?: number;
  private timestamps = new Map<string, number>();
  private memoryUsageWarningThreshold = 50 * 1024 * 1024; // 50MB warning threshold

  constructor() {
    this.startCleanupInterval();
  }

  private startCleanupInterval() {
    this.cleanup = setInterval(() => {
      this.cleanupOldBuffers();
      const memoryUsage = this.getBufferMemoryUsage();
      
      console.log(`Buffer metrics - Count: ${this.buffers.size}, Memory: ${memoryUsage} bytes`);
      
      if (memoryUsage > this.memoryUsageWarningThreshold) {
        console.warn(`[PartialMessageBuffer] High memory usage: ${memoryUsage} bytes`);
      }
    }, this.CLEANUP_INTERVAL);
  }

  handleMessageFragment(raw: string, sessionId: string): any {
    const prevData = this.buffers.get(sessionId) || '';
    const combined = prevData + raw;
    
    try {
      const msg = JSON.parse(combined);
      this.buffers.delete(sessionId);
      this.timestamps.delete(sessionId);
      return msg;
    } catch {
      this.buffers.set(sessionId, combined);
      this.timestamps.set(sessionId, Date.now());
      return null;
    }
  }

  private cleanupOldBuffers() {
    const now = Date.now();
    let freedBytes = 0;
    
    for (const [sessionId, timestamp] of this.timestamps.entries()) {
      if (now - timestamp > this.CLEANUP_INTERVAL) {
        const buffer = this.buffers.get(sessionId);
        if (buffer) {
          freedBytes += buffer.length * 2;
        }
        this.buffers.delete(sessionId);
        this.timestamps.delete(sessionId);
      }
    }
    
    if (freedBytes > 0) {
      console.log(`[PartialMessageBuffer] Cleaned up ~${freedBytes} bytes of stale message fragments`);
    }
  }

  private getBufferMemoryUsage(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) {
      total += buffer.length * 2;
    }
    return total;
  }

  dispose() {
    if (this.cleanup) {
      clearInterval(this.cleanup);
      this.cleanup = undefined;
    }
    this.buffers.clear();
    this.timestamps.clear();
  }
}
```

The buffer's sole responsibility is WebSocket frame assembly:
1. No message content validation
2. No message transformation
3. No queuing of complete messages
4. No batching or combining of messages
5. Minimal state maintenance

This ensures the proxy remains transparent and lets the WebSocket protocol handle its own flow control.

---

### **2.4 WebSocket Message Handling**

**CRITICAL NOTE ON WEBSOCKET HANDLING**: The proxy should maintain WebSocket protocol transparency:
- **Raw Message Passing**: Forward WebSocket messages without modification
- **Native Backpressure**: Use WebSocket's built-in flow control
- **Frame Boundaries**: Preserve original WebSocket frame boundaries
- **Error Transparency**: Forward WebSocket errors to appropriate endpoints

```typescript
export class WebSocketManager {
  async handleMessage(ws: WebSocket, message: WebSocket.Data) {
    // Forward raw message without processing
    if (ws.readyState === WebSocket.OPEN) {
      return new Promise((resolve, reject) => {
        ws.send(message, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    // Let caller handle unavailable socket
    throw new Error('WebSocket not open');
  }

  // Only reconnect on actual disconnection
  private handleDisconnect(ws: WebSocket) {
    if (ws.readyState === WebSocket.CLOSED) {
      this.attemptReconnection();
    }
  }
}
```

The WebSocket manager's responsibilities:
1. Raw message forwarding
2. Connection state tracking
3. Basic reconnection handling
4. Error propagation

This ensures:
- No interference with WebSocket protocol
- Native flow control is preserved
- Message ordering is maintained
- Proper error handling at protocol level

---

### **2.5 Session Management**

**CRITICAL NOTE ON SESSION MANAGEMENT**: The proxy should maintain session transparency:
- **Minimal State**: Store only essential session mapping data
- **No Session Logic**: Don't implement CDP session logic
- **Pass-through**: Forward session-related messages unmodified
- **Clean Cleanup**: Remove session data when connections close

```typescript
export class SessionManager {
  // Only store essential mapping data
  private readonly sessions = new Map<string, SessionState>();
  private readonly idMapper = new Map<string, string>();
  
  createSession(externalId?: string): string {
    const internalId = generateUUID();
    if (externalId) {
      this.idMapper.set(externalId, internalId);
    }
    return internalId;
  }

  // Simple mapping lookups
  getSession(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  // Clean removal of all session data
  removeSession(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.delete(id);
      // Clean up any ID mappings
      for (const [extId, intId] of this.idMapper.entries()) {
        if (intId === id) {
          this.idMapper.delete(extId);
        }
      }
    }
  }
}
```

The session manager's responsibilities:
1. Session ID mapping
2. Basic session state storage
3. Clean session removal
4. No CDP protocol logic

This ensures:
- Minimal interference with CDP sessions
- Clean resource management
- Protocol transparency
- No session logic assumptions

---

### **2.6 Validation and Transformation**

**CRITICAL NOTE ON MESSAGE HANDLING**: The proxy should maintain protocol transparency:
- **Optional Validation**: Schema validation must be opt-in and non-blocking
- **No Automatic Transforms**: Message transformations must be explicitly configured
- **Preserve Raw Data**: Store and forward original message data
- **Plugin Architecture**: Use plugins for any required transformations

```typescript
export class MessageValidator {
  // Validation is diagnostic only
  validateMessage(message: any): ValidationResult {
    if (!this.isValidationEnabled) {
      return { valid: true };
    }
    
    const result = this.schema.validate(message);
    if (!result.valid) {
      // Log but don't block
      console.warn('Schema validation failed:', result.errors);
    }
    return result;
  }
}

export class MessageTransformer {
  // Transformations are opt-in only
  transformMessage(message: any): any {
    if (!this.transformationsEnabled) {
      return message;
    }
    
    // Apply configured transformations
    for (const transform of this.enabledTransforms) {
      message = transform(message);
    }
    return message;
  }
}
```

Key principles for message handling:
1. **Validation**
   - Schema validation is optional
   - Validation failures don't block messages
   - Validation is for development/debugging only

2. **Transformation**
   - No automatic transformations
   - All transformations must be explicitly enabled
   - Original message data is preserved
   - Transformations are plugin-based

3. **Plugin System**
   - Plugins must be explicitly enabled
   - Plugins can't block message flow
   - Plugin errors are logged but don't block
   - Plugins have access to original message data

This ensures the proxy remains as transparent as possible while still providing optional validation and transformation capabilities when explicitly needed.

---

## **3. WebSocket and Session Management**

A robust WebSocket session layer is essential to handle **reconnections**, **message buffering**, **partial message assembly**, and **consistent session IDs**. We also support a new **ProxySessionManager** for session ID remapping, ensuring external IDs remain stable for clients even if we need to reconnect or re-map sessions internally.

---

### **3.1 WebSocket Manager**

This module tracks reconnection attempts and replays any buffered or pending messages once a **Chrome** WebSocket is restored.

```ts
export class WebSocketManager {
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY = 1000; // Base delay in ms
  private retryCount: Map<string, number> = new Map();
  private readonly eventHandlers: Map<string, WebSocketEventHandlers> = new Map();

  constructor(private sessionManager: SessionManager) {}

  /**
   * Handles WebSocket failures by attempting reconnection with exponential backoff
   * @param session The CDP session that experienced a failure
   * @param source Whether the failure was from the 'chrome' or 'client' socket
   * @returns true if reconnection was successful, false otherwise
   */
  async handleWebSocketFailure(session: CDPSession, source: 'chrome' | 'client'): Promise<boolean> {
    // Client failures should just close the session
    if (source === 'client') {
      await this.sessionManager.closeSession(session);
      return false;
    }

    const currentRetries = this.retryCount.get(session.id) || 0;
    if (currentRetries >= this.MAX_RETRIES) {
      console.error(`[WebSocketManager] Max retries (${this.MAX_RETRIES}) reached for session ${session.id}`);
      await this.sessionManager.closeSession(session);
      return false;
    }

    try {
      // Calculate delay with exponential backoff
      const delay = this.RETRY_DELAY * Math.pow(2, currentRetries);
      console.log(`[WebSocketManager] Attempting reconnection for session ${session.id} (attempt ${currentRetries + 1}/${this.MAX_RETRIES})`);
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Get new Chrome WebSocket
      const newChromeWs = await this.sessionManager.connectToChromium();
      
      // Replace the socket.  Crucially, *don't* try to copy event handlers.
      session.chromeSocket = newChromeWs;
      this.setupChromeSocketHandlers(session); // Re-establish handlers
      
      // Increment retry count
      this.retryCount.set(session.id, currentRetries + 1);
      
      console.log(`[WebSocketManager] Successfully reconnected session ${session.id}`);
      return true;
    } catch (error) {
      console.error(`[WebSocketManager] Reconnection failed for session ${session.id}:`, error);
      
      // Try again if we haven't hit max retries
      if (currentRetries < this.MAX_RETRIES - 1) {
        return this.handleWebSocketFailure(session, source);
      }
      
      // Max retries reached, close session
      await this.sessionManager.closeSession(session);
      return false;
    }
  }

  /**
   * Stores event handlers for a WebSocket
   */
  storeEventHandlers(ws: WebSocket, handlers: WebSocketEventHandlers) {
    this.eventHandlers.set(this.getWebSocketKey(ws), handlers);
  }

  /**
   * Retrieves stored event handlers for a WebSocket
   */
  private getEventHandlers(ws: WebSocket): WebSocketEventHandlers {
    return this.eventHandlers.get(this.getWebSocketKey(ws)) || {
      onmessage: null,
      onerror: null,
      onclose: null
    };
  }

  /**
   * Reattaches stored event handlers to a new WebSocket
   */
  private reattachEventHandlers(ws: WebSocket, handlers: WebSocketEventHandlers) {
    if (handlers.onmessage) ws.onmessage = handlers.onmessage;
    if (handlers.onerror) ws.onerror = handlers.onerror;
    if (handlers.onclose) ws.onclose = handlers.onclose;
  }

  /**
   * Replays any pending messages and state after reconnection
   */
  private async replaySessionState(session: CDPSession) {
    const state = await this.sessionManager.getSessionState(session.id);
    if (!state?.pendingMessages.length) return;

    console.log(`[WebSocketManager] Replaying ${state.pendingMessages.length} pending messages for session ${session.id}`);
    
    for (const msg of state.pendingMessages) {
      try {
        await session.chromeSocket.send(JSON.stringify(msg));
      } catch (error) {
        console.error(`[WebSocketManager] Failed to replay message:`, error);
      }
    }
  }

  /**
   * Generates a unique key for a WebSocket instance
   */
  private getWebSocketKey(ws: WebSocket): string {
    return (ws as any)._wsKey || ((ws as any)._wsKey = crypto.randomUUID());
  }

  /**
   * Resets the retry count for a session
   */
  resetRetryCount(sessionId: string) {
    this.retryCount.delete(sessionId);
  }

  /**
   * Cleans up stored handlers when a session is closed
   */
  cleanupSession(session: CDPSession) {
    this.eventHandlers.delete(this.getWebSocketKey(session.chromeSocket));
    this.eventHandlers.delete(this.getWebSocketKey(session.clientSocket));
    this.retryCount.delete(session.id);
  }

  // Add this helper method to re-establish handlers:
  private setupChromeSocketHandlers(session: CDPSession) {
    session.chromeSocket.onerror = async (error) => {
      console.error(`Chrome WebSocket error for session ${session.id}:`, error);
      await this.handleWebSocketFailure(session, 'chrome');
    };

    session.chromeSocket.onclose = () => {
      this.handleSocketClose(session, 'chrome');
    };

    session.chromeSocket.onmessage = async (event) => {
      const state = this.sessionManager.getSessionState(session.id);
      if (state) {
        state.lastActivity = Date.now();
      }
      // ... (rest of your onmessage logic from EnhancedCDPProxy) ...
      try {
        const msg = this.sessionManager.messageBuffer.handleMessageFragment(event.data, session.id); // Access messageBuffer through sessionManager
        if (!msg) return; // Incomplete message

        let processed = this.sessionManager.playwrightCompat.transformForPlaywright(msg);
        processed = this.sessionManager.pluginManager.processMessage(processed, session, "out");

        if (processed) {
          if (!this.sessionManager.validator.validateCDPResponse(processed)) {
            console.warn("[SchemaValidator] Invalid CDP response (but forwarding anyway):", this.sessionManager.validator.getErrors());
          }
          session.clientSocket.send(JSON.stringify(processed));
        }
      } catch (error) {
        console.error("Error processing Chrome message:", error);
      }
    };
  }
}

interface WebSocketEventHandlers {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
}
```

---

### **3.2 Session Manager**

The classic **SessionManager** maintains a map of active sessions, each with a client WebSocket and a corresponding Chrome WebSocket. It also stores session states (e.g. `pendingMessages`, `attachedTargets`) for replay during reconnections or after hot reloads.  

**Note** that in the final proxy implementation, we may replace direct usage of `SessionManager` with the new `ProxySessionManager` if we want external session IDs to remain stable. The code below still demonstrates general session logic:

```typescript
// session_manager.ts
interface SessionState {
  id: string;
  externalId: string;
  pendingMessages: any[];
  attachedTargets: Set<string>;
  lastActivity: number;
  maxPendingMessages?: number; // New: Configurable limit for pending messages
  reconnectionInProgress?: boolean; // Track ongoing reconnection attempts
  lastReconnectTime?: number; // Track last reconnection time
}

export class SessionManager {
  private sessions: Map<string, CDPSession> = new Map();
  private sessionStates: Map<string, SessionState> = new Map();
  private wsManager: WebSocketManager;
  private idMapper: Map<string, string> = new Map(); // external -> internal
  private reverseIdMapper: Map<string, string> = new Map(); // internal -> external
  private readonly DEFAULT_MAX_PENDING_MESSAGES = 1000;
  private readonly SESSION_TIMEOUT = 3600000; // 1 hour
  private readonly MIN_RECONNECT_INTERVAL = 5000; // Minimum 5s between reconnects

  constructor(
    private chromeManager: ChromeManager,
    private options: {
      maxPendingMessages?: number;
      sessionTimeout?: number;
      minReconnectInterval?: number;
    } = {}
  ) {
    this.wsManager = new WebSocketManager(this);
    this.startCleanupInterval();
  }

  private startCleanupInterval() {
    const interval = this.options.sessionTimeout || this.SESSION_TIMEOUT;
    setInterval(() => this.cleanupInactiveSessions(), interval);
  }

  /**
   * Creates a new CDP session with both internal and external IDs
   * @param clientWs The client WebSocket connection
   * @param externalId Optional external ID to use (generates one if not provided)
   * @returns The created CDP session
   */
  async createSession(clientWs: WebSocket, externalId?: string): Promise<CDPSession> {
    const chromeWs = await this.connectToChromium();
    const internalId = this.generateSessionId();
    const actualExternalId = externalId || this.generateSessionId();

    // Set up ID mapping
    this.idMapper.set(actualExternalId, internalId);
    this.reverseIdMapper.set(internalId, actualExternalId);

    const session: CDPSession = {
      id: internalId,
      clientSocket: clientWs,
      chromeSocket: chromeWs,
      active: true
    };

    // Store session and state
    this.sessions.set(internalId, session);
    this.sessionStates.set(internalId, {
      id: internalId,
      externalId: actualExternalId,
      pendingMessages: [],
      attachedTargets: new Set(),
      lastActivity: Date.now()
    });

    // Set up event handlers and store them
    this.setupSessionHandlers(session);
    this.wsManager.storeEventHandlers(clientWs, {
      onmessage: clientWs.onmessage,
      onerror: clientWs.onerror,
      onclose: clientWs.onclose
    });
    this.wsManager.storeEventHandlers(chromeWs, {
      onmessage: chromeWs.onmessage,
      onerror: chromeWs.onerror,
      onclose: chromeWs.onclose
    });

    return session;
  }

  /**
   * Gets a session by its external ID
   */
  getSessionByExternalId(externalId: string): CDPSession | undefined {
    const internalId = this.idMapper.get(externalId);
    return internalId ? this.sessions.get(internalId) : undefined;
  }

  /**
   * Gets a session's external ID
   */
  getExternalId(session: CDPSession): string | undefined {
    return this.reverseIdMapper.get(session.id);
  }

  /**
   * Connects to Chrome's debugging endpoint
   */
  public async connectToChromium(): Promise<WebSocket> {
    const wsUrl = await this.chromeManager.getWebSocketUrl();
    return new WebSocket(wsUrl);
  }

  /**
   * Gets the state of a session by its internal ID
   */
  public getSessionState(internalId: string): SessionState | undefined {
    const state = this.sessionStates.get(internalId);

    if (!state) {
      console.warn(`No session state found for session: ${internalId}. Returning default state.`);
      const externalId = this.reverseIdMapper.get(internalId);
      
      if (!externalId) {
        console.error(`No external ID mapping found for internal ID: ${internalId}`);
        return undefined;
      }

      return {
        id: internalId,
        externalId,
        pendingMessages: [],
        attachedTargets: new Set(),
        lastActivity: Date.now()
      };
    }

    return state;
  }

  /**
   * Gets all active sessions
   */
  public getActiveSessions(): CDPSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Generates a new session ID
   */
  private generateSessionId(): string {
    return crypto.randomUUID();
  }

  /**
   * Sets up WebSocket event handlers for a session
   */
  private setupSessionHandlers(session: CDPSession) {
    // Use the helper method from WebSocketManager:
    this.wsManager.setupChromeSocketHandlers(session);

    session.clientSocket.onerror = async (error) => {
      console.error(`Client WebSocket error for session ${session.id}:`, error);
      await this.closeSession(session);
    };

    session.chromeSocket.onclose = () => {
      this.handleSocketClose(session, 'chrome');
    };

    session.clientSocket.onmessage = async (event) => {
      const state = this.sessionStates.get(session.id);
      if (state) {
        state.lastActivity = Date.now();
      }
      // ... rest of onmessage logic from EnhancedCDPProxy ...
      try {
        const msg = this.messageBuffer.handleMessageFragment(event.data, session.id);
        if (!msg) return; // Incomplete message

        const processed = this.pluginManager.processMessage(msg, session, "in");
        if (processed) {
          if (!this.validator.validateCDPRequest(processed)) {
            console.warn("[SchemaValidator] Invalid CDP request (but forwarding anyway):", this.validator.getErrors());
          }
          session.chromeSocket.send(JSON.stringify(processed));
        }
      } catch (error) {
        console.error("Error processing client message:", error);
      }
    };
  }

  /**
   * Handles WebSocket close events
   */
  private async handleSocketClose(session: CDPSession, source: 'chrome' | 'client') {
    if (source === 'client') {
      await this.closeSession(session);
    } else {
      await this.wsManager.handleWebSocketFailure(session, source);
    }
  }

  /**
   * Closes a session and cleans up resources
   */
  async closeSession(session: CDPSession) {
    if (!session.active) return;
    
    session.active = false;
    const externalId = this.reverseIdMapper.get(session.id);

    // Clean up all mappings and state
    this.sessions.delete(session.id);
    this.sessionStates.delete(session.id);
    if (externalId) {
      this.idMapper.delete(externalId);
      this.reverseIdMapper.delete(session.id);
    }

    // Clean up WebSocket manager state
    this.wsManager.cleanupSession(session);

    // Close sockets
    try { session.chromeSocket.close(); } catch {}
    try { session.clientSocket.close(); } catch {}
  }

  /**
   * Updates the state of a session
   */
  updateSessionState(session: CDPSession, updates: Partial<SessionState>) {
    const state = this.sessionStates.get(session.id);
    if (state) {
      Object.assign(state, updates);
    }
  }

  /**
   * Adds a pending message to a session's state with overflow protection
   */
  addPendingMessage(session: CDPSession, message: any) {
    const state = this.sessionStates.get(session.id);
    if (!state) return;

    const maxMessages = state.maxPendingMessages || this.DEFAULT_MAX_PENDING_MESSAGES;
    
    if (state.pendingMessages.length >= maxMessages) {
      console.warn(`[SessionManager] Pending message queue full for session ${session.id}. Dropping oldest message.`);
      state.pendingMessages.shift(); // Remove oldest message
    }
    
    state.pendingMessages.push(message);
  }

  /**
   * Cleans up inactive sessions to prevent resource leaks
   */
  private async cleanupInactiveSessions() {
    const now = Date.now();
    const timeout = this.SESSION_TIMEOUT;

    for (const [id, state] of this.sessionStates.entries()) {
      if (now - state.lastActivity > timeout) {
        console.log(`[SessionManager] Cleaning up inactive session ${id}`);
        const session = this.sessions.get(id);
        if (session) {
          await this.closeSession(session);
        }
      }
    }
  }

  /**
   * Handles Chrome restart by reconnecting all active sessions
   */
  async handleChromeRestart(): Promise<void> {
    console.log(`[SessionManager] Handling Chrome restart for ${this.sessions.size} active sessions`);
    
    const activeSessionsCopy = Array.from(this.sessions.values());
    const results = await Promise.allSettled(
      activeSessionsCopy.map(session => this.reconnectSession(session))
    );

    // Log results
    results.forEach((result, index) => {
      const session = activeSessionsCopy[index];
      if (result.status === 'fulfilled') {
        console.log(`[SessionManager] Successfully reconnected session ${session.id}`);
      } else {
        console.error(`[SessionManager] Failed to reconnect session ${session.id}:`, result.reason);
      }
    });
  }

  /**
   * Reconnects a single session with rate limiting
   */
  private async reconnectSession(session: CDPSession): Promise<boolean> {
    const state = this.sessionStates.get(session.id);
    if (!state) return false;

    // Check if reconnection is already in progress
    if (state.reconnectionInProgress) {
      console.log(`[SessionManager] Reconnection already in progress for session ${session.id}`);
      return false;
    }

    // Rate limit reconnections
    const now = Date.now();
    const minInterval = this.options.minReconnectInterval || this.MIN_RECONNECT_INTERVAL;
    if (state.lastReconnectTime && (now - state.lastReconnectTime) < minInterval) {
      console.log(`[SessionManager] Reconnection attempt too soon for session ${session.id}`);
      return false;
    }

    try {
      state.reconnectionInProgress = true;
      state.lastReconnectTime = now;

      const success = await this.wsManager.handleWebSocketFailure(session, 'chrome');
      
      state.reconnectionInProgress = false;
      return success;
    } catch (error) {
      state.reconnectionInProgress = false;
      throw error;
    }
  }
}
```

---

### **3.3 Proxy Session Manager (Session ID Remapping)**

If we need stable **external** IDs, or if we have advanced load-balancing or ID-mapping needs, we introduce a **ProxySessionManager**:

```ts
class SessionIDMapper {
  private sessionMap = new Map<string, string>();

  registerMapping(externalSessionID: string, internalSessionID: string) {
    this.sessionMap.set(externalSessionID, internalSessionID);
  }

  resolveInternalID(externalSessionID: string): string | undefined {
    return this.sessionMap.get(externalSessionID);
  }

  removeMapping(externalSessionID: string) {
    this.sessionMap.delete(externalSessionID);
  }
}

export class ProxySessionManager {
  private idMapper = new SessionIDMapper();
  private sessions = new Map<string, CDPSession>();

  createSession(clientWs: WebSocket, chromeWs: WebSocket): CDPSession {
    const externalSessionID = crypto.randomUUID();
    const internalSessionID = crypto.randomUUID();

    this.idMapper.registerMapping(externalSessionID, internalSessionID);

    const session: CDPSession = {
      id: internalSessionID,
      clientSocket: clientWs,
      chromeSocket: chromeWs,
      active: true
    };

    this.sessions.set(internalSessionID, session);
    return session;
  }

  getSession(externalSessionID: string): CDPSession | undefined {
    const internalSessionID = this.idMapper.resolveInternalID(externalSessionID);

    if (!internalSessionID) {
      console.error(`No internal session ID found for external session: ${externalSessionID}`);
      return undefined;
    }

    return this.sessions.get(internalSessionID) || undefined;
  }

  removeSession(externalSessionID: string) {
    const internalSessionID = this.idMapper.resolveInternalID(externalSessionID);
    if (internalSessionID) {
      this.sessions.delete(internalSessionID);
      this.idMapper.removeMapping(externalSessionID);
    } else {
      console.error(`Attempted to remove non-existent session with external ID: ${externalSessionID}`);
    }
  }
}
```

---

## **4. Plugin System**

The plugin system enables secure, configurable message interception and transformation. All plugins must be explicitly enabled and cannot block message flow unless specifically configured to do so.

```typescript
// plugin_manager.ts
export class PluginManager {
  // ... existing plugin manager code ...
}
```

## **5. Main Proxy Implementation**

Below is the final **EnhancedCDPProxy** class. It:

1. Initializes **SchemaValidator**, **ChromeManager**, **SessionManager**, etc.  
2. Handles HTTP requests for debugging, reloading, session info, etc.  
3. Upgrades incoming WebSocket connections to a new session.  
4. Routes messages from client -> (message handler) -> Chrome, and Chrome -> (message handler) -> client.

```ts
import { serve } from "https://deno.land/std@0.192.0/http/server.ts";
import { ChromeManager } from "./chrome_manager.ts";
import { SessionManager } from "./session_manager.ts";
import { CDPMessageHandler } from "./cdp_message_handler.ts";
import { SchemaValidator } from "./schema_validator.ts";
import { PlaywrightCompatibility } from "./playwright_compat.ts";
import { CDPSession, CDPPlugin } from "./types.ts";
import { PartialMessageBuffer } from "./partial_message_buffer.ts";
import { PluginManager } from "./plugin_manager.ts";

export class EnhancedCDPProxy {
  private chromeManager: ChromeManager;
  private sessionManager: SessionManager;
  private validator: SchemaValidator;
  private playwrightCompat: PlaywrightCompatibility;
  private pluginManager: PluginManager;
  private messageBuffer: PartialMessageBuffer;

  constructor() {
    this.chromeManager = new ChromeManager();
    this.sessionManager = new SessionManager(this.chromeManager);
    this.validator = new SchemaValidator();
    this.playwrightCompat = new PlaywrightCompatibility();
    this.pluginManager = new PluginManager();
    this.messageBuffer = new PartialMessageBuffer();
  }

  async initialize() {
    try {
      await this.validator.initialize();
      await this.chromeManager.start();
      // Initialize plugins that have initialize method
      for (const plugin of this.pluginManager.getPlugins()) {
        if (plugin.initialize) {
          await plugin.initialize();
        }
      }
    } catch (error) {
      await this.cleanup();
      throw new Error(`Failed to initialize proxy: ${error.message}`);
    }
  }

  private async cleanup() {
    // Clean up plugins first
    await this.pluginManager?.clearPlugins();
    await this.chromeManager?.stop();
    this.messageBuffer?.dispose();
  }

  async start(port: number = 9223) {
    await this.initialize();

    serve(async (req) => {
      if (req.headers.get("upgrade") === "websocket") {
        return this.handleWebSocket(req);
      }
      return this.handleHTTPRequest(req);
    }, { port });

    console.log(`CDP Proxy listening on port ${port}`);
  }

  private async handleWebSocket(req: Request): Promise<Response> {
    const { socket: clientWs, response } = Deno.upgradeWebSocket(req);
    const session = await this.sessionManager.createSession(clientWs);

    clientWs.onmessage = async (event) => {
      try {
        const msg = this.messageBuffer.handleMessageFragment(event.data, session.id);
        if (!msg) return; // Incomplete message

        const processed = this.pluginManager.processMessage(msg, session, "in");
        if (processed) {
          if (!this.validator.validateCDPRequest(processed)) {
            console.warn("[SchemaValidator] Invalid CDP request (but forwarding anyway):", this.validator.getErrors());
          }
          session.chromeSocket.send(JSON.stringify(processed));
        }
      } catch (error) {
        console.error("Error processing client message:", error);
      }
    };

    session.chromeSocket.onmessage = async (event) => {
      try {
        const msg = this.messageBuffer.handleMessageFragment(event.data, session.id);
        if (!msg) return; // Incomplete message

        let processed = this.playwrightCompat.transformForPlaywright(msg);
        processed = this.pluginManager.processMessage(processed, session, "out");

        if (processed) {
          if (!this.validator.validateCDPResponse(processed)) {
            console.warn("[SchemaValidator] Invalid CDP response (but forwarding anyway):", this.validator.getErrors());
          }
          clientWs.send(JSON.stringify(processed));
        }
      } catch (error) {
        console.error("Error processing Chrome message:", error);
      }
    };

    return response;
  }

  private async handleHTTPRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    
    switch (url.pathname) {
      case "/plugins":
        return this.handlePluginRequest(req);
      case "/debug/sessions":
        return this.handleSessionsRequest(req);
      case "/debug/reload":
        return this.handleReloadRequest(req);
      default:
        return new Response("CDP Proxy Running", { status: 200 });
    }
  }

  private async handlePluginRequest(req: Request): Promise<Response> {
    if (req.method === "POST") {
      try {
        const plugin = await req.json();
        await this.pluginManager.loadPlugin(plugin);
        return new Response("Plugin loaded successfully", { status: 200 });
      } catch (error) {
        return new Response(error.message, { status: 500 });
      }
    }
    return new Response("Method not allowed", { status: 405 });
  }

  private handleSessionsRequest(_req: Request): Response {
    const sessions = this.sessionManager.getActiveSessions().map(s => ({
      id: s.id,
      active: s.active
    }));
    return new Response(JSON.stringify(sessions), {
      headers: { "Content-Type": "application/json" }
    });
  }

  private async handleReloadRequest(_req: Request): Promise<Response> {
    try {
      await this.validator.initialize();
      return new Response("Schema reloaded successfully", { status: 200 });
    } catch (error) {
      return new Response(error.message, { status: 500 });
    }
  }

  async stop() {
    this.messageBuffer.dispose();
    await this.chromeManager?.stop();
  }
}
```

---

## **6. Types**

Below are some shared types:

```ts
export interface CDPSession {
  id: string;
  clientSocket: WebSocket;
  chromeSocket: WebSocket;
  active: boolean;
}

export type CDPMessage =
  | CDPCommandRequest
  | CDPCommandResponse
  | CDPEvent;

/** A request from client->Chrome with an ID and a method */
export interface CDPCommandRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** A response from Chrome->client with the same ID plus result or error */
export interface CDPCommandResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/** A domain event from Chrome->client with a method name and optional params */
export interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
}

/** Plugin API for hooking into messages or events */
export interface CDPPlugin {
  name: string;
  version: string;
  initialize?: () => Promise<void>;
  shutdown?: () => Promise<void>;
  cleanup?(): void | Promise<void>;  // Optional cleanup method for resource management
  onCDPMessage?: (
    msg: any,
    session: CDPSession,
    direction: "in" | "out"
  ) => any | null;
  subscribeToEvents?: () => CDPEventSubscription[];
}

/** Each event subscription includes the event name + handler func */
export interface CDPEventSubscription {
  event: string;
  handler: (msg: any, session: CDPSession) => void;
}
```

---

## **7. Usage Examples**

### **7.1 Basic Usage**

```ts
import { EnhancedCDPProxy } from "./enhanced_cdp_proxy.ts";

const proxy = new EnhancedCDPProxy();
await proxy.start(9223);

// Load a plugin
await fetch("http://localhost:9223/plugins", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "MyPlugin",
    version: "1.0",
    onCDPMessage: (msg, session, direction) => {
      console.log(`CDP Message ${direction}:`, msg);
      return msg;
    }
  })
});
```

---

### **7.2 Hot Reloading**

```ts
await fetch("http://localhost:9223/debug/reload", {
  method: "POST",
  body: JSON.stringify({
    schema: true,
    middleware: true,
    plugins: true
  })
});
```

---

### **7.3 Session Monitoring**

```ts
const resp = await fetch("http://localhost:9223/debug/sessions");
const sessions = await resp.json();
console.log("Active sessions:", sessions);
```

---

### **7.4 Message Replay**

```ts
const replayResp = await fetch("http://localhost:9223/debug/replay", {
  method: "POST",
  body: JSON.stringify({ sessionId: "exampleSessionId" })
});
const replayData = await replayResp.json();
console.log("Replayed messages:", replayData);
```

---

### **7.5 Plugin Example: Ad-Blocking**

```ts
const BlockRequestsPlugin: CDPPlugin = {
  name: "BlockRequests",
  version: "1.0",
  onCDPMessage: (msg, session, direction) => {
    // 'out' means Chrome->client. 'in' means client->Chrome.
    // If we want to block requests going to Chrome, that's direction "in" and method "Network.requestWillBeSent".
    if (direction === "out" && "method" in msg && msg.method === "Network.requestWillBeSent") {
      if (msg.params?.url?.includes("ads.com")) {
        console.log(`[BlockRequests] Blocking request: ${msg.params.url}`);
        return null; // drop the message
      }
    }
    return msg;
  }
};
```

(Load the plugin by adding it to a plugin array or dynamic plugin loader, then hooking it into the `CDPMessageHandler`.)

## **8. Resource Management and Safety Limits**

The CDP proxy includes several safety mechanisms to prevent resource exhaustion and ensure stable operation:

### **8.1 Memory Protection**

1. **Message Buffers**:
   - Maximum buffer size per session: 5MB
   - Automatic cleanup of stale buffers after 30 seconds
   - Memory usage monitoring with configurable warning thresholds

2. **Pending Messages**:
   - Default limit of 1000 pending messages per session
   - Configurable via `maxPendingMessages` option
   - FIFO overflow handling (oldest messages dropped first)

3. **Session Management**:
   - Automatic cleanup of inactive sessions after 1 hour
   - Configurable session timeout
   - Complete resource cleanup on session close

### **8.2 WebSocket Safety**

1. **Message Size Limits**:
   - Maximum message size: 1MB
   - Messages exceeding limit are logged and skipped during replay
   - Prevents memory exhaustion from large messages

2. **Reconnection Management**:
   - Maximum of 3 retry attempts
   - Exponential backoff between attempts
   - Proper cleanup of failed connections

### **8.3 Resource Cleanup**

The proxy automatically manages resources to prevent leaks:

1. **Active Cleanup**:
   - Stale message fragments
   - Inactive sessions
   - Failed WebSocket connections
   - Unused event handlers

2. **Passive Cleanup**:
   - Session state on connection close
   - WebSocket handlers on reconnection
   - Message buffers on successful parse

### **8.4 Monitoring**

Built-in monitoring capabilities include:

1. **Memory Usage**:
   - Buffer sizes and counts
   - Warning thresholds
   - Cleanup statistics

2. **Session Health**:
   - Activity timestamps
   - Connection status
   - Pending message counts

3. **Error Tracking**:
   - Failed reconnections
   - Message parsing errors
   - Resource cleanup failures

### **8.5 Connection Safety**

The proxy includes several mechanisms to ensure safe and reliable connections:

1. **Rate Limiting**:
   - Minimum 5-second interval between reconnection attempts
   - Connection timeout of 10 seconds
   - Configurable reconnection parameters

2. **Concurrent Operation Safety**:
   - Prevention of concurrent reconnection attempts
   - Safe handling of Chrome restarts
   - Protection against race conditions

3. **State Management**:
   - Tracking of reconnection attempts
   - Last reconnection timestamps
   - Connection progress monitoring

4. **Error Recovery**:
   - Proper socket cleanup on failures
   - Graceful handling of timeouts
   - Comprehensive error logging

### **8.6 Configuration Options**

The proxy uses a unified configuration system for all components:

```typescript
interface ProxyConfiguration {
  // Session Management
  session: {
    maxPendingMessages: number;     // Default: 1000
    sessionTimeout?: number;         // Default: 3600000 (1 hour)
    minReconnectInterval?: number;   // Default: 5000 (5 seconds)
  };
  
  // WebSocket Settings
  websocket: {
    maxRetries: number;            // Default: 3
    retryDelay: number;           // Default: 1000
    connectionTimeout: number;     // Default: 10000
  };
  
  // Buffer Settings
  buffer: {
    maxSize: number;              // Default: 5MB (5242880)
    cleanupInterval: number;      // Default: 30000
    warningThreshold: number;     // Default: 50MB (52428800)
  };
  
  // Schema Validation
  validation: {
    enabled: boolean;             // Default: false
    logErrors: boolean;          // Default: true
  };
  
  // Plugin System
  plugins: {
    autoload: boolean;           // Default: false
    sandboxed: boolean;         // Default: true
  };
}

// Usage:
const proxy = new EnhancedCDPProxy({
  session: {
    maxPendingMessages: 2000,
    sessionTimeout: 7200000
  },
  buffer: {
    maxSize: 10485760
  }
  // Other settings inherit defaults
});
```

All configuration options are documented with:
- Default values
- Valid ranges
- Impact on system behavior
- Related safety implications

This replaces the previous scattered configuration sections throughout the document.

## **9. Error Handling and Recovery**

The proxy implements a unified error handling strategy across all components:

```typitten
// Standardized error types
export enum CDPErrorType {
  CONNECTION = 'connection',
  PROTOCOL = 'protocol',
  VALIDATION = 'validation',
  RESOURCE = 'resource',
  PLUGIN = 'plugin'
}

export interface CDPError {
  type: CDPErrorType;
  code: number;
  message: string;
  details?: unknown;
  recoverable: boolean;
}

// Unified error handler
export class ErrorHandler {
  private static readonly ERROR_THRESHOLDS = {
    [CDPErrorType.CONNECTION]: 3,    // Max connection retries
    [CDPErrorType.PROTOCOL]: 5,      // Max protocol errors before session reset
    [CDPErrorType.VALIDATION]: 10,   // Max validation errors before warning
    [CDPErrorType.RESOURCE]: 1,      // Resource errors trigger immediate cleanup
    [CDPErrorType.PLUGIN]: 3         // Plugin errors before disable
  };

  handleError(error: CDPError, session?: CDPSession): void {
    // Log with standardized format
    console.error(`[${error.type}] ${error.message}`, {
      sessionId: session?.id,
      code: error.code,
      details: error.details
    });

    // Track error frequency
    this.incrementErrorCount(error.type, session?.id);

    // Apply recovery strategy
    if (error.recoverable) {
      this.attemptRecovery(error, session);
    } else {
      this.handleUnrecoverableError(error, session);
    }
  }

  private attemptRecovery(error: CDPError, session?: CDPSession): void {
    switch (error.type) {
      case CDPErrorType.CONNECTION:
        this.handleConnectionError(session);
        break;
      case CDPErrorType.PROTOCOL:
        this.handleProtocolError(session);
        break;
      case CDPErrorType.RESOURCE:
        this.triggerResourceCleanup();
        break;
      // ... other error types
    }
  }
}

// Usage in components:
export class WebSocketManager {
  constructor(private errorHandler: ErrorHandler) {}

  private handleWebSocketError(error: Error, session: CDPSession) {
    this.errorHandler.handleError({
      type: CDPErrorType.CONNECTION,
      code: 1001,
      message: error.message,
      recoverable: true
    }, session);
  }
}
```

This unified error handling:
1. Standardizes error types and recovery strategies
2. Centralizes error tracking and thresholds
3. Provides consistent logging and monitoring
4. Implements graceful degradation

This replaces the scattered error handling patterns previously found in individual components.

## **10. Logging and Monitoring**

The proxy implements a unified logging system across all components:

```typescript
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

export interface LogEntry {
  level: LogLevel;
  component: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: number;
  sessionId?: string;
}

export class Logger {
  private static instance: Logger;
  private logBuffer: LogEntry[] = [];
  private readonly MAX_BUFFER_SIZE = 1000;

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  log(entry: Omit<LogEntry, 'timestamp'>): void {
    const fullEntry: LogEntry = {
      ...entry,
      timestamp: Date.now()
    };

    // Add to rotating buffer
    this.logBuffer.push(fullEntry);
    if (this.logBuffer.length > this.MAX_BUFFER_SIZE) {
      this.logBuffer.shift();
    }

    // Format and output
    console[entry.level](`[${entry.component}] ${entry.message}`, entry.data || '');
  }

  // Structured logging methods
  debug(component: string, message: string, data?: Record<string, unknown>, sessionId?: string): void {
    this.log({ level: LogLevel.DEBUG, component, message, data, sessionId });
  }

  info(component: string, message: string, data?: Record<string, unknown>, sessionId?: string): void {
    this.log({ level: LogLevel.INFO, component, message, data, sessionId });
  }

  warn(component: string, message: string, data?: Record<string, unknown>, sessionId?: string): void {
    this.log({ level: LogLevel.WARN, component, message, data, sessionId });
  }

  error(component: string, message: string, data?: Record<string, unknown>, sessionId?: string): void {
    this.log({ level: LogLevel.ERROR, component, message, data, sessionId });
  }

  // Query methods
  getRecentLogs(count: number = 100): LogEntry[] {
    return this.logBuffer.slice(-count);
  }

  getLogsBySession(sessionId: string): LogEntry[] {
    return this.logBuffer.filter(entry => entry.sessionId === sessionId);
  }

  getLogsByComponent(component: string): LogEntry[] {
    return this.logBuffer.filter(entry => entry.component === component);
  }
}

// Usage in components:
export class WebSocketManager {
  private readonly logger = Logger.getInstance();

  private handleWebSocketError(error: Error, session: CDPSession): void {
    this.logger.error('WebSocketManager', 'Connection failed', {
      error: error.message,
      retryCount: this.retryCount.get(session.id)
    }, session.id);
  }
}
```

This unified logging system provides:
1. Consistent log format across components
2. Structured logging with metadata
3. Log rotation and querying
4. Session and component tracking

This replaces the scattered console.log calls previously found throughout the codebase.

## **11. Critical Implementation Notes and Safety Measures**

### **11.1 Initialization and Cleanup**
```typescript
class EnhancedCDPProxy {
  async initialize() {
    try {
      await this.validator.initialize();
      await this.chromeManager.start();
      // Initialize plugins that have initialize method
      for (const plugin of this.pluginManager.getPlugins()) {
        if (plugin.initialize) {
          await plugin.initialize();
        }
      }
    } catch (error) {
      await this.cleanup();
      throw new Error(`Failed to initialize proxy: ${error.message}`);
    }
  }

  private async cleanup() {
    // Clean up plugins first
    await this.pluginManager?.clearPlugins();
    await this.chromeManager?.stop();
    this.messageBuffer?.dispose();
  }
}
```

The cleanup process ensures:
1. All plugins get a chance to clean up their resources
2. Async cleanup operations are properly awaited
3. Chrome process is terminated
4. Message buffers are disposed

