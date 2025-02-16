# TODOs

- Implement the new logger.ts class across the codebase
- Manually review the user experience of importing this as a library and improve it where needed. For example, in scnearios where it's important and the user doesn't bring their own browser, what should be the best way to use or implement the `install-chromium.ts` script?
- Add a flag or config value that writes the history and ordering of the Playwright commands used in a given session to disk for analysis, allowing users to see what raw CDP commands their Playwright scripts execute. The logs should be structured.
- Expose a part of the plugin interface (variable/function/constructor) that allows plugins to provide a way for them to provide a "matching" function that the determines what the types of messages or events the plugin should receive. Could be as simple as a glob, or something more advanced like a custom function that can be called with metadata on the message or event and which the plugin can return true/false on if it's a match for being handled.
- Add `priority` field to plugin interface where a lower nmber equals a higher execution priority when multiple plugins are used.
- Users shouldn't need Deno, provide a native and platform agbostic build of the proxy with `Deno compile`.
- Introduce a proper ci/cd and build workflow with Github actions along with proper versioning.
