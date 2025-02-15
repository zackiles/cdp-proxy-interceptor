## Potential Drawbacks or Flaws with the Stealth Plugin RFC
The RFC makes several assumptions that conflict with how CDP and Playwright actually work. In particular:

### 1. Misunderstanding the Role of Runtime.enable
- **Assumption:** The RFC assumes that intercepting and “faking” a success response for a `Runtime.enable` call is a drop‑in replacement for its real side‑effects.
- **Reality:** In practice, calling `Runtime.enable` does more than simply establish an execution context. It also sets up vital event streams (e.g. for console API calls and exceptions) and synchronizes internal state. Playwright depends on the real, ordered events that the browser sends as a consequence of an actual enablement. Simply intercepting the command and returning a synthetic response can break these expectations or leave out other essential side‑effects.

### 2. Flawed Execution Context Recreation
- **Assumption:** The RFC suggests that by watching for frame or worker events (e.g. `Page.frameAttached`, `Page.frameNavigated`) and then manually creating isolated worlds (or using bindings), one can fully replicate the behavior of an enabled runtime.
- **Reality:** Playwright not only expects a `Runtime.executionContextCreated` event—it also relies on precise matching between the contexts created internally by the browser and its own internal bookkeeping. Faking these events externally can lead to mismatches (for example, in execution context IDs or auxiliary data) and timing issues. Furthermore, the mechanisms used for creating an isolated world or adding bindings are not equivalent to the side‑effects of an actual `Runtime.enable` call. They might work for basic JavaScript execution but could break deeper integrations (such as error logging or debugging support).

### 3. Overlooking Worker/Service Worker Nuances
- **Assumption:** The RFC broadly states that similar logic can be applied to workers by intercepting events like `Target.attachedToTarget`.
- **Reality:** Workers (and service workers) have different lifecycle behaviors and restrictions compared to page frames. For instance, they lack some of the mechanisms available in the main frame (such as `Page.addScriptToEvaluateOnNewDocument`), and their context creation is handled differently. The RFC’s “one‑size‑fits‑all” approach oversimplifies these differences and risks breaking worker support.

### 4. Timing and Ordering Pitfalls
- **Assumption:** The MitM approach assumes that it can arbitrarily drop a `Runtime.enable` command, immediately respond with a mock reply, and then “inject” the corresponding synthetic events, all without disturbing the CDP session’s state.
- **Reality:** CDP is a tightly coupled protocol where the order of messages is critical. Introducing synthetic responses or events in a non‑deterministic order (or with even slight delays) can desynchronize Playwright’s internal state machine. This might lead to subtle bugs that are hard to diagnose, especially as Playwright updates its internal handling of CDP messages.

### 5. Ignoring Potential Fingerprinting Side‑Effects
- **Assumption:** The RFC argues that by not truly enabling the Runtime domain, the browser becomes less detectable.
- **Reality:** Advanced anti‑bot scripts may monitor the overall pattern of CDP activity. If certain expected events (like `Runtime.consoleAPICalled` or the standard lifecycle events of `Runtime.enable`) are missing or “faked,” these anomalies can themselves serve as fingerprinting signals. Moreover, the RFC’s own approach of intercepting and injecting synthetic events might leave its own fingerprint if not implemented with extreme care.

---
