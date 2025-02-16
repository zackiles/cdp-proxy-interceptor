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

For detailed plugin examples and the full API, see the [Plugin Specification](docs/plugin-specification.md) and the example plugins in the `/plugins` directory.

### Plugin Interface Details

The CDP Proxy Interceptor provides a robust plugin interface with several key methods and capabilities. For the complete plugin specification, see [Plugin Specification](docs/plugin-specification.md).

#### Core Plugin Methods

Plugins extend the `BaseCDPPlugin` class and can override the following methods:

| Method        | Description                                                                                                                                                                                                                                                           |
|---------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `onRequest`   | Called when a CDP command request is received from the client. Plugins can modify, block, or respond to the request. Returns `Promise<CDPCommandRequest | null>`.                                                                                                                                               |
| `onResponse`  | Called when a CDP command response is received from the browser. Plugins can modify or block the response. Returns `Promise<CDPCommandResponse | null>`.                                                                                                                                            |
| `onEvent`     | Called when a CDP event is received from the browser. Plugins can modify or block the event. Returns `Promise<CDPEvent | null>`.                                                                                                                                                          |
| `cleanup`     | Called when the plugin is being disposed. Plugins should use this to clean up any resources they have allocated. Returns `Promise<void>`.                                                                                                                                |

Plugins can send CDP commands using the injected `this.sendCDPCommand` method and emit CDP events using the injected `this.emitClientEvent` method.

#### Advanced Plugin Capabilities

1. **Command Execution:** Plugins can send CDP commands to the browser using the injected `this.sendCDPCommand` method. This method automatically handles message ID generation, response matching, timeouts, WebSocket state validation, and error handling.

2. **Event Emission:** Plugins can emit CDP events (but not responses) to the client using the injected `this.emitClientEvent` method. This allows plugins to send custom events, simulate browser events, and provide plugin-specific notifications.

3. **Message Blocking:** Return `null` from `onRequest`, `onResponse`, or `onEvent` to prevent the message from being propagated.

4. **Error Handling:** Plugin errors are caught and logged. Errors do not crash the proxy, and the original message will pass through unless blocked by the plugin.

### **Plugin Example: Ad-Blocking**

```typescript
import { BaseCDPPlugin } from '../src/base_cdp_plugin.ts';
import type { CDPEvent } from '../src/types.ts';

export default class BlockRequestsPlugin extends BaseCDPPlugin {
  name = "BlockRequests";

  override async onEvent(event: CDPEvent): Promise<CDPEvent | null> {
    if (event.method === "Network.requestWillBeSent") {
      const url = event.params?.request?.url;
      if (url?.includes("ads.com")) {
        console.log(`[BlockRequests] Blocking request: ${url}`);
        return null; // drop the message
      }
    }
    return event;
  }
}
```

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

## Contributing

For information about contributing to the project, including development setup, using the logger, and the contribution process, please see [CONTRIBUTORS.md](CONTRIBUTORS.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.