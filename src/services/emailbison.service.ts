/**
 * EmailBison "Block List" REST client (raw API, per-workspace bearer key).
 *
 * Suppression is TWO resources on send.tamtotarget.com, scoped by the key:
 *   POST /api/blacklisted-emails   { email }
 *   POST /api/blacklisted-domains  { domain }
 *
 * Verified live (P0, 2026-07-27):
 *   201 = added         → { data: { id, email|domain, ... } }
 *   422 "The email/domain has already been taken." = ALREADY PRESENT (success)
 *   other = failed
 * The `/bulk` endpoint 500s, so we POST one identifier at a time with bounded
 * concurrency. Add-only: we never LIST/search/DELETE the remote list.
 */

import { emailbisonApiBase } from "./emailbison-token.service";

export type SuppressStatus = "added" | "already_present" | "failed";

export interface SuppressResult {
  status: SuppressStatus;
  httpStatus: number;
  /** EmailBison id from a 201 response, when present. */
  providerId?: number;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3; // on 429/5xx/network — never on 422

function suppressConcurrency(): number {
  const raw = Number(process.env.EMAILBISON_SUPPRESS_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 16) : 6;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Does the 422 body say the value is already blocklisted? (treated as success) */
function isAlreadyTaken(body: any): boolean {
  const msg = JSON.stringify(body ?? "").toLowerCase();
  return msg.includes("already been taken");
}

async function post(
  key: string,
  path: string,
  payload: Record<string, string>
): Promise<SuppressResult> {
  const url = `${emailbisonApiBase()}${path}`;
  let backoff = 1000;
  let lastErr = "";

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const body: any = await res.json().catch(() => ({}));

      if (res.status === 201) {
        const id = body?.data?.id;
        return { status: "added", httpStatus: 201, providerId: typeof id === "number" ? id : undefined };
      }
      if (res.status === 422 && isAlreadyTaken(body)) {
        return { status: "already_present", httpStatus: 422 };
      }
      // Retry transient server/rate errors; everything else is a hard fail.
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`;
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      return {
        status: "failed",
        httpStatus: res.status,
        error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`,
      };
    } catch (err: any) {
      lastErr = err?.name === "AbortError" ? "request timeout" : err?.message || String(err);
      await sleep(backoff);
      backoff *= 2;
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: "failed", httpStatus: 0, error: `after ${MAX_RETRIES} retries: ${lastErr}` };
}

/** Add one email to the workspace blocklist. */
export function suppressEmail(key: string, email: string): Promise<SuppressResult> {
  return post(key, "/api/blacklisted-emails", { email });
}

/** Add one domain to the workspace blocklist. */
export function suppressDomain(key: string, domain: string): Promise<SuppressResult> {
  return post(key, "/api/blacklisted-domains", { domain });
}

/**
 * Run `worker` over `items` with bounded concurrency, preserving input order in
 * the results. Tiny inline limiter (no p-limit dependency).
 */
export async function mapLimit<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  limit = suppressConcurrency()
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}
