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
  const statusMarker = "\n__HTTP_STATUS__:";
  const args = [
    "--silent",
    "--show-error",
    "--max-time", "910",
    "--request", method,
    "--write-out", statusMarker + "%{http_code}"
  ];

  if (body !== undefined) {
    args.push(
      "--header", "Content-Type: application/json",
      "--data-binary", JSON.stringify(body)
    );
  }
  args.push(url);

  const result = run("/usr/bin/curl", args);
  const markerIndex = result.output.lastIndexOf(statusMarker);
  const responseBody = markerIndex === -1
    ? result.output
    : result.output.slice(0, markerIndex);
  const status = markerIndex === -1
    ? 0
    : Number(result.output.slice(markerIndex + statusMarker.length).trim());

  if (result.status !== 0) {
    throw new Error(`curl exited with ${result.status}: ${responseBody}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Bridge returned HTTP ${status}: ${responseBody}`);
  }
  return responseBody;
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
  while (true) {
    try {
      const item = JSON.parse(httpRequest("GET", BRIDGE + "/listen/jxa"));
      const response = processRequest(item);
      httpRequest("POST", BRIDGE + "/response", [response]);

      log("response sent successfully for", item.transaction_id);
      timer = Date.now();
    } catch (error) {
      console.log("waiter: " + String(error));
      $.NSThread.sleepForTimeInterval(1);
    }

    if (Date.now() > timer + 15 * 60 * 1000) {
      log("No requests received for 15 minutes; stopping waiter.");
      return;
    }
  }
}

listen();
