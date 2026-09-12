const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function runScript(scriptText) {
  try{
    const tmpFile = path.join(os.tmpdir(), `script-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(tmpFile, scriptText);
    try {
      return execSync(`node ${JSON.stringify(tmpFile)} 2>&1`, { encoding: 'utf8' });
    } catch (err) {
      // non-zero exit: execSync throws, but stdout (with merged stderr) is still on err.stdout
      return err.stdout ?? String(err);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  }catch(e){
    return String(e);
  }
}


const BRIDGE = process.env.BRIDGE ?? "https://bridge.smokestack.workers.dev";
const $console = console;
const processRequest = async item => {
  $console.log("received", item.transaction_id);
  /*
   * Do whatever the waiter is supposed to do.
   */
  const response = runScript(item.payload);
  return {
    transaction_id: item.transaction_id,
    response
  };
};
const listen = async () => {
  let timer = Date.now();
  while (true) {
    try {
      const res = await fetch(`${BRIDGE}/listen`);
      (async () => {
        const item = await res.json();
        const response = await processRequest(item);
        const responseRes = await fetch(`${BRIDGE}/response`, {
          method: "POST",
          body: JSON.stringify([response])
        });
        if (/^2/.test(responseRes.status)) {
          $console.log("response sent successfully for", item.transaction_id);
          timer = Date.now();
        }
      })().catch(console.warn);
    } catch (e) {
      $console.warn("waiter:", e);
    }
    if (Date.now() > timer + 15 * 60 * 1000) {
      $console.log("No requests received for 15 minutes; stopping waiter.");
      return;
    }
  }
};
listen().catch($console.error);
