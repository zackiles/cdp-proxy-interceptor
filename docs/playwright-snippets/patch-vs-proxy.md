## 1) **Skipping `Runtime.enable`**

### What the Patch Does
- The patch conditionally **never sends** `Runtime.enable` to the browser in stealth modes (`addBinding` or `alwaysIsolated`), preventing anti-bot scripts from detecting that CDP command.

### How the Plugin Replicates It
- In the plugin’s `onRequest` method:
  ```ts
  if (request.method === 'Runtime.enable') {
    this.sessionsRuntimeEnabled.set(request.sessionId, true)
    // Send a mock success back to the client (so Playwright thinks it succeeded)
    return null // do not forward to the browser
  }
  ```
- The plugin also sends a **mock response** to Playwright, so Playwright believes `Runtime.enable` succeeded even though the browser never sees the call.

### Accuracy Check
- **Effectively replicates** the patch’s approach of removing any real `Runtime.enable` call.  
- The plugin’s internal `sessionsRuntimeEnabled` map is **only** to track whether Playwright called `Runtime.enable` (from the client’s perspective). It doesn’t inform Playwright of anything; it just helps the plugin know when to serve synthetic contexts.

---

## 2) **Creating Synthetic Execution Contexts**

### What the Patch Does
- The patch “fakes” `Runtime.executionContextCreated` events each time a new frame or worker context is required.  
- Normally, after `Runtime.enable`, the browser would generate these events automatically. The patch replaces them with manual calls to `__re__emitExecutionContext(...)` whenever needed.

### How the Plugin Replicates It
- **For frames**:
  ```ts
  if (!this.frameContexts.has(frameId)) {
    const contextId = await this.createIsolatedContext(sessionId, frameId)
    this.frameContexts.set(frameId, contextId)
    await this.emitSyntheticContext(sessionId, contextId, frameId, true)
  }
  ```
- **For workers**:
  ```ts
  if (!this.workerContexts.has(workerId)) {
    const contextId = await this.createIsolatedContext(sessionId, workerId)
    this.workerContexts.set(workerId, contextId)
    await this.emitSyntheticContext(sessionId, contextId, workerId, false)
  }
  ```
- Internally, it calls `Page.createIsolatedWorld` to fetch a new `executionContextId`, then emits a **synthetic** `Runtime.executionContextCreated` event to fool Playwright into thinking it arrived from the real runtime domain.

### Accuracy Check
- **Closely mirrors** the patch’s stealth approach: no real runtime domain is enabled, but Playwright sees newly created contexts.  
- The plugin’s approach is always “isolated world,” paralleling the patch’s `"alwaysIsolated"` mode rather than the “addBinding” main-world approach.

---

## 3) **Frame & Worker Lifecycle Handling**

### What the Patch Does
- For frames, the patch either calls `__re__emitExecutionContext` during certain navigation or uses specialized logic in `frames.ts`.  
- For workers, it similarly sidesteps `Runtime.enable` and forges a custom context ID when each worker appears (in `crPage.ts` / `crServiceWorker.ts`).

### How the Plugin Replicates It
- **Frames**: Intercepts `Page.frameAttached` / `Page.frameNavigated`. If it hasn’t yet created a context, it calls `createIsolatedContext(...)` and emits the synthetic event.  
- **Workers**: Intercepts `Target.attachedToTarget` for any `worker` or `service_worker` type, creates an isolated context, emits a synthetic `Runtime.executionContextCreated`.  
- Cleans up contexts on `Page.frameDetached` or `Target.detachedFromTarget`.

### Accuracy Check
- This matches the patch’s coverage of frames and workers quite well.  
- The biggest difference is that the patch can do random-binding logic to mimic a main-world context. The plugin unifies everything under “isolated world” usage.

---

## 4) **Clearing Execution Contexts (e.g. `Runtime.executionContextsCleared`)**

### What the Patch Does
- After certain frame navigations, the patch calls:
  ```js
  crSession.emit('Runtime.executionContextsCleared')
  ```
  This signals to Playwright that old contexts should be discarded.

### How the Plugin Replicates It
- The plugin:
  - **Does not** emit `Runtime.executionContextsCleared`.  
  - Instead, it simply removes the context ID from `frameContexts` or `workerContexts` upon detach events.

### Accuracy Check
- The plugin’s simpler cleanup logic often works fine: whenever a frame or worker fully detaches, the context is removed.  
- If a site or script relies specifically on `Runtime.executionContextsCleared` (e.g. advanced internal state tracking), that event won’t be there. Typically, most usage scenarios won’t need that exact event, so it’s rarely a deal-breaker.

---

## 5) **Random Binding vs. Isolated World**

### What the Patch Does
- **`addBinding` mode**: The patch uses `Runtime.addBinding` plus a random name to get a real “main-world” context ID without calling `Runtime.enable`.  
- **`alwaysIsolated` mode**: Strictly calls `Page.createIsolatedWorld` and makes that appear as the main or utility world.

### How the Plugin Replicates It
- The plugin:
  ```ts
  method: 'Page.createIsolatedWorld',
  params: {
    frameId,
    worldName: `__MITM_InvisibleWorld_${frameId}`,
    grantUniveralAccess: true,
  }
  ```
- It never attempts `Runtime.addBinding` or random binding injection for a real main world.  
- So it effectively **always** uses the “isolated world” approach.

### Accuracy Check
- The plugin’s approach is **very close** to the patch’s “alwaysIsolated” mode.  
- It omits the “random binding” logic entirely, which is only critical if you specifically need to run code in the **real** main world (e.g., to access window-level objects that can’t be seen in an isolated world).

---

## 6) **Optional vs. Mandatory Stealth**

### What the Patch Does
- `REBROWSER_PATCHES_RUNTIME_FIX_MODE` can be:
  - `'0'`: No stealth (calls `Runtime.enable` normally).  
  - `'addBinding'`: Uses the random binding approach.  
  - `'alwaysIsolated'`: Uses an isolated world.  
- Lets you dynamically pick the mode or disable patches.

### How the Plugin Replicates It
- Once the plugin is loaded, **it always** intercepts `Runtime.enable` and never sends it to the browser. There’s no toggle or environment variable to revert to normal usage.

### Accuracy Check
- If you only want stealth, this is fine.  
- If you sometimes need the standard behavior, the plugin lacks a built-in toggle.

---

## 7) **Marking New Contexts as `isDefault`**

### What the Patch Does
- In “alwaysIsolated” mode, the patch sets `isDefault = true` in the `Runtime.executionContextCreated` event’s `auxData`. This tricks Playwright into thinking the new isolated world is effectively the main world.

### How the Plugin Replicates It
- The plugin’s `emitSyntheticContext` calls:
  ```ts
  await this.emitClientEvent(sessionId, {
    method: 'Runtime.executionContextCreated',
    params: {
      context: {
        id: contextId,
        auxData: {
          frameId,
          isDefault,
        },
      },
    },
    sessionId,
  })
  ```
- For frames, it passes `isDefault = true`, essentially telling Playwright, “This is your default (main) world.”

### Accuracy Check
- This is consistent with the patch’s approach for an isolated world disguised as the default.  
- **Potential side effect**: If code needs actual main-world global objects, they won’t be there in this disguised isolated world.

---

## Conclusion (Are There Critical Mistakes?)

- **No Fatal Errors**: The plugin successfully **skips `Runtime.enable`** and **emits synthetic contexts** for frames/workers. This matches the key stealth principle of the patch.
- **Differences**:
  1. **`Runtime.executionContextsCleared`** is not emitted, though that typically won’t break everyday usage.  
  2. **Always using an isolated world**—the patch has an alternative “addBinding” approach that the plugin lacks. If your automation relies on real main-world script injection, you’ll need to add that.  
  3. **No toggling**: The patch can revert to normal “unpatched” mode; the plugin is always stealth once active.  
- **Marking new contexts as `isDefault`** can sometimes confuse scripts expecting to see real main-world objects, but for many stealth use cases, that’s exactly what you want.
  
**Overall**: The plugin does a **good job** replicating the patch’s “alwaysIsolated” style. It has no obvious *critical* mistakes for typical stealth usage. If your workflow requires main-world injection, clearing events, or toggling behavior, you’d need to further extend or modify the plugin.