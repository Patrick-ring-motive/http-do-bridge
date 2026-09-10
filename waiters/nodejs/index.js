const BRIDGE = process.env.BRIDGE ?? "https://bridge.smokestack.workers.dev";
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
    try {
      const res = await fetch(`${BRIDGE}/listen`);
      (async () => {
        const item = await res.json();
        const response = await processRequest(item);
        await fetch(`${BRIDGE}/response`, {
          method: "POST",
          body: JSON.stringify([response])
        });
      })().catch(console.warn);
    } catch (e) {
      console.warn("waiter:", e);
    }
  }
};
listen().catch(console.error);
