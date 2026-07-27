/**
 * Resolves per-workspace EmailBison API keys from GTMOS.
 *
 * EmailBison suppression writes to a workspace's native "Block List" using that
 * workspace's own bearer key. GTMOS is the source of truth for those keys
 * (stored encrypted on eb_workspaces.api_key_encrypted) and hands them to this
 * service over the internal API — we never keep a second plaintext copy here
 * (same invariant as PhoneBurner tokens):
 *
 *   GET {SDR_LAUNCH_INTERNAL_URL}/api/internal/emailbison-tokens
 *   header: X-Internal-Secret: <SDR_LAUNCH_INTERNAL_SECRET>
 *   -> { workspaces: [ { workspaceId, workspaceName, clientId, apiKey } ] }
 *
 * Keys are cached briefly (rotations propagate within the TTL) and re-pulled on
 * demand (e.g. on a 401). getWorkspaceKey returns null for a workspace GTMOS has
 * no key for — the suppress run skips that workspace, never errors.
 */

import { fetchEmailbisonWorkspaces, SdrEmailbisonWorkspace } from "./sdr-launch.service";

export function emailbisonApiBase(): string {
  return (process.env.EMAILBISON_API_BASE_URL || "https://send.tamtotarget.com").replace(/\/$/, "");
}

const CACHE_TTL_MS = 15 * 60_000;
const SKEW_MS = 60_000;

interface CachedKey {
  apiKey: string;
  expiresAtMs: number;
}

// workspaceId (as string) -> key. Populated from GTMOS, cached for the process.
const cache = new Map<string, CachedKey>();

/** Pull ALL client-mapped workspace keys from GTMOS and refresh the cache. */
export async function refreshWorkspaceKeys(): Promise<SdrEmailbisonWorkspace[]> {
  const now = Date.now();
  const workspaces = await fetchEmailbisonWorkspaces();
  cache.clear();
  for (const w of workspaces) {
    if (w.workspaceId == null || !w.apiKey) continue;
    cache.set(String(w.workspaceId), { apiKey: w.apiKey, expiresAtMs: now + CACHE_TTL_MS });
  }
  return workspaces;
}

/**
 * Return a valid key for an EmailBison workspace, or null if GTMOS has no key
 * for it. Re-pulls the list once when the cache is empty, stale, or forced.
 */
export async function getWorkspaceKey(
  workspaceId: number | string,
  opts?: { force?: boolean }
): Promise<string | null> {
  const id = String(workspaceId);
  const now = Date.now();

  const cached = cache.get(id);
  const fresh = cached && cached.expiresAtMs > now + SKEW_MS;
  if (!opts?.force && fresh) return cached!.apiKey;

  if (opts?.force || cache.size === 0 || !fresh) {
    await refreshWorkspaceKeys();
  }

  const after = cache.get(id);
  return after && after.expiresAtMs > now ? after.apiKey : null;
}

/**
 * Return the full workspace list (workspaceId + GTMOS clientId + name), used by
 * the bootstrap script to build the client→workspace map. Not cached — bootstrap
 * is a one-shot.
 */
export async function listWorkspaceKeys(): Promise<SdrEmailbisonWorkspace[]> {
  return fetchEmailbisonWorkspaces();
}

/** Test/maintenance helper — clear the in-memory key cache. */
export function clearWorkspaceKeyCache(): void {
  cache.clear();
}
