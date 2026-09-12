ObjC.import("Foundation");

function run(command, args) {
  const task = $.NSTask.alloc.init;
  const output = $.NSPipe.pipe;

  task.launchPath = command;
  task.arguments = args;
  task.standardOutput = output;
  task.standardError = output;

  try {
    task.launch;
    const data = output.fileHandleForReading.readDataToEndOfFile;
    task.waitUntilExit;
    return {
      status: Number(task.terminationStatus),
      output: ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || ""
    };
  } catch (error) {
    return { status: -1, output: String(error) };
  }
}

function httpRequest(method, url, body) {
  const request = $.NSMutableURLRequest.requestWithURL($.NSURL.URLWithString(url));
  request.HTTPMethod = method;
  request.timeoutInterval = 910;
  if (body !== undefined) {
    request.setValueForHTTPHeaderField("application/json", "Content-Type");
    request.HTTPBody = $.NSString.stringWithString(JSON.stringify(body))
      .dataUsingEncoding($.NSUTF8StringEncoding);
  }

  const response = Ref();
  const error = Ref();
  const data = $.NSURLConnection.sendSynchronousRequestReturningResponseError(
    request,
    response,
    error
  );
  if (!data) {
    throw new Error(error[0] ? ObjC.unwrap(error[0].localizedDescription) : "WebDriver request failed");
  }

  const status = Number(response[0].statusCode);
  const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || "";
  const result = text ? JSON.parse(text) : { value: null };
  if (status < 200 || status >= 300 || result.value?.error) {
    throw new Error(result.value?.message || `WebDriver returned HTTP ${status}`);
  }
  return result.value;
}

class SafariWebDriver {
  constructor(port) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.driver = $.NSTask.alloc.init;
    this.driver.launchPath = "/usr/bin/safaridriver";
    this.driver.arguments = ["--port", String(port)];
    this.driver.standardOutput = $.NSPipe.pipe;
    this.driver.standardError = this.driver.standardOutput;
    this.driver.launch;

    let lastError;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const value = httpRequest("POST", `${this.baseUrl}/session`, {
          capabilities: { alwaysMatch: { browserName: "safari" } }
        });
        this.sessionId = value.sessionId;
        httpRequest("POST", `${this.baseUrl}/session/${this.sessionId}/timeouts`, {
          script: 900000
        });
        return;
      } catch (error) {
        lastError = error;
        $.NSThread.sleepForTimeInterval(0.1);
      }
    }
    this.driver.terminate;
    throw lastError || new Error("Safari WebDriver failed to start");
  }

  fetch(url, options) {
    return httpRequest(
      "POST",
      `${this.baseUrl}/session/${this.sessionId}/execute/async`,
      {
        script: `
          const url = arguments[0];
          const options = arguments[1];
          const done = arguments[arguments.length - 1];
          fetch(url, options)
            .then(async response => done({
              ok: response.ok,
              status: response.status,
              body: await response.text()
            }))
            .catch(error => done({ error: String(error) }));
        `,
        args: [url, options || {}]
      }
    );
  }

  close() {
    if (this.sessionId) {
      try {
        httpRequest("DELETE", `${this.baseUrl}/session/${this.sessionId}`);
      } catch (_) {}
    }
    if (this.driver.running) {
      this.driver.terminate;
    }
  }
}

function runScript(scriptText) {
  const fileManager = $.NSFileManager.defaultManager;
  const tmpFile = ObjC.unwrap($.NSTemporaryDirectory()) +
    "script-" + ObjC.unwrap($.NSUUID.UUID.UUIDString) + ".js";

  try {
    const text = $.NSString.stringWithString(String(scriptText));
    const wroteFile = text.writeToFileAtomicallyEncodingError(
      tmpFile,
      true,
      $.NSUTF8StringEncoding,
      null
    );
    if (!wroteFile) {
      return "Unable to write temporary script: " + tmpFile;
    }
    return run("/usr/bin/osascript", ["-l", "JavaScript", tmpFile]).output;
  } catch (error) {
    return String(error);
  } finally {
    fileManager.removeItemAtPathError(tmpFile, null);
  }
}

const environment = $.NSProcessInfo.processInfo.environment;
const bridgeValue = environment.objectForKey("BRIDGE");
const BRIDGE = bridgeValue ? ObjC.unwrap(bridgeValue) : "https://bridge.smokestack.workers.dev";

function log() {
  console.log(Array.prototype.join.call(arguments, " "));
}

function processRequest(item) {
  log("received", item.transaction_id);
  return {
    transaction_id: item.transaction_id,
    response: runScript(item.payload)
  };
}

function listen() {
  let timer = Date.now();
  const webDriver = new SafariWebDriver(4444);

  try {
    while (true) {
      try {
        const listenResult = webDriver.fetch(BRIDGE + "/listen/jxa");
        if (listenResult.error || !listenResult.ok) {
          throw new Error(listenResult.error || `Listen returned HTTP ${listenResult.status}`);
        }

        const item = JSON.parse(listenResult.body);
        const response = processRequest(item);
        const responseResult = webDriver.fetch(BRIDGE + "/response", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([response])
        });

        if (responseResult.error || !responseResult.ok) {
          throw new Error(responseResult.error || `Response returned HTTP ${responseResult.status}`);
        }

        log("response sent successfully for", item.transaction_id);
        timer = Date.now();
      } catch (error) {
        console.log("waiter: " + String(error));
      }

      if (Date.now() > timer + 15 * 60 * 1000) {
        log("No requests received for 15 minutes; stopping waiter.");
        return;
      }
    }
  } finally {
    webDriver.close();
  }
}

listen();
