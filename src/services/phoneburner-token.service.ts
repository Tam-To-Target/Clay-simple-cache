/**
 * Resolves per-member PhoneBurner access tokens from one durable admin secret.
 *
 * PhoneBurner is a single team account with many members. The admin (BOBBY)
 * token can list all members, and each member record carries a fresh
 * `oauth.bearer_token` + `expires` inline:
 *
 *   GET {PHONEBURNER_API_BASE}/members?page_size=100
 *   Authorization: Bearer <PHONEBURNER_ADMIN_TOKEN>
 *   -> { members: { members: [ { user_id, ..., oauth: { bearer_token, expires } } ] } }
 *
 * So one durable admin secret resolves every member token on demand. Member
 * tokens are cached for the run and re-pulled when near expiry. We must use each
 * SDR's OWN token to read/delete that SDR's contacts (the admin token only sees
 * its own book), and that SDR must have "API Access" enabled (else 403).
 */

import { createThrottle, withRetry } from "./http-retry";

export function phoneburnerApiBase(): string {
  return (process.env.PHONEBURNER_API_BASE || "https://www.phoneburner.com/rest/1").replace(/\/$/, "");
}

// PhoneBurner rejects requests with an empty User-Agent (403).
const USER_AGENT = process.env.PHONEBURNER_USER_AGENT || "TAM-DNC-Cache/1.0";
const SKEW_MS = 120_000; // treat tokens expiring within 2 min as already expired
const MEMBERS_PAGE_SIZE = 100;
const throttle = createThrottle(150);

export class PhoneburnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneburnerConfigError";
  }
}

interface MemberToken {
  token: string;
  expiresAtMs: number;
  username: string | null;
}

/**
 * PhoneBurner list endpoints don't return a flat array — the collection is
 * commonly `{...: { <items>: [ { "0": rec, "1": rec, ... } ] } }`, i.e. an array
 * whose elements are index-keyed maps of the real records. This flattens any of:
 * a flat array, an index-keyed map, or an array of index-keyed maps, into the
 * leaf records (identified by `isRecord`). Containers are recursed one level.
 */
export function flattenPbCollection(raw: any, isRecord: (o: any) => boolean): any[] {
  const out: any[] = [];
  const visit = (v: any, depth: number): void => {
    if (!v || typeof v !== "object" || depth > 4) return;
    if (isRecord(v)) {
      out.push(v);
      return;
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) visit(child, depth + 1);
  };
  visit(raw, 0);
  return out;
}

// memberId -> token. Populated by a full /members pull, cached for the process.
const cache = new Map<string, MemberToken>();
let lastFullPullAtMs = 0;

function adminToken(): string {
  const t = process.env.PHONEBURNER_ADMIN_TOKEN;
  if (!t) {
    throw new PhoneburnerConfigError(
      "PHONEBURNER_ADMIN_TOKEN is not set — required to resolve PhoneBurner member tokens."
    );
  }
  return t;
}

function parseExpiry(expires: unknown, now: number): number {
  if (typeof expires === "number" && Number.isFinite(expires)) {
    // Heuristic: seconds-since-epoch vs ms-since-epoch vs seconds-from-now.
    if (expires > 1e12) return expires; // ms epoch
    if (expires > 1e9) return expires * 1000; // s epoch
    return now + expires * 1000; // seconds from now
  }
  if (typeof expires === "string") {
    const asDate = Date.parse(expires);
    if (!Number.isNaN(asDate)) return asDate;
    const asNum = Number(expires);
    if (Number.isFinite(asNum)) return parseExpiry(asNum, now);
  }
  return now + 25 * 60_000; // safe default ~25 min
}

/** Pull ALL members from the admin token and refresh the token cache. */
export async function refreshMemberTokens(): Promise<Map<string, MemberToken>> {
  const base = phoneburnerApiBase();
  const now = Date.now();
  let page = 1;

  cache.clear();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await withRetry(
      (token) =>
        fetch(`${base}/members?page_size=${MEMBERS_PAGE_SIZE}&page=${page}`, {
          headers: { Authorization: `Bearer ${token}`, "User-Agent": USER_AGENT },
        }),
      async () => adminToken(),
      { throttle, maxRetries: 5, maxTokenRefreshes: 0 }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PhoneBurner /members failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }

    const json: any = await res.json();
    const env = json?.members ?? json;
    const list = flattenPbCollection(
      env?.members ?? env?.data ?? env,
      (o) => o.user_id !== undefined || o.member_user_id !== undefined || o.oauth !== undefined
    );
    for (const m of list) {
      const id = String(m?.user_id ?? m?.member_user_id ?? m?.id ?? "");
      const bearer = m?.oauth?.bearer_token ?? m?.bearer_token ?? null;
      if (!id || !bearer) continue;
      cache.set(id, {
        token: bearer,
        expiresAtMs: parseExpiry(m?.oauth?.expires ?? m?.expires, now),
        username: m?.username ?? m?.email_address ?? m?.email ?? null,
      });
    }

    const totalPages = Number(env?.total_pages ?? env?.totalPages ?? 1);
    if (!Number.isFinite(totalPages) || page >= totalPages || list.length === 0) break;
    page++;
  }

  lastFullPullAtMs = now;
  return cache;
}

/**
 * Return a valid bearer token for a PhoneBurner member, or null if that member
 * is unknown to the admin account (left the team / never existed). Re-pulls the
 * member list once if the cache is empty or the cached token is near expiry.
 */
export async function getMemberToken(
  memberId: string | number,
  opts?: { force?: boolean }
): Promise<string | null> {
  const id = String(memberId);
  const now = Date.now();

  const cached = cache.get(id);
  const fresh = cached && cached.expiresAtMs > now + SKEW_MS;
  if (!opts?.force && fresh) return cached!.token;

  // Avoid hammering /members: only re-pull if forced, cache empty, or token stale.
  if (opts?.force || cache.size === 0 || !fresh) {
    await refreshMemberTokens();
  }

  const after = cache.get(id);
  return after && after.expiresAtMs > now ? after.token : null;
}

export function getMemberUsername(memberId: string | number): string | null {
  return cache.get(String(memberId))?.username ?? null;
}

/** Test/maintenance helper — clear the in-memory token cache. */
export function clearMemberTokenCache(): void {
  cache.clear();
  lastFullPullAtMs = 0;
}
