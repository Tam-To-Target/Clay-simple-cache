/**
 * Shared HTTP resilience primitives for the outbound integrations (HubSpot,
 * PhoneBurner). Both APIs are token-authenticated, rate-limited (per-portal /
 * per-account), and occasionally throw transient 5xx, so they share one
 * throttle + retry + token-refresh policy instead of each re-implementing it.
 */

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A process-wide request spacer. Returns a function that resolves after the
 * previous call's slot, so concurrent callers queue to ~1 request / spacingMs
 * (keeps us under per-account rate limits). Serialized via a promise chain.
 */
export function createThrottle(spacingMs: number): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return () => {
    const prior = chain;
    chain = prior.then(() => sleep(spacingMs));
    return prior;
  };
}

/**
 * Lazily creates and memoizes one `createThrottle(spacingMs)` per key.
 * HubSpot's rate limit is per-portal and PhoneBurner's is per-member-account,
 * so a single process-wide throttle needlessly serializes independent
 * accounts against each other. Callers key by portal id / pb_member_id to get
 * per-account spacing while still sharing one throttle instance per key
 * across calls (memoized, not recreated).
 */
export function createKeyedThrottle(spacingMs: number): (key: string) => () => Promise<void> {
  const throttles = new Map<string, () => Promise<void>>();
  return (key: string) => {
    let t = throttles.get(key);
    if (!t) {
      t = createThrottle(spacingMs);
      throttles.set(key, t);
    }
    return t;
  };
}

/**
 * Runs `fn` over `items` with at most `limit` concurrent in-flight calls,
 * preserving result order (result[i] corresponds to items[i] regardless of
 * completion order). `limit` is clamped to >= 1. If any `fn` call rejects,
 * that error propagates out of `mapWithConcurrency` — callers that need to
 * keep processing the rest of the batch on a per-item failure should wrap
 * their own try/catch inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const boundedLimit = Math.max(1, Math.floor(limit) || 1);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(boundedLimit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface RetryOptions {
  throttle: () => Promise<void>;
  /** Max retries for 429 / 5xx. */
  maxRetries: number;
  /** Max forced token refreshes on 401 (a long sync can outlive a token twice). */
  maxTokenRefreshes?: number;
}

/**
 * Run a token-authenticated request with automatic recovery:
 *  - 401 → force-refresh the token and retry (bounded by maxTokenRefreshes).
 *  - 429 → honor Retry-After (else exponential backoff) and retry.
 *  - 5xx → exponential backoff and retry.
 *
 * `requestFn(token)` performs the actual fetch with the given bearer token; it
 * must be safe to call more than once (use string bodies). After exhausting
 * retries the last failing Response is returned so callers can inspect status.
 */
export async function withRetry(
  requestFn: (token: string) => Promise<Response>,
  getToken: (force?: boolean) => Promise<string>,
  opts: RetryOptions
): Promise<Response> {
  const maxRefreshes = opts.maxTokenRefreshes ?? 3;
  // 401 refreshes and 429/5xx retries have SEPARATE budgets, so a couple of
  // mid-run token expiries can't consume the transient-error retry budget (and
  // vice-versa) and cause a recoverable request to return a failing Response.
  let refreshes = 0;
  let retries = 0;
  let forceToken = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await opts.throttle();
    const token = await getToken(forceToken);
    forceToken = false;
    const res = await requestFn(token);

    if (res.status === 401 && refreshes < maxRefreshes) {
      refreshes++;
      forceToken = true;
      continue;
    }

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (retries >= opts.maxRetries) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** retries, 16_000);
      retries++;
      await sleep(backoff);
      continue;
    }

    return res;
  }
}
