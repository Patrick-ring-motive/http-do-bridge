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
		const url = new URL(request.url);

		switch (url.pathname) {
			case "/listen":
				return this.listen(request);

			case "/request":
				return this.request(request);

			case "/response":
				return this.response(request);

			default:
				return new Response("Not found", {
					status: 404
				});
		}
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

		/*
		 * Don't let an abandoned HTTP request leave a waiter
		 * registered forever.
		 */
		const abort = new Promise(resolve => {
			request.signal.addEventListener("abort", resolve, {
				once: true
			});
		});

		try {
			const result = await Promise.race([
				waiter.promise,
				abort.then(() => null)
			]);

			if (result === null) {
				return new Response(null, {
					status: 499
				});
			}

			return json(result);
		} finally {
			this.waiters.delete(waiter);

			/*
			 * This is deliberately background work. The HTTP response
			 * doesn't need to wait for bookkeeping.
			 */
			this.ctx.waitUntil(
				this.cleanup()
			);
		}
	}

	async request(request) {
		const transactionId =
			request.headers.get("transaction-id") ??
			`transaction-${crypto.randomUUID()}`;

		const payload = await request.text();

		/*
		 * Don't create a second transaction if the producer retries
		 * with the same transaction ID.
		 */
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

			if (!waiter) {
				this.transactions.delete(transactionId);

				return json({
					error: "no waiter connected"
				}, {
					status: 503
				});
			}

			this.waiters.delete(waiter);

			waiter.resolve(transaction);

			const response = await result.promise;

			/*
			 * Nothing in the response path needs to delay the caller.
			 */
			this.ctx.waitUntil(
				this.recordCompletion(transactionId)
			);

			return json(response);
		} finally {
			this.transactions.delete(transactionId);
		}
	}

	async response(request) {
		const items = await request.json();

		for (const item of items) {
			const transaction = this.transactions.get(
				item.transaction_id
			);

			if (transaction) {
				transaction.resolve(item);
			}
		}

		/*
		 * Again, this is intentionally outside the critical response
		 * path. Add metrics/logging/etc. here later.
		 */
		this.ctx.waitUntil(
			this.recordResponses(items)
		);

		return new Response(null, {
			status: 204
		});
	}

	async cleanup() {
		/*
		 * Placeholder for persistent-state cleanup once transactions
		 * move into DO SQLite.
		 */
	}

	async recordCompletion(transactionId) {
		/*
		 * Placeholder for metrics/audit persistence.
		 */
		console.log("completed", transactionId);
	}

	async recordResponses(items) {
		console.log("responses", items.length);
	}
}

export default {
	async fetch(request, env) {
		const id = env.BRIDGE.idFromName("default");
		const bridge = env.BRIDGE.get(id);

		return bridge.fetch(request);
	}
};
