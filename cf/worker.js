import { DurableObject } from "cloudflare:workers";
const json = (body, init = {}) => {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...init.headers
    }
  });
};
export class Bridge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiters = new Set();
    this.transactions = new Map();
  }
  async fetch(request) {
    return this[`${new URL(request.url).pathname}`.slice(1)](request);
  }
  async listen(request) {
    const waiter = {
      resolve: null,
      reject: null
    };
    waiter.promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    this.waiters.add(waiter);
    try {
      const result = await waiter.promise;
      return json(result);
    } finally {
      this.waiters.delete(waiter);
    }
  }
  async request(request) {
    const transactionId = request.headers.get("transaction-id") || `transaction-${crypto.randomUUID()}`;
    const payload = await request.text();
    const existing = this.transactions.get(transactionId);
    if (existing) {
      return json(await existing.promise);
    }
    const transaction = {
      transaction_id: transactionId,
      transaction_created: Date.now(),
      payload
    };
    const result = {
      resolve: null,
      reject: null
    };
    result.promise = new Promise((resolve, reject) => {
      result.resolve = resolve;
      result.reject = reject;
    });
    this.transactions.set(transactionId, result);
    try {
      const waiter = this.waiters.values().next().value;
      this.waiters.delete(waiter);
      waiter.resolve(transaction);
      const response = await result.promise;
      return json(response);
    } finally {
      this.transactions.delete(transactionId);
    }
  }
  async response(request) {
    const items = await request.json();
    for (const item of items) {
      this?.transactions?.get?.(item?.transaction_id)?.resolve?.(item);
    }
    return new Response(null, {
      status: 204
    });
  }
}
export default {
  async fetch(request, env) {
    const id = env.BRIDGE.idFromName("default");
    const bridge = env.BRIDGE.get(id);
    return bridge.fetch(request);
  }
};
