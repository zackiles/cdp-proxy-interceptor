## [https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/chromium/crConnection.ts](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/chromium/crConnection.ts)

**Purpose:**  
This file manages execution contexts within Chromium browsers, focusing on compatibility and controlled context initialization.

> **What Playwright normally does:**  
> - Calls the Chrome DevTools Protocol (CDP) to enable the runtime (`Runtime.enable`) and then listens for runtime events (e.g., `Runtime.executionContextCreated`) to manage JavaScript execution contexts for each frame.  
> - Expects to receive context IDs from the browser as soon as `Runtime.enable` is called.

> **What this patch changes:**  
> - Skips or replaces the direct usage of `Runtime.enable` in certain modes.  
> - Introduces the `__re__emitExecutionContext` workflow, which manually constructs context creation events through custom bindings or isolated worlds.  
> - Injects stealth logic (e.g., random binding names) to avoid detection from scripts looking for `Runtime.enable` signals.

---

**Technical specifications:**  
- The `__re__emitExecutionContext` method handles emitting execution context events.  
- It uses the `REBROWSER_PATCHES_RUNTIME_FIX_MODE` environment variable to select the “fix mode” for contexts.  
- The `addBinding` mode injects a script to capture the main world context.  
- The `alwaysIsolated` mode prioritizes isolated worlds for context management.  
- Helper methods like `__re__getMainWorld` and `__re__getIsolatedWorld` abstract context creation.

> **What Playwright normally does:**  
> - Once `Runtime.enable` is active, Playwright tracks all contexts automatically via CDP events.  
> - It does not manually emit `Runtime.executionContextCreated`; it relies on the browser to emit them.

> **What this patch changes:**  
> - Manually emits `Runtime.executionContextCreated` for each frame/worker without enabling the runtime domain globally.  
> - Uses environment-driven modes (`addBinding`, `alwaysIsolated`) to decide how contexts are generated and signaled to Playwright.  

---

**Reasons for changes:**  
- **Prevent bot detection by avoiding the `Runtime.enable` CDP command, which is commonly flagged by anti-bot software.**  
- **Offer alternative context management methods to bypass detection based on `Runtime.enable` usage.**  
- **Enable running scripts in isolated contexts to minimize the risk of detection through interaction with the main context.**

> **What Playwright normally does:**  
> - Calls `Runtime.enable` at page startup; anti-bot scripts can detect that call.

> **What this patch changes:**  
> - Avoids the universal call to `Runtime.enable` and replaces it with stealth context-creation to sidestep known detection methods.

---

## [https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/chromium/crDevTools.ts](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/chromium/crDevTools.ts)

**Purpose:**  
This file handles low-level communication with the Chromium DevTools Protocol, specifically runtime management.

> **What Playwright normally does:**  
> - Immediately sends `Runtime.enable` when opening a DevTools session so it can receive console events and execution context details from the browser.

> **What this patch changes:**  
> - Conditionally skips `Runtime.enable` entirely unless `REBROWSER_PATCHES_RUNTIME_FIX_MODE` is set to `'0'` (i.e., no stealth).  
> - Reduces the chance that anti-bot scripts see the `Runtime.enable` request happening at page load.

---

**Technical specifications:**  
- Conditionally enables the runtime using `Runtime.enable` based on the `REBROWSER_PATCHES_RUNTIME_FIX_MODE` environment variable.  
- Controls when Playwright receives runtime events and information.

> **What Playwright normally does:**  
> - Expects `Runtime.enable` calls to finalize the DevTools session setup.

> **What this patch changes:**  
> - Wraps that call in a check so that `Runtime.enable` is skipped in “stealth” modes.  
> - Continues to enable other domains (e.g., `Page.enable`), but not the runtime domain unless explicitly allowed.

---

**Reasons for changes:**  
- **Manipulate the timing of `Runtime.enable` to avoid immediate detection by anti-bot systems.**  
- **Disable `Runtime.enable` entirely when using alternative context management methods to evade detection.**

> **What Playwright normally does:**  
> - Exposes the runtime domain from the start, which is visible to detection scripts.

> **What this patch changes:**  
> - Lets the user choose whether to skip that domain enablement, limiting the usual signals.

---

## [https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/chromium/crPage.ts](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/chromium/crPage.ts)

**Purpose:**  
This file manages individual pages, including worker initialization and lifecycle events.

> **What Playwright normally does:**  
> - Automatically calls `Runtime.enable` for each new page.  
> - Expects the browser to manage contexts and provide them back to Playwright.

> **What this patch changes:**  
> - Conditionally stops enabling the runtime domain.  
> - Passes additional parameters to the Worker class (e.g., `targetId`, `session`) so it can manually create or fetch execution contexts when needed.

---

**Technical specifications:**  
- Mirrors changes in `crPage.js` for consistent page management.  
- Includes conditional runtime enabling similar to `crDevTools.ts`.  
- Modifies worker creation to pass additional parameters for enhanced context management.

> **What Playwright normally does:**  
> - Spawns Worker objects as soon as a new worker target is found, enabling the runtime in that worker so the user can run scripts.

> **What this patch changes:**  
> - In “stealth” modes, worker scripts never call `Runtime.enable`; instead, they rely on the patched `__re__emitExecutionContext` approach.

---

**Reasons for changes:**  
- **Maintain consistent context management between pages and workers to present a unified behavior and avoid detection discrepancies.**  
- **Modify worker behavior to reduce the visibility of automation and evade detection that targets worker-specific characteristics.**

> **What Playwright normally does:**  
> - Consistency among frames and workers is typically handled by the same `Runtime.enable` calls.

> **What this patch changes:**  
> - Ensures the new stealth context approach is uniformly applied to all browser contexts, including workers.

---

## [https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/chromium/crServiceWorker.ts](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/chromium/crServiceWorker.ts)

**Purpose:**  
This file manages service workers, including their lifecycle and interactions with the page.

> **What Playwright normally does:**  
> - Enables `Runtime` when attaching to a service worker so it can evaluate scripts or retrieve logs.

> **What this patch changes:**  
> - Skips calling `Runtime.enable` for service workers if `REBROWSER_PATCHES_RUNTIME_FIX_MODE` is not `'0'`.  
> - Avoids broadcasting that the runtime domain is active in a service worker context, which some detection scripts may watch.

---

**Technical specifications:**  
- Implements conditional runtime enabling based on the `REBROWSER_PATCHES_RUNTIME_FIX_MODE` environment variable.

> **What Playwright normally does:**  
> - Just calls `Runtime.enable` by default as soon as it attaches to the service worker session.

> **What this patch changes:**  
> - Wraps that call in an `if` statement to leave the runtime disabled for stealth modes.

---

**Reasons for changes:**  
- **Adapt runtime management in service workers to align with the overall anti-detection strategy, ensuring consistent behavior across all contexts.**  
- **Minimize the footprint of automation within service workers to avoid detection mechanisms that specifically target service worker activity.**

> **What Playwright normally does:**  
> - Provides a straightforward way to run code in the service worker context.

> **What this patch changes:**  
> - Uses a stealth approach so the service worker does not obviously reveal itself via CDP runtime calls.

---

## [https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/frames.ts](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/frames.ts)

**Purpose:**  
This file manages the frame hierarchy within a page and their execution contexts.

> **What Playwright normally does:**  
> - Uses `Runtime.enable` to gather initial frame contexts, then updates them via standard CDP events (e.g., `executionContextCreated`, `executionContextDestroyed`).

> **What this patch changes:**  
> - Explicitly calls `crSession.emit('Runtime.executionContextsCleared')` during navigation commits.  
> - Uses `__re__emitExecutionContext` to “fake” the creation of a new main or isolated context for each frame, bypassing the direct `Runtime.enable` approach.

---

**Technical specifications:**  
- Emits a `Runtime.executionContextsCleared` event, signaling changes in frame context structure.  
- Modifies the `_context` method for robust context management and error handling.

> **What Playwright normally does:**  
> - The browser automatically sends `Runtime.executionContextsCleared` events once `Runtime.enable` is active.

> **What this patch changes:**  
> - Manually triggers those events to maintain correct internal state without enabling the runtime domain at a global level.  
- Uses custom logic to fetch or create the correct context ID at the moment a script needs it.

---

**Reasons for changes:**  
- **Improve context handling in frames to avoid detection routines that monitor frame activity and context changes.**  
- **Ensure stealthy manipulation of frame contexts to prevent detection by security systems that track such modifications.**

> **What Playwright normally does:**  
> - Relies on the browser to auto-emit context-related events as soon as it’s connected.

> **What this patch changes:**  
> - Replaces that auto-emit with manual triggers so no `Runtime.enable` handshake is observed.

---

## [https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/page.ts](https://raw.githubusercontent.com/microsoft/playwright/refs/heads/main/packages/playwright-core/src/server/page.ts)

**Purpose:**  
This file handles high-level page management, including binding calls and event dispatching.

> **What Playwright normally does:**  
> - The `Worker` class and page code automatically assume `Runtime.enable` is present.  
> - Sends user scripts into frames, workers, etc., expecting the normal set of CDP events.

> **What this patch changes:**  
> - Enhances the `Worker` constructor to accept a `targetId` and `session`, which then uses the patched approach to create or retrieve an execution context on demand.  
> - Filters certain payloads in the `dispatch` method to ensure that ephemeral “stealth” calls aren’t interpreted as normal script messages.

---

**Technical specifications:**  
- Updates the `Worker` class with parameters and methods for context management.  
- Adds logic to filter payloads in the `dispatch` method.

> **What Playwright normally does:**  
> - Binds to normal CDP events to handle worker code evaluation.  
> - Doesn’t discriminate messages that are purely for “stealth” binding creation.

> **What this patch changes:**  
> - Defers a worker’s actual runtime context creation until the user runs code.  
> - Ignores short, non-JSON messages used internally to trigger the new binding, thus preventing confusion or errors in standard script evaluation.

---

**Reasons for changes:**  
- **Extend anti-detection measures to workers, ensuring consistent context management with the page to avoid detection based on worker behavior.**  
- **Filter events or messages that could reveal automation activity to security systems monitoring network traffic or browser behavior.**

> **What Playwright normally does:**  
> - Immediately opens a new runtime environment for each worker.

> **What this patch changes:**  
> - Delays or replaces that environment creation so it doesn’t send a suspicious `Runtime.enable` CDP command at the worker level.

---