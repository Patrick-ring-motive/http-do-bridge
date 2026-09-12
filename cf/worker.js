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

class MetaPromise{
  constructor(){
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export class Bridge extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiters = new Map([
      ["nodejs", new Set()],
      ["jxa", new Set()]
    ]);
    this.results = new Map();
    this.workflowChecks = new Map();

    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
          transaction_id TEXT PRIMARY KEY,
          transaction_created INTEGER NOT NULL,
          payload TEXT NOT NULL,
          runner TEXT NOT NULL DEFAULT 'nodejs',
          dispatched INTEGER NOT NULL DEFAULT 0,
          response_json TEXT
        );
      `);
      const columns = this.ctx.storage.sql.exec("PRAGMA table_info(transactions)").toArray();
      if (!columns.some(column => column.name === "runner")) {
        this.ctx.storage.sql.exec(
          "ALTER TABLE transactions ADD COLUMN runner TEXT NOT NULL DEFAULT 'nodejs'"
        );
      }
      this.ctx.storage.sql.exec(`
        DROP INDEX IF EXISTS idx_transactions_pending;
        CREATE INDEX idx_transactions_pending
          ON transactions(runner, dispatched, transaction_created)
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
  getRunner(request) {
    const runner = (request.headers.get("runner") || "nodejs").toLowerCase();
    return runner === "nodejs" || runner === "jxa" ? runner : null;
  }
  claimPendingTransaction(runner) {
    return this.ctx.storage.transactionSync(() => {
      const pending = this.ctx.storage.sql.exec(`
        SELECT transaction_id, transaction_created, payload
        FROM transactions
        WHERE runner = ? AND dispatched = 0 AND response_json IS NULL
        ORDER BY transaction_created, transaction_id
        LIMIT 1
      `, runner).toArray()[0];

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
  async ensureWorkflowRunning(runner) {
    if (!this.workflowChecks.has(runner)) {
      this.workflowChecks.set(runner, this.checkAndStartWorkflow(runner));
    }

    const workflowCheck = this.workflowChecks.get(runner);
    try {
      await workflowCheck;
    } finally {
      if (this.workflowChecks.get(runner) === workflowCheck) {
        this.workflowChecks.delete(runner);
      }
    }
  }
  async checkAndStartWorkflow(runner) {
    const repository = this.env.GITHUB_REPOSITORY;
    const token = this.env.GITHUB_TOKEN;
    const workflow = runner === "jxa"
      ? this.env.GITHUB_JXA_WORKFLOW || "jxa-waiter.yml"
      : this.env.GITHUB_WORKFLOW || "waiter.yml";
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

    const runsResponse = await fetch(`${workflowUrl}/runs?per_page=10`, { headers });
    if (!runsResponse.ok) {
      throw new Error(`GitHub workflow status check failed: ${runsResponse.status}`);
    }

    const { workflow_runs: runs = [] } = await runsResponse.json();
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
      body: JSON.stringify({ ref })
    });
    if (!dispatchResponse.ok) {
      throw new Error(`GitHub workflow dispatch failed: ${dispatchResponse.status}`);
    }
  }
  async listen(request) {
    const runner = this.getRunner(request);
    if (!runner) {
      return json({ error: "runner header must be nodejs or jxa" }, { status: 400 });
    }

    const pending = this.claimPendingTransaction(runner);
    if (pending) {
      return json(pending);
    }

    const waiter = new MetaPromise();
    const waiters = this.waiters.get(runner);
    waiters.add(waiter);
    try {
      return json(await waiter.promise);
    } finally {
      waiters.delete(waiter);
    }
  }
  async request(request) {
    const runner = this.getRunner(request);
    if (!runner) {
      return json({ error: "runner header must be nodejs or jxa" }, { status: 400 });
    }

    const transactionId = request.headers.get("transaction-id") || `transaction-${crypto.randomUUID()}`;
    const payload = (await request.text())||request.url;
    const transaction = {
      transaction_id: transactionId,
      transaction_created: Date.now(),
      payload
    };

    await this.ensureWorkflowRunning(runner);

    const waiters = this.waiters.get(runner);
    const waiter = waiters.values().next().value;

    const inserted = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO transactions
        (transaction_id, transaction_created, payload, runner, dispatched)
       VALUES (?, ?, ?, ?, ?)
       RETURNING transaction_id`,
      transactionId,
      transaction.transaction_created,
      payload,
      runner,
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
      waiters.delete(waiter);
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
