/**
 * Resolves per-member PhoneBurner access tokens from GTMOS.
 *
 * PhoneBurner's shared admin (BOBBY) token can NEITHER reveal a member's token
 * NOR delete from a member's book — so the DNC purge must act with each SDR's
 * OWN personal access token. GTMOS is the source of truth for those tokens
 * (stored encrypted, keyed by the SDR's PhoneBurner member id) and hands them to
 * this service over the internal API:
 *
 *   GET {SDR_LAUNCH_INTERNAL_URL}/api/internal/phoneburner-tokens
 *   header: X-Internal-Secret: <SDR_LAUNCH_INTERNAL_SECRET>
 *   -> { tokens: [ { pbMemberId, token, email, status } ] }
 *
 * Tokens are cached for the run (a short TTL so rotations propagate) and
 * re-pulled on demand (e.g. on a 401). getMemberToken returns null for a member
 * GTMOS has no token for — the purge skips that member, never errors.
 */

import { fetchPhoneburnerTokens } from "./sdr-launch.service";

export function phoneburnerApiBase(): string {
  return (process.env.PHONEBURNER_API_BASE || "https://www.phoneburner.com/rest/1").replace(/\/$/, "");
}

// PATs are long-lived; re-pull periodically so a rotated token propagates within
// a run. Treat a token as stale slightly early to avoid a race at the boundary.
const CACHE_TTL_MS = 15 * 60_000;
const SKEW_MS = 60_000;

/**
 * PhoneBurner list endpoints don't return a flat array — the collection is
 * commonly `{...: { <items>: [ { "0": rec, "1": rec, ... } ] } }`, i.e. an array
 * whose elements are index-keyed maps of the real records. This flattens any of:
 * a flat array, an index-keyed map, or an array of index-keyed maps, into the
 * leaf records (identified by `isRecord`). Containers are recursed one level.
 * (Still used by phoneburner.service for the /contacts response shape.)
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

interface MemberToken {
  token: string;
  expiresAtMs: number;
  username: string | null;
}

// pbMemberId -> token. Populated from GTMOS, cached for the process.
const cache = new Map<string, MemberToken>();

/** Pull ALL active SDR tokens from GTMOS and refresh the token cache. */
export async function refreshMemberTokens(): Promise<Map<string, MemberToken>> {
  const now = Date.now();
  const tokens = await fetchPhoneburnerTokens();
  cache.clear();
  for (const t of tokens) {
    if (!t.pbMemberId || !t.token) continue;
    cache.set(String(t.pbMemberId), {
      token: t.token,
      expiresAtMs: now + CACHE_TTL_MS,
      username: t.email ?? null,
    });
  }
  return cache;
}

/**
 * Return a valid token for a PhoneBurner member, or null if GTMOS has no token
 * for that member (SDR never set one / left the team). Re-pulls the token list
 * once when the cache is empty, stale, or a refresh is forced (e.g. after a 401).
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
}
