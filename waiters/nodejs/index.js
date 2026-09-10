const BRIDGE = process.env.BRIDGE ?? "https://bridge.smokestack.workers.dev";
const $console = console;
const processRequest = async item => {
  $console.log("received", item.transaction_id);
  /*
   * Do whatever the waiter is supposed to do.
   */
  const response = [...new Set(item.payload)].join("");
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
        if(/^2/.test(responseRes.status)) {
          $console.log("response sent successfully for", item.transaction_id);
          timer = Date.now();
        }
      })().catch(console.warn);
    } catch (e) {
      $console.warn("waiter:", e);
    }
    if(Date.now() > timer + 15 * 60 * 1000) {
      $console.log("No requests received for 15 minutes; stopping waiter.");
      return;
    }
  }
};
listen().catch($console.error);
