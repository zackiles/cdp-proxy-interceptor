# CDP Proxy Interceptor

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Overview

The `cdp-proxy-interceptor` is a transparent man-in-the-middle (MITM) proxy for the Chrome DevTools Protocol (CDP). Intercept, modify, inject, and filter messages between a CDP-enabled browser and any clients interacting with it such as Playwright or Puppeteer.

The core strength of this proxy lies in its [flexible plugin system](docs/plugin-specification.md), which allows users to write anything from basic intercepts, to advanced plugins that can extend and enhance the capabilities of their CDP client. Some examples of what you could do with a plugin:

- **Workload Management:** Intercept your Playwright requests and generate distributed workloads from it that spin up multiple browsers and fan out the work evenly, seamlessly, and transparently to your client code.
- **Stealth Modifications:** Playwright uses `Runtime.enable` on every page by default which is now freqeuntly detected as automation. Current approaches such as [github.com/rebrowser/rebrowser-patches](https://github.com/rebrowser/rebrowser-patches) rely on brittle code-patches made to Playwright's code directly that attempt to block Playwrights attempts to replace `Runtime.enable` and provide context ids to Playwright a different way that accessing the page. With this proxy, you don't need to patch any code, and can simply write a plugin to overwrite requests to `Runtime.enable`
- **Advanced Usage:** Raw CDP is a simple payload to work with, often simpler than the abstractions client libraries like Playwright present, but providing full access to the Devtools protocol including experimental features. Getting access to those in Playwright is as simple as writing a simple plugin for this proxy.


## Features

*   **Modify CDP requests and responses:**  Change parameters, block requests, or inject custom data.
*   **Extend CDP functionality:**  Add custom behavior not natively supported by the protocol.
*   **Debug automation scripts:**  Gain deep insights into the communication between your automation tool and the browser.
*   **Simulate network conditions:**  Throttle bandwidth, inject latency, or simulate offline states (with appropriate plugins).
*   **Mock CDP responses:**  Test your automation scripts against specific scenarios without relying on a real browser.

## Quick Start

1. **Clone the Repository:**

   Clone the repository to your local machine (Note: have Deno installed):

   ```bash
   git clone git@github.com:zackiles/cdp-proxy-interceptor.git
   cd cdp-proxy-interceptor
   ```

2. **Set Up Environment Variables:**

   Copy the example environment file and edit it as needed:

   ```bash
   cp .env.example .env
   ```

   Configure your environment variables according to the [Configuration section](#environment-variables) below. You'll need to choose between using your own Chrome/Chromium executable or letting the proxy manage Chromium for you.

3. **Install Chromium (Optional):**

   If you chose to let the proxy manage Chromium (Option 2 in the [Configuration section](#environment-variables)), install it using:

   ```bash
   deno run install:chromium
   ```

   > Note: Skip this step if you're using your own Chrome/Chromium executable.

4. **Start the Proxy Server:**

   Launch the proxy server with:

   ```bash
   deno run serve
   ```

   This starts the proxy on the port specified in your `.env` file (default is 9222).

5. **Enable Plugins:**

   Write your plugins in the `/plugins` directory in either `.js` or `.ts`. To get you started two examples (simple and advanced) are provided,you can enable them by renaming them to remove the `.disabled` extension in their names.

6. **Connect Your Automation Tool (Playwright Example):**

   Use the following example to connect Playwright to the proxy:

   ```typescript
   import { chromium } from 'npm:playwright';

   const proxyServerPort = // Add the port you configured in the .env for the proxy
   const browser = await chromium.connectOverCDP(`ws://localhost:${proxyServerPort}/devtools/browser`);
    // Do your regular stuff with Playwright as normal
   ```

## Plugin Examples

### 1. Modifying User Agent

You can use a plugin to modify the user agent reported by the browser. This is useful for testing responsive designs or accessing content that's tailored to specific browsers or devices.

For complete details on plugin development, see the [Plugin Specification](docs/plugin-specification.md).

**Example (using a modified `advanced_plugin.ts`):**

```typescript
export default {
  name: "UserAgentPlugin",

  async onRequest(request) {
    if (request.method === "Network.setUserAgentOverride") {
      return {
        ...request,
        params: {
          ...request.params,
          userAgent: `${request.params.userAgent} [Modified by Proxy]`
        }
      }
    }
    return request
  },

  // Optional: Monitor user agent changes
  async onResponse(response) {
    if (response.id && 'result' in response) {
      // Log successful user agent changes
      console.log('User agent updated successfully')
    }
    return response
  }
}
```

### 2. Advanced Request Interception

This example shows how to use session management and command execution to implement sophisticated request handling:

```typescript
export default {
  name: "RequestInterceptionPlugin",

  async onRequest(request) {
    if (request.method === "Network.continueInterceptedRequest") {
      const { interceptionId, url } = request.params

      if (url?.includes("ads")) {
        // Block ad requests
        return null
      }

      if (url?.includes("api")) {
        try {
          // Get the session context for the request
          const session = await this.sendCDPCommand(
            '/devtools/page/123',
            request.sessionId,
            {
              method: 'Network.getRequestPostData',
              params: { interceptionId }
            }
          )

          // Modify the request based on post data
          if (session.result?.postData) {
            return {
              ...request,
              params: {
                ...request.params,
                postData: this.modifyPostData(session.result.postData)
              }
            }
          }
        } catch (error) {
          // Handle errors gracefully
          console.warn(`Failed to modify request: ${error.message}`)
        }
      }
    }
    return request
  },

  // Helper method to modify post data
  modifyPostData(data) {
    // Add custom logic here
    return data
  }
}
```

### 3. Event Monitoring and Injection

This example demonstrates how to use event handling and emission:

```typescript
export default {
  name: "EventMonitorPlugin",

  async onEvent(event) {
    // Monitor page load events
    if (event.method === "Page.loadEventFired") {
      try {
        // Emit a custom event to the client
        await this.emitClientEvent(event.sessionId, {
          method: "Custom.pageLoadComplete",
          params: {
            timestamp: Date.now(),
            metrics: await this.getPageMetrics(event.sessionId)
          }
        })
      } catch (error) {
        console.error(`Failed to emit custom event: ${error.message}`)
      }
    }
    return event
  },

  // Helper method to gather page metrics
  async getPageMetrics(sessionId) {
    const result = await this.sendCDPCommand(
      '/devtools/page/123',
      sessionId,
      {
        method: 'Performance.getMetrics'
      }
    )
    return result.result?.metrics || []
  }
}
```

### 4. Extending CDP with Custom Commands

You can create plugins that adds new commands or enhances existing CDP commands. This allows you to build higher-level abstractions or combine multiple CDP commands into a single operation.

**Example (Enhanced DOM Query):**

```typescript
export default {
  name: "EnhancedDOMPlugin",
  
  async onRequest(request) {
    if (request.method === "Enhanced.getElementInfo") {
      const { nodeId } = request.params;
      
      // Combine multiple CDP commands into one enhanced operation
      const [boxModel, styles] = await Promise.all([
        this.sendCommand({ method: "DOM.getBoxModel", params: { nodeId } }),
        this.sendCommand({ 
          method: "Runtime.evaluate",
          params: {
            expression: `(() => {
              const el = document.querySelector('[data-nodeid="${nodeId}"]');
              return window.getComputedStyle(el);
            })()`
          }
        })
      ]);

      // Return enriched response combining multiple CDP results
      return {
        id: request.id,
        result: {
          dimensions: boxModel.model,
          computedStyle: styles.result
        }
      };
    }
    return request;
  }
}
```

This plugin creates an `Enhanced.getElementInfo` command that combines `DOM.getBoxModel` and `Runtime.evaluate` to return both the element's dimensions and computed styles in a single call. This is more efficient than making multiple CDP calls from your client code.

### Plugin Interface Details

The CDP Proxy Interceptor provides a robust plugin interface with several key methods and capabilities. For the complete plugin specification, see [Plugin Specification](docs/plugin-specification.md).

#### Core Plugin Methods

```typescript
interface CDPPlugin {
  name: string;
  onRequest?(request: CDPCommandRequest): Promise<CDPCommandRequest | null>;
  onResponse?(response: CDPCommandResponse): Promise<CDPCommandResponse | null>;
  onEvent?(event: CDPEvent): Promise<CDPEvent | null>;
}
```

#### Message Handling

1. **Message Flow:**
   - Requests from client → `onRequest` → Chrome
   - Responses from Chrome → `onResponse` → client
   - Events from Chrome → `onEvent` → client

2. **Message IDs:**
   - Plugin-initiated commands use IDs starting from `1000000000`
   - Responses to plugin commands are automatically matched and routed back
   - Plugin command responses are not forwarded to the client

3. **Session Management:**
   - Each WebSocket connection gets a unique session ID
   - Plugins can use session IDs to maintain state and context
   - Session IDs are required for `sendCDPCommand` and `emitClientEvent`

#### Advanced Plugin Capabilities

1. **Command Execution:**

   ```typescript
   async sendCDPCommand(endpoint: string, proxySessionId: string, message: CDPCommandRequest) {
     // Automatically handles:
     // - Message ID generation
     // - Response matching
     // - Timeouts (5 second default)
     // - WebSocket state validation
     // - Error handling
   }
   ```

2. **Event Emission:**

   ```typescript
   async emitClientEvent(proxySessionId: string, event: CDPEvent) {
     // Allows plugins to:
     // - Send custom events to clients
     // - Simulate browser events
     // - Provide plugin-specific notifications
   }
   ```

3. **Message Blocking:**
   - Return `null` from any handler to block message propagation
   - Useful for filtering, security, or implementing custom behavior

4. **Error Handling:**
   - Plugin errors are caught and logged
   - Errors don't crash the proxy
   - Original messages pass through on error
   - Custom error types and codes for different scenarios

## Configuration

### Environment Variables

The proxy uses environment variables for configuration. You can set these in a `.env` file in the project root. An example file (`.env.example`) is provided:

```sh
# Option 1: Use your own Chrome/Chromium
CHROMIUM_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# Option 2: Let the proxy manage Chromium
CHROMIUM_DIRECTORY=.cache/chromium
CHROMIUM_STATIC_VERSION=1381568 # Last stable branch position as of 2025-02-11

# Required for both options
CDP_PROXY_PORT=9222
```

You have two mutually exclusive options for configuring Chrome/Chromium:

**Option 1: Use Your Own Chrome/Chromium**
- **`CHROMIUM_EXECUTABLE_PATH`:** Path to your Chrome or Chromium executable. When set, the proxy will use this executable directly and ignore `CHROMIUM_DIRECTORY` and `CHROMIUM_STATIC_VERSION`.

**Option 2: Let the Proxy Download and Manage Chromium**
- **`CHROMIUM_DIRECTORY`:** The directory where Chromium will be installed and launched from. Required when not using `CHROMIUM_EXECUTABLE_PATH`.
- **`CHROMIUM_STATIC_VERSION`:** The specific Chromium version to download and use. Required when not using `CHROMIUM_EXECUTABLE_PATH`. You can find branch positions (versions) at [https://chromiumdash.appspot.com/](https://chromiumdash.appspot.com/).

**Required for Both Options**
- **`CDP_PROXY_PORT`:** The port the proxy will listen on. Defaults to `9222`.

> **Important:** You must choose either Option 1 OR Option 2. Setting both `CHROMIUM_EXECUTABLE_PATH` and either of the Option 2 variables will result in an error.

### Chromium Management

The proxy includes a script (`scripts/install-chromium.ts`) to download and manage a Chromium instance. This is only relevant if you're using Option 2 above (letting the proxy manage Chromium).

*   **Installation:** `deno run install:chromium`
*   **Force Reinstall:** `deno run install:chromium --force` (This will remove the existing Chromium installation and download a fresh copy.)

The installed Chromium version is stored in a `.chromium-version` file within the `CHROMIUM_DIRECTORY`.

Note: If you're using Option 1 (your own Chrome/Chromium), you don't need to use this script.

### Proxy Startup as a Library

The `startProxy` function can be imported and used programmatically in your own code:

```typescript
import { startProxy } from 'cdp-proxy-interceptor'

const port = 9222
const { cleanup } = await startProxy(port)

// When you're done, clean up resources
await cleanup()
```

### Signal Handling

The proxy automatically handles SIGTERM and SIGINT signals, performing a graceful shutdown that:
1. Stops the Chrome instance
2. Closes all WebSocket connections
3. Shuts down the HTTP server

## Development

### Project Structure

```
cdp-proxy-interceptor/
├── src/                # Source code
│   ├── chrome_manager.ts   # Chrome process management
│   ├── http_manager.ts     # HTTP request handling
│   ├── plugin_manager.ts   # Plugin system
│   ├── session_manager.ts  # WebSocket session tracking
│   └── ws_manager.ts       # WebSocket handling
├── test/              # Test files
├── plugins/           # Plugin directory
└── scripts/          # Utility scripts
```

### Running Tests

```bash
deno run tests
```

### Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat(logging): improved logging'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.