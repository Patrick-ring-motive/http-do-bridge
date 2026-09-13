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

function runScript(scriptText) {
  const scriptPath = path.join(os.tmpdir(), `windbg-${randomUUID()}.js`);
  const target = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe");

  try {
    fs.writeFileSync(scriptPath, scriptText, "utf8");
    const result = spawnSync("cdb.exe", [
      "-lines",
      "-c", `.scriptrun ${scriptPath};q`,
      target
    ], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true
    });

    if (result.error) {
      throw result.error;
    }
    return `${result.stdout || ""}${result.stderr || ""}`;
  } catch (error) {
    return String(error);
  } finally {
    fs.rmSync(scriptPath, {
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
      const item = JSON.parse(await httpRequest("GET", "/listen/cdb"));
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
