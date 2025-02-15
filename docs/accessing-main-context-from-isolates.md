The article "How to Access Main Context Objects from Isolated Context in Puppeteer & Playwright" by Nick Webson, published 4 months ago, addresses a limitation encountered when using the `alwaysIsolated` mode in the `rebrowser-patches` library. This mode executes all code in a separate isolated JavaScript context, which lacks access to the main context of the page. This poses challenges for scripts that need to interact with objects defined in the main context.

**Understanding the Challenge**

A practical example is provided where a user attempts to detect the loading of the reCAPTCHA script with the following code:

```javascript
await page.waitForFunction(`typeof window.grecaptcha.execute === 'function'`)
```

With the patch applied, this code runs in the isolated context, which doesn't have access to `window.grecaptcha` defined in the main context.

**Proposed Solution: Cross-Context Communication**

To overcome this limitation, the article suggests leveraging the `window.postMessage` API to facilitate communication between the isolated and main contexts. By injecting an event listener into the main context using `page.evaluateOnNewDocument`, scripts running in the isolated context can send messages to the main context to execute desired functions and retrieve results.

**Implementation Steps**

1. **Inject Event Listener into Main Context**: Use `page.evaluateOnNewDocument` to add a `message` event listener that listens for incoming messages from the isolated context. Upon receiving a message, it evaluates the provided script and sends back the result.

    ```javascript
    await page.evaluateOnNewDocument(() => {
      window.addEventListener('message', (event) => {
        if (!event.data.scriptId || event.data.fromMain) return;

        const response = {
          scriptId: event.data.scriptId,
          fromMain: true,
        };
        try {
          response.result = eval(event.data.scriptText);
        } catch (err) {
          response.error = err.message;
        }

        window.postMessage(response);
      });
    });
    ```

2. **Navigate to Target Page**: Navigate to the desired page, ensuring the injected script is in place before the page loads.

    ```javascript
    await page.goto('https://bot-detector.rebrowser.net', { waitUntil: 'load' });
    ```

3. **Set Up Isolated Context Listener and Helper Function**: In the isolated context, add a `message` event listener to handle responses from the main context. Define a helper function, `window.evaluateMain`, to send scripts to the main context for evaluation and return the results.

    ```javascript
    await page.evaluate(() => {
      window.addEventListener('message', (event) => {
        if (!(event.data.scriptId && event.data.fromMain)) return;
        window.dispatchEvent(new CustomEvent(`scriptId-${event.data.scriptId}`, { detail: event.data }));
      });

      window.evaluateMain = (scriptFn) => {
        window.evaluateMainScriptId = (window.evaluateMainScriptId || 0) + 1;
        const scriptId = window.evaluateMainScriptId;
        return new Promise((resolve) => {
          window.addEventListener(`scriptId-${scriptId}`, (event) => {
            resolve(event.detail);
          }, { once: true });

          let scriptText = typeof scriptFn === 'string' ? scriptFn : `(${scriptFn.toString()})()`;
          window.postMessage({ scriptId, scriptText });
        });
      };
    });
    ```

4. **Execute Code in Main Context from Isolated Context**: Utilize the `window.evaluateMain` helper to run code in the main context and retrieve the result.

    ```javascript
    const result = await page.evaluate(() => window.evaluateMain(() => document.getElementsByClassName('div')));
    console.log(result);
    ```
    ```

**Handling Content Security Policy (CSP) Restrictions**

The article notes that using `eval` in the main context may trigger CSP errors, as some pages disallow `eval` for security reasons. While one might consider using `page.setBypassCSP(true)`, this approach is discouraged due to potential detectability. Instead, the article recommends avoiding `eval` by explicitly defining permissible functions and their arguments, thereby adhering to CSP rules.

**Detection Risks**

While this messaging approach is generally effective, the article cautions that sophisticated anti-automation scripts could monitor `window.addEventListener('message', ...)` to detect automation. However, since many legitimate applications and extensions use window messaging, its presence alone isn't a definitive indicator of automation. To mitigate detection risks, developers can obfuscate message properties and ensure their scripts blend seamlessly with typical web applications.

**Conclusion**

By implementing cross-context communication via `window.postMessage`, developers can enable scripts running in isolated contexts to access and interact with objects in the main context. This approach maintains the benefits of isolation—such as evading certain detection mechanisms—while providing the necessary access to main context resources. For testing automation scripts against various detection methods, the article recommends using tools like the [Rebrowser Bot Detector](https://bot-detector.rebrowser.net/).

*Author: Nick Webson, Lead Software Engineer specializing in browser fingerprinting and modern web technologies.* 