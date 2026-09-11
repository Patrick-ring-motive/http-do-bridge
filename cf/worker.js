import {
  DurableObject
} from "cloudflare:workers";
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

class MetaPromise {
  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export class Bridge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiters = new Set();
    this.results = new Map();
    this.workflowCheck = null;

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          transaction_id TEXT PRIMARY KEY,
          transaction_created INTEGER NOT NULL,
          payload TEXT NOT NULL,
          dispatched INTEGER NOT NULL DEFAULT 0,
          response_json TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_transactions_pending
          ON transactions(dispatched, transaction_created)
          WHERE response_json IS NULL;
        UPDATE transactions
          SET dispatched = 0
          WHERE response_json IS NULL;
      `);
    });
  }
  async fetch(request) {
    const handler = this[`${new URL(request.url).pathname}`.slice(1)] || this.request;
    return handler.call(this, request);
  }
  claimPendingTransaction() {
    return this.ctx.storage.transactionSync(() => {
      const pending = this.ctx.storage.sql.exec(`
        SELECT transaction_id, transaction_created, payload
        FROM transactions
        WHERE dispatched = 0 AND response_json IS NULL
        ORDER BY transaction_created, transaction_id
        LIMIT 1
      `).toArray()[0];

      if (!pending) {
        return null;
      }

      this.ctx.storage.sql.exec(
        "UPDATE transactions SET dispatched = 1 WHERE transaction_id = ?",
        pending.transaction_id
      );
      return pending;
    });
  }
  async ensureWorkflowRunning() {
    if (!this.workflowCheck) {
      this.workflowCheck = this.checkAndStartWorkflow();
    }

    try {
      await this.workflowCheck;
    } finally {
      this.workflowCheck = null;
    }
  }
  async checkAndStartWorkflow() {
    const repository = this.env.GITHUB_REPOSITORY;
    const token = this.env.GITHUB_TOKEN;
    const workflow = this.env.GITHUB_WORKFLOW || "waiter.yml";
    const ref = this.env.GITHUB_REF || "main";

    if (!repository || !token) {
      throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN must be configured");
    }

    const encodedRepository = repository
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const encodedWorkflow = encodeURIComponent(workflow);
    const workflowUrl = `https://api.github.com/repos/${encodedRepository}/actions/workflows/${encodedWorkflow}`;
    const headers = {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "client-bridge-worker",
      "X-GitHub-Api-Version": "2026-03-10"
    };

    const runsResponse = await fetch(`${workflowUrl}/runs?per_page=10`, {
      headers
    });
    if (!runsResponse.ok) {
      throw new Error(`GitHub workflow status check failed: ${runsResponse.status}`);
    }

    const {
      workflow_runs: runs = []
    } = await runsResponse.json();
    const activeStatuses = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
    if (runs.some(run => activeStatuses.has(run.status))) {
      return;
    }

    const dispatchResponse = await fetch(`${workflowUrl}/dispatches`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ref
      })
    });
    if (!dispatchResponse.ok) {
      throw new Error(`GitHub workflow dispatch failed: ${dispatchResponse.status}`);
    }
  }
  async listen(request) {
    const pending = this.claimPendingTransaction();
    if (pending) {
      return json(pending);
    }

    const waiter = new MetaPromise();
    this.waiters.add(waiter);
    try {
      return json(await waiter.promise);
    } finally {
      this.waiters.delete(waiter);
    }
  }
  async request(request) {
    const transactionId = request.headers.get("transaction-id") || `transaction-${crypto.randomUUID()}`;
    const payload = (await request.text()) || request.url;
    const transaction = {
      transaction_id: transactionId,
      transaction_created: Date.now(),
      payload
    };

    await this.ensureWorkflowRunning();

    const waiter = this.waiters.values().next().value;

    const inserted = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO transactions
        (transaction_id, transaction_created, payload, dispatched)
       VALUES (?, ?, ?, ?)
       RETURNING transaction_id`,
      transactionId,
      transaction.transaction_created,
      payload,
      waiter ? 1 : 0
    ).toArray().length > 0;

    const stored = this.ctx.storage.sql.exec(
      "SELECT response_json FROM transactions WHERE transaction_id = ?",
      transactionId
    ).toArray()[0];
    if (stored.response_json !== null) {
      return json(JSON.parse(stored.response_json));
    }

    let result = this.results.get(transactionId);
    if (!result) {
      result = new MetaPromise();
      this.results.set(transactionId, result);
    }

    if (inserted && waiter) {
      this.waiters.delete(waiter);
      waiter.resolve(transaction);
    }

    try {
      return json(await result.promise);
    } finally {
      if (this.results.get(transactionId) === result) {
        this.results.delete(transactionId);
      }
    }
  }
  async response(request) {
    const items = await request.json();
    for (const item of items) {
      const transactionId = item?.transaction_id;
      if (!transactionId) {
        continue;
      }

      this.ctx.storage.sql.exec(
        `UPDATE transactions
         SET response_json = ?, dispatched = 1
         WHERE transaction_id = ?`,
        JSON.stringify(item),
        transactionId
      );
      this.results.get(transactionId)?.resolve(item);
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
