/**
 * Resolves a currently-valid HubSpot access token for a portal.
 *
 * HubSpot OAuth tokens stored in the tokens DB live only ~30 min, so we never
 * store or trust them directly. Instead we ask the provisioner, which owns the
 * OAuth client credentials and refreshes transparently:
 *
 *   GET {HUBSPOT_PROVISIONER_URL}/internal/token?portalId=<id>
 *   header: X-Internal-Secret: <HUBSPOT_PROVISIONER_API_SECRET>
 *   -> { accessToken, expiresAt }
 *
 * Tokens are cached in-memory for the life of the process (a sync run) so a
 * portal with two DNC lists only triggers one refresh.
 */

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

const cache = new Map<string, CachedToken>();
// Treat tokens expiring within 2 min as already expired. Syncing one large list
// can take a while, so we want comfortable runway before starting one.
const SKEW_MS = 120_000;

export async function getValidToken(
  portalId: string | number,
  opts?: { force?: boolean }
): Promise<string> {
  const pid = String(portalId);
  const now = Date.now();

  if (!opts?.force) {
    const cached = cache.get(pid);
    if (cached && cached.expiresAtMs > now + SKEW_MS) return cached.token;
  }

  const baseUrl = process.env.HUBSPOT_PROVISIONER_URL;
  const secret = process.env.HUBSPOT_PROVISIONER_API_SECRET;
  if (!baseUrl || !secret) {
    throw new Error(
      "HUBSPOT_PROVISIONER_URL and HUBSPOT_PROVISIONER_API_SECRET must be set to resolve HubSpot tokens"
    );
  }

  const res = await fetch(
    `${baseUrl.replace(/\/$/, "")}/internal/token?portalId=${encodeURIComponent(pid)}`,
    { headers: { "X-Internal-Secret": secret } }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Provisioner token fetch failed for portal ${pid}: HTTP ${res.status} ${body}`);
  }

  const json = (await res.json()) as { accessToken?: string; expiresAt?: string | null };
  if (!json.accessToken) {
    throw new Error(`Provisioner returned no accessToken for portal ${pid}`);
  }

  const expiresAtMs = json.expiresAt ? new Date(json.expiresAt).getTime() : now + 25 * 60_000;
  cache.set(pid, { token: json.accessToken, expiresAtMs });
  return json.accessToken;
}

/** Test/maintenance helper — clear the in-memory token cache. */
export function clearTokenCache(): void {
  cache.clear();
}
