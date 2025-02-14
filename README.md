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

   You have two mutually exclusive options for configuring Chrome/Chromium:

   **Option 1: Use Your Own Chrome/Chromium**
   ```env
   # Point to your existing Chrome/Chromium executable
   CHROMIUM_EXECUTABLE_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
   ```

   **Option 2: Let the Proxy Download and Manage Chromium**
   ```env
   # Directory where Chromium will be installed
   CHROMIUM_DIRECTORY=.cache/chromium
   # Specific version to download (find versions at https://chromiumdash.appspot.com/)
   CHROMIUM_STATIC_VERSION=1381568
   ```

   **Required for Both Options:**
   ```env
   # Port for the CDP proxy to listen on
   CDP_PROXY_PORT=9222
   ```

   > **Important:** You must choose either Option 1 OR Option 2. Setting both `CHROMIUM_EXECUTABLE_PATH` and either of the Option 2 variables will result in an error.

3. **Install Chromium (Only for Option 2):**

   If you chose Option 2 (letting the proxy manage Chromium), install it using:

   ```bash
   deno task install:chromium
   ```

   > Note: Skip this step if you're using your own Chrome/Chromium executable (Option 1).

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

*   **Option 1: Use Your Own Chrome/Chromium**
    - **`CHROMIUM_EXECUTABLE_PATH`:** Path to your Chrome or Chromium executable. When set, the proxy will use this executable directly and ignore `CHROMIUM_DIRECTORY` and `CHROMIUM_STATIC_VERSION`.

*   **Option 2: Let the Proxy Manage Chromium**
    - **`CHROMIUM_DIRECTORY`:** The directory where Chromium will be installed and launched from. Required when not using `CHROMIUM_EXECUTABLE_PATH`.
    - **`CHROMIUM_STATIC_VERSION`:** The specific Chromium version to download and use. Required when not using `CHROMIUM_EXECUTABLE_PATH`. You can find branch positions (versions) at [https://chromiumdash.appspot.com/](https://chromiumdash.appspot.com/).

*   **Required for Both Options**
    - **`CDP_PROXY_PORT`:** The port the proxy will listen on. Defaults to `9222`.

### Chromium Management

The proxy includes a script (`scripts/install-chromium.ts`) to download and manage a Chromium instance. This is only relevant if you're using Option 2 (letting the proxy manage Chromium).

*   **Installation:** `deno task install:chromium`
*   **Force Reinstall:** `deno task install:chromium --force` (This will remove the existing Chromium installation and download a fresh copy.)

The installed Chromium version is stored in a `.chromium-version` file within the `CHROMIUM_DIRECTORY`.

Note: If you're using Option 1 (your own Chrome/Chromium), you don't need to use this script.

### Proxy Startup as a Library

The `startProxy`