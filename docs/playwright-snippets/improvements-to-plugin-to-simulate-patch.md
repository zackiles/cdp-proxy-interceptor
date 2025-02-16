# Improvements to the Plugin That Would Better Simulate the Patch

## 1) **Implement the “addBinding” Mode to Recreate Main-World Context Access**

- **Current Issue**:  
  The plugin always uses `Page.createIsolatedWorld`, which mimics the patch’s “alwaysIsolated” mode. However, the patch also supports an “addBinding” mode that injects a random binding to capture the real main-world context. This is necessary when scripts need access to main-world objects (e.g. for reCAPTCHA detection).

- **Changes to Make**:  
  - **Generate a Random Binding Name**:  
    Create a random binding name (e.g. by generating a random string similar to the patch) and use it in a call to `Runtime.addBinding`.  
  - **Inject a Script via `Page.addScriptToEvaluateOnNewDocument`**:  
    Send a command to add a script that listens for a custom event using the generated binding name. For example:  
    ```js
    {
      method: 'Page.addScriptToEvaluateOnNewDocument',
      params: {
        source: `document.addEventListener('${randomName}', e => self['${randomName}'](e.detail.frameId))`,
        runImmediately: true,
      }
    }
    ```  
  - **Trigger the Binding**:  
    After creating an isolated world (via `Page.createIsolatedWorld`), dispatch a custom event in the main world that calls the binding:  
    ```js
    {
      method: 'Runtime.evaluate',
      params: {
        expression: `document.dispatchEvent(new CustomEvent('${randomName}', { detail: { frameId: '${frameId}' } }))`,
        contextId: <isolatedContextId>,
      }
    }
    ```  
  - **Intercept the `Runtime.bindingCalled` Event**:  
    Wait for the binding call that carries the correct frameId and extract the returned `executionContextId`.  
  - **Emit Synthetic Context**:  
    With the acquired main-world context ID, emit a synthetic `Runtime.executionContextCreated` event with `auxData: { frameId, isDefault: true }` to the client to fully mimic the patch’s “addBinding” behavior.

---

## 2) **Replicate “Runtime.executionContextsCleared” on Frame Navigations**

- **Current Issue**:  
  The plugin currently only cleans up its internal context maps on frame or worker detach events, but it does not explicitly emit the `Runtime.executionContextsCleared` event that the patch uses to reset Playwright’s internal state on navigation commits.

- **Changes to Make**:  
  - Detect navigation or commit events (e.g. in response to `Page.frameNavigated` or a specific “commit” lifecycle event).  
  - Emit a synthetic event with:  
    ```js
    {
      method: 'Runtime.executionContextsCleared',
      params: {},
      sessionId: <the affected sessionId>
    }
    ```  
  - This tells Playwright that all previous contexts are cleared and new ones will be issued.  
  - Ensure that after emitting this event, the plugin’s logic creates and sends a fresh `Runtime.executionContextCreated` event for that frame/worker.

---

## 3) **Emit or Filter Short, Non-JSON Binding Payloads**

- **Current Issue**:  
  The patch includes logic to ignore binding payloads that are simple strings (i.e. not valid JSON) because they are part of the ephemeral binding process.  
- **Changes to Make**:  
  - In the message-handling logic for binding events (for example, when processing `Runtime.bindingCalled`), add a check:  
    ```js
    if (!payload || !payload.includes('{')) {
      // Ignore this ephemeral binding payload.
      return;
    }
    ```  
  - This ensures that these non-JSON payloads are not forwarded or misinterpreted by Playwright.

---

## 4) **Ensure Worker Handling Matches the Patch’s Behavior**

- **Current Issue**:  
  While the plugin currently intercepts worker events and creates an isolated world, the patch differentiates between workers in “addBinding” and “alwaysIsolated” modes.
- **Changes to Make**:  
  - In “addBinding” mode for workers:  
    - Instead of only calling `Page.createIsolatedWorld`, trigger a `Runtime.evaluate` to call the binding (similar to frames) because workers do not support `Page.addScriptToEvaluateOnNewDocument`.  
    - Then, intercept the binding call to obtain the main-world context ID and emit the synthetic `Runtime.executionContextCreated` event.  
  - In “alwaysIsolated” mode (if you choose to support both internally), maintain your current logic.

---

## 5) **Replicate the Utility World / Binding Name Logic from the Patch**

- **Current Issue**:  
  The patch uses environment variables (like `REBROWSER_PATCHES_UTILITY_WORLD_NAME`) to determine the naming of the utility or main world contexts.
- **Changes to Make**:  
  - Read and honor an environment variable (or plugin configuration) for the utility world name. For now, that can just be a constant at the top of the plugin code a user can edit.
  - Use this name when calling `Page.createIsolatedWorld` or when configuring the binding (if in “addBinding” mode).  
  - This ensures the same naming conventions and behaviors as the patch, minimizing fingerprint differences.

---

## Final Consolidation

To fully mimic the patch’s behavior so that the Playwright experience is seamlessly identical whether using the patch or the plugin, update your plugin as follows:

- **Implement “addBinding” Mode**:  
  - Generate random binding names.  
  - Use `Runtime.addBinding` and inject a script with `Page.addScriptToEvaluateOnNewDocument` that listens for a custom event in the main world.  
  - Dispatch a custom event in the isolated context to trigger the binding and capture the main-world `executionContextId`.  
  - Emit the synthetic `Runtime.executionContextCreated` event with `isDefault: true`.

- **Emit `Runtime.executionContextsCleared` on Navigation**:  
  - Listen for navigation/commit events and emit this event with the correct session ID to force Playwright to clear stale contexts.

- **Filter Short Binding Payloads**:  
  - Add logic to ignore binding payloads that are mere strings (non-JSON) to prevent misinterpretation.

- **Worker Handling**:  
  - For workers in “addBinding” mode, mimic the binding process via `Runtime.evaluate` to trigger a binding call and capture the main-world context; for “alwaysIsolated,” continue with the isolated world approach.

- **Utility World Naming**:  
  - Incorporate environment variable logic for naming worlds (e.g. `REBROWSER_PATCHES_UTILITY_WORLD_NAME`) to match the patch exactly.

Implementing these changes will ensure that every CDP message, synthetic event, and context management behavior in your plugin matches the patch. This will yield a seamless Playwright experience regardless of whether the patch or the plugin is used.
