The article **"How New Headless Chrome & the CDP Signal Are Impacting Bot Detection"** by **Antoine Vastel** discusses how recent changes in **Headless Chrome** and the **Chrome DevTools Protocol (CDP)** have affected bot detection strategies. The core of the article revolves around how **automation frameworks** like **Puppeteer, Playwright, and Selenium** interact with browsers through CDP, and how anti-bot mechanisms can leverage this for detection.

---

## **Evolution of Headless Chrome and Bot Detection Challenges**

In earlier versions, **Headless Chrome** had distinct behaviors that allowed for easy identification. However, recent Chrome updates have significantly **reduced the fingerprinting differences** between Headless and regular Chrome, making detection much more challenging.

- Attackers can now **spoof** automation fingerprints by:
  - Modifying the **user agent** with `page.setUserAgent()`
  - Disabling the `navigator.webdriver` property using `--disable-blink-features=AutomationControlled`
  - Customizing `window.Object.getOwnPropertyDescriptors()` to mimic real user behavior

This evolution forces anti-bot solutions to adopt **more sophisticated detection mechanisms**, particularly those focusing on **CDP signals**.

---

## **Using CDP to Detect Automation**

The **Chrome DevTools Protocol (CDP)** is a powerful interface used by debugging tools and **automation frameworks**. Many **bot frameworks** leverage CDP to control browsers programmatically.

One of the most **reliable** detection techniques relies on **monitoring CDP commands**, particularly **Runtime.enable**, which triggers `Runtime.consoleAPICalled` when activated.

**Detection Method: Monitoring CDP Serialization of Objects**

By observing how errors are **serialized** during CDP interactions, detection scripts can identify automation frameworks:

### **CDP-Based Detection Script**
```javascript
let detected = false;
const e = new Error();
Object.defineProperty(e, 'stack', {
  get() {
    detected = true;
  }
});
console.debug(e);

if (detected) {
  console.warn("CDP Runtime Domain Detected: Automation likely.");
} else {
  console.log("No CDP activity detected.");
}
```
**How It Works:**
1. **Creates an error object (`new Error()`)**
2. **Modifies its `.stack` property** to detect **CDP-triggered serialization**
3. **Logs the error using `console.debug(e)`**
4. **If `detected` becomes `true`, it indicates that `Runtime.enable` was used**, suggesting an **automated environment**.

---

## **More Advanced Bot Detection: Full Selenium & Playwright Detection Script**
The script below **expands on CDP-based detection** to **identify automation frameworks** like **Puppeteer, Playwright, and Selenium**.

### **Comprehensive Automation Detection Script**
```javascript
const Document_querySelector = Document.prototype.querySelector;
const Document_querySelectorAll = Document.prototype.querySelectorAll;

class SeleniumDetectionTest {
    constructor(name, desc) {
        this.name = name;
        this.desc = desc;
    }
    getDescriptionHTML() {
        return `<div class="test-detection"><strong>${this.name}</strong><div>${this.desc}</div></div>`;
    }
}

// Detects CDP Runtime domain activation
class CDPRuntimeDomainTest extends SeleniumDetectionTest {
    test(window) {
        let trapped = false;
        const e = new Error();
        Object.defineProperty(e, 'stack', {
            get: function() {
                trapped = true;
                return '';
            }
        });
        console.debug(e);
        return trapped;
    }
}

// Detects Puppeteer and Selenium execution via `executeScript`
class ExecuteScriptTest extends SeleniumDetectionTest {
    constructor(name, desc) {
        super(name, desc);
        this.token = Math.random().toString().substring(2);
        this._hookExecuteScript(window);
    }
    _hookExecuteScript(window) {
        const self = this;
        Object.defineProperty(window, 'token', {
            get: function() {
                try {
                    null[0];
                } catch(e) {
                    self.callStack = e.stack.split('\n');
                }
                return self.token;
            }
        });
    }
}

(function() {
    const executeScriptTest = new ExecuteScriptTest(
        'execute-script-detection',
        'Detects <pre>driver.execute_script()</pre> usage'
    );
    const activeTests = [
        executeScriptTest,
        new CDPRuntimeDomainTest('devtools-console', 'Detects CDP Runtime Domain (automation framework detected)'),
    ];
    
    window.addEventListener('DOMContentLoaded', function() {
        const detections = activeTests.filter(test => test.test(window));
        if (detections.length > 0) {
            console.warn("⚠️ Automation detected! Possible Selenium/Puppeteer usage.");
        } else {
            console.log("✅ No automation detected.");
        }
    });
})();
```

---

## **Detection Summary**
This detection framework **actively looks for automation indicators** based on **CDP activity** and **Selenium/Puppeteer runtime interactions**.

- **CDP Runtime Domain Detection**
- **Puppeteer/Selenium Execution (`execute_script`)**
- **Error Serialization Monitoring**
- **WebDriver Fingerprints**

These **techniques are actively used by anti-bot services** to differentiate between **real users and automated bots**.

---

### **Final Thoughts**
- **As Headless Chrome improves**, bot detection techniques must **evolve**.
- **CDP-based signals** provide a **strong** detection vector.
- The **obfuscation techniques used by bots** continue to improve, requiring **multi-layered detection** combining **behavioral analysis, browser fingerprinting, and request monitoring**.

**Author: Antoine Vastel, VP of Research at DataDome**