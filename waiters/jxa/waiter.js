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
      const listenResult = run("/usr/bin/curl", ["--silent", "--show-error", "--fail", BRIDGE + "/listen"]);
      if (listenResult.status !== 0) {
        throw new Error(listenResult.output);
      }

      const item = JSON.parse(listenResult.output);
      const response = processRequest(item);
      const responseResult = run("/usr/bin/curl", [
        "--silent",
        "--show-error",
        "--output", "/dev/null",
        "--write-out", "%{http_code}",
        "--request", "POST",
        "--header", "Content-Type: application/json",
        "--data-binary", JSON.stringify([response]),
        BRIDGE + "/response"
      ]);

      if (responseResult.status === 0 && /^2/.test(responseResult.output)) {
        log("response sent successfully for", item.transaction_id);
        timer = Date.now();
      } else {
        throw new Error(responseResult.output);
      }
    } catch (error) {
      console.log("waiter: " + String(error));
    }

    if (Date.now() > timer + 15 * 60 * 1000) {
      log("No requests received for 15 minutes; stopping waiter.");
      return;
    }
  }
}

listen();
