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
  let refreshes = 0;
  let forceToken = false;
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    await opts.throttle();
    const token = await getToken(forceToken);
    forceToken = false;
    const res = await requestFn(token);

    if (res.status === 401 && refreshes < maxRefreshes) {
      refreshes++;
      forceToken = true;
      lastRes = res;
      continue;
    }

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      lastRes = res;
      if (attempt === opts.maxRetries) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(1000 * 2 ** attempt, 16_000);
      await sleep(backoff);
      continue;
    }

    return res;
  }

  return lastRes as Response;
}
