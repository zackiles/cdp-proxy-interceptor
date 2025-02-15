The article "Content Scripts" on the Chrome Developers website provides an in-depth look at content scripts in Chrome extensions, focusing on their capabilities, isolation from web pages, and methods for communication between content scripts and the host page.

**Understanding Content Scripts**

Content scripts are JavaScript or CSS files that run in the context of web pages. They can read and modify the DOM of the web pages the browser visits, enabling extensions to interact with web content directly. However, due to their isolated execution environment, content scripts do not have direct access to JavaScript variables or functions defined by the web page or other extensions.

**Communication Between Content Scripts and the Host Page**

To facilitate interaction between content scripts and the host page, developers can use the `window.postMessage` API, which allows for safe message passing between the two contexts. This method enables content scripts to send messages to and receive messages from the web page, enabling a two-way communication channel.

**Implementing Message Passing**

Here's an example of how to set up communication between a content script and a web page using `window.postMessage`:

1. **In the Web Page**: Add an event listener to handle messages from the content script.

    ```javascript
    window.addEventListener("message", (event) => {
      // We only accept messages from ourselves
      if (event.source !== window) return;

      if (event.data.type && (event.data.type === "FROM_CONTENT_SCRIPT")) {
        console.log("Content script said: " + event.data.text);
      }
    }, false);
    ```

2. **In the Content Script**: Send a message to the web page.

    ```javascript
    window.postMessage({ type: "FROM_CONTENT_SCRIPT", text: "Hello from the content script!" }, "*");
    ```

In this setup, the content script sends a message to the web page, which listens for `message` events and processes messages of the specified type. This approach maintains the isolation of the content script while enabling necessary interactions with the web page.

For more detailed information, refer to the [Content Scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#host-page-communication) documentation on the Chrome Developers website. 