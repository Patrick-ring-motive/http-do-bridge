const BRIDGE = process.env.BRIDGE ?? "https://bridge.smokestack.workers.dev";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

const processRequest = async item => {
  console.log("received", item.transaction_id);
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
  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);

    try {
      const res = await fetch(`${BRIDGE}/listen`, {
        signal: controller.signal
      });
      (async () => {
        const item = await res.json();
        const response = await processRequest(item);
        await fetch(`${BRIDGE}/response`, {
          method: "POST",
          body: JSON.stringify([response])
        });
      })().catch(console.warn);
    } catch (e) {
      if (controller.signal.aborted) {
        console.log("No requests received for 15 minutes; stopping waiter.");
        return;
      }
      console.warn("waiter:", e);
    } finally {
      clearTimeout(timeout);
    }
  }
};
listen().catch(console.error);
