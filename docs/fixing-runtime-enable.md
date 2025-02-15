The article "How to fix Runtime.Enable CDP detection of Puppeteer, Playwright and other automation libraries?" by Nick Webson, published 6 months ago, discusses a technique used by anti-bot services to detect browser automation tools through the `Runtime.Enable` command in the Chrome DevTools Protocol (CDP). This detection method has been employed by companies like Cloudflare and DataDome.

**Understanding the Detection Technique**

Automation libraries such as Puppeteer, Playwright, and Selenium utilize CDP to communicate with browsers, often invoking the `Runtime.Enable` command to receive events from the browser's runtime domain. This command is essential for obtaining `ExecutionContextId`s of frames, which are necessary for executing JavaScript within pages. However, using `Runtime.Enable` triggers the browser to emit a `Runtime.consoleAPICalled` event, which can be detected with minimal JavaScript, revealing the presence of automation tools.

**Prevalence Among Anti-Bot Services**

The article notes that this detection method is widely adopted. Tests showed that disabling `Runtime.Enable` in Puppeteer and Playwright prevented immediate CAPTCHA challenges on sites protected by services like Cloudflare Turnstile and DataDome, even when using residential IPs. This suggests that major anti-bot companies actively employ this detection technique.

**Testing for CDP Detection**

To assess whether a browser is susceptible to CDP detection, the article recommends several test sites:

- [Brotector](https://kaliiiiiiiiii.github.io/brotector/)
- [Are You a Bot](https://deviceandbrowserinfo.com/are_you_a_bot)
- [Selenium Detector](https://hmaker.github.io/selenium-detector/)

Additionally, Rebrowser offers its own [bot detector](https://bot-detector.rebrowser.net/) that includes this detection test.

**Challenges with Common Workarounds**

Some users attempt to bypass detection by opening DevTools using the `--auto-open-devtools-for-tabs` flag. However, anti-bot scripts can differentiate between genuine DevTools usage and automation by analyzing timing patterns. Moreover, since less than 0.1% of typical users have DevTools open, this approach may inadvertently flag the session as automated.

Another approach involves building a custom version of Chromium that suppresses the `Runtime.consoleAPICalled` event. While this can prevent detection, it introduces unique fingerprinting metrics, making the browser distinguishable from standard versions and potentially leading to other detection issues.

**Overriding the Console Object**

Attempts to override the `console` object, such as redefining `console.debug` and `console.log`, have been explored:

```javascript
console.debug = console.log = {};
```

While this may work on basic test pages, sophisticated anti-bot services can detect such modifications, rendering this method ineffective.

**Proposed Solution**

To address this detection vector, the article introduces a patch for Puppeteer and Playwright that modifies their source code. This patch disables the automatic invocation of `Runtime.Enable` on every frame and instead manually creates contexts with unknown IDs upon frame creation. For executing code, two approaches are suggested:

1. **Creating a New Isolated Context**: Utilizing `Page.createIsolatedWorld` to execute code in a separate context, preventing page scripts from detecting changes via `MutationObserver`. This method, however, restricts access to main context variables and is not applicable to web workers.

2. **Temporarily Enabling Runtime**: Invoking `Runtime.Enable` followed by an immediate `Runtime.Disable` to capture the necessary context ID. This provides full access to the main context but carries a minimal risk of detection during the brief enabled period.

Both methods have been tested and found to be undetectable by services like Cloudflare and DataDome. The patches are available on GitHub: [rebrowser-patches](https://github.com/rebrowser/rebrowser-patches). Users are encouraged to contribute and report issues to keep the patches up to date.

**Monitoring for Detection**

To ensure that automation scripts are not triggering detection mechanisms, developers can listen for the `Runtime.consoleAPICalled` event:

```javascript
page._client.on('Runtime.consoleAPICalled', (message) => {
  console.log('Runtime.consoleAPICalled:', message);
});
```

Alternatively, enabling debug flags can provide insights into CDP events:

```bash
DEBUG="puppeteer:*" node script.js
```

**About Rebrowser**

Rebrowser offers undetectable cloud browsers designed for AI agents, web scraping, and browser automation. Their platform includes features to notify users if their automation tools utilize `Runtime.Enable` or other detectable commands. Interested users can create an account to test the platform and access additional resources.

*Author: Nick Webson, Lead Software Engineer specializing in browser fingerprinting and modern web technologies.* 