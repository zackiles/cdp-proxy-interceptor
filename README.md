# CDP Proxy Interceptor

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Overview

The `cdp-proxy-interceptor` is a transparent man-in-the-middle (MITM) proxy for the Chrome DevTools Protocol (CDP). Intercept, modify, inject, and filter messages between a CDP-enabled browser and any clients interacting with it such as Playwright or Puppeteer.

The core strength of this proxy lies in its flexible plugin system, which allows users to write anything from basic intercepts, to advanced plugins that can extend and enhance the capabilities of their CDP client. Some examples of what you could do with a plugin:

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

   Clone the repository to your local machine:

   ```bash
   git clone <repository_url>
   cd cdp-proxy-interceptor
   ```

2. **Set Up Environment Variables:**

   Copy the example environment file and edit it as needed:

   ```bash
   cp .env.example .env
   ```

   Adjust the values in `.env` to suit your setup, such as the `CHROMIUM_STATIC_VERSION` if you plan to use the built-in Chromium management, or the `CHROMIUM_DIRECTORY` if you plan to bring your own copy of Chrome or Chromium (note: will override `CHROMIUM_STATIC_VERSION`).

3. **Install Chromium (Optional):**

   If you want the proxy to install and use it's own Chromium instance for the proxy, you can install it using:

   ```bash
   deno task install:chromium
   ```

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

You can use a plugin to modify the user agent reported by the browser.  This is useful for testing responsive designs or accessing content that's tailored to specific browsers or devices.

**Example (using a modified `advanced_plugin.ts`):**

```typescript
export default {
  name: "UserAgentPlugin",

  async onRequest(request) {
    if (request.method === "Network.setUserAgentOverride") {
      request.params.userAgent = request.params.userAgent + " [Modified by Proxy]"
    }
    return request
  }
}
```

### 2. Blocking Requests

You can block specific requests, such as those for images or analytics, to speed up page load times or simulate different network conditions.

**Example (using a modified `advanced_plugin.ts`):**

```typescript
export default {
  name: "BlockingPlugin",

  async onRequest(request) {
    if (request.method === "Network.continueInterceptedRequest") {
      const targetUrl = request.params?.url
      if (targetUrl && targetUrl.includes("ads")) {
        // Block requests by returning null
        return null
        // Or you could even return a custom error
        // return {
        //    ...request,
        //    params: { ...request.params, errorReason: "BlockedByClient" }
        //  }
      }
    }
    // If it doesn't match our filter pass the message as normal
    return request
  }
}
```

### 3. Logging CDP Traffic

The `simple_plugin.ts` (when enabled) provides basic logging of all CDP requests, responses, and events.  This is a great starting point for debugging and understanding the communication flow.

**Example (using `simple_plugin.ts`):**

```typescript
export default {
  name: "LoggingPlugin",

  async onRequest(request) {
    console.log("Request →", request)
    return request
  },

  async onResponse(response) {
    console.log("Response →", response)
    return response
  },

  async onEvent(event) {
    console.log("Event →", event)
    return event
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

## Configuration

### Environment Variables

The proxy uses environment variables for configuration.  You can set these in a `.env` file in the project root.  An example file (`.env.example`) is provided:

```sh

CHROMIUM_DIRECTORY=.cache/chromium
CDP_PROXY_PORT=9222
# Checkout https://chromiumdash.appspot.com/
CHROMIUM_STATIC_VERSION=1381568 # Last stable branch position as of 2025-02-11
```

*   **`CHROMIUM_DIRECTORY`:**  The directory where Chromium will be installed and launched from.  Defaults to `.cache/chromium`.
*   **`CDP_PROXY_PORT`:** The port the proxy will listen on.  Defaults to `9222`.
*   **`CHROMIUM_STATIC_VERSION`:**  The specific Chromium version to download and use.  If not set, the proxy will attempt to fetch the latest stable version.  This is useful for ensuring consistent behavior across different environments.  You can find branch positions (versions) at [https://chromiumdash.appspot.com/](https://chromiumdash.appspot.com/).

### Chromium Management

The proxy includes a script (`scripts/install-chromium.ts`) to download and manage a Chromium instance.  This simplifies setup and ensures compatibility.

*   **Installation:** `deno run install:chromium`
*   **Force Reinstall:** `deno run install:chromium --force` (This will remove the existing Chromium installation and download a fresh copy.)

The installed Chromium version is stored in a `.chromium-version` file within the `CHROMIUM_DIRECTORY`.

### Proxy Startup as a Library

The `startProxy` function (in `src/main.ts`) can be used to start the proxy programmatically:

```typescript
import startProxy from './src/main.ts';

async function main() {
  const port = 9222; // Or get from environment variable
  const { cleanup } = await startProxy(port);

  // ... your code here ...

  // When you're done, clean up:
  await cleanup();
}

main();
```

The `cleanup` function handles shutting down the Chromium instance and closing any open connections.

## Plugin Development

Plugins are TypeScript classes that implement the `CDPPlugin` interface:

```typescript

// src/types.ts
export interface CDPPlugin {
  name: string;
  onRequest?(request: CDPCommandRequest): Promise<CDPCommandRequest | null>;
  onResponse?(response: CDPCommandResponse): Promise<CDPCommandResponse | null>;
  onEvent?(event: CDPEvent): Promise<CDPEvent | null>;
}
```

*   **`name`:**  A descriptive name for your plugin.
*   **`onRequest`:**  Called for each CDP command request.  You can modify the request, block it (by returning `null`), or pass it through unchanged.
*   **`onResponse`:**  Called for each CDP command response.  You can modify the response or pass it through.
*   **`onEvent`:**  Called for each CDP event.  You can modify the event or filter it (by returning `null`).

**Important Considerations:**

*   **Asynchronous Operations:**  Plugin methods *must* be `async` and return a `Promise`.
*   **Error Handling:**  Plugins should handle errors gracefully.  The `PluginManager` catches errors and logs them using the `ErrorHandler`, but unhandled exceptions within a plugin could destabilize the proxy.
*   **CDP Message Types:**  Familiarize yourself with the `CDPCommandRequest`, `CDPCommandResponse`, and `CDPEvent` types defined in `src/types.ts`. These interfaces define the structure of the messages you'll be working with.
* **Return `null` to Block:** If any of the `onRequest`, `onResponse`, or `onEvent` methods return `null`, the message will not be not be further processed or forwarded.
* **Plugin Loading:** The proxy automatically loads plugins from the `plugins` directory on startup. Files must have a `.ts` or `.js` extension and *not* include `.disabled.` in their name to be loaded.