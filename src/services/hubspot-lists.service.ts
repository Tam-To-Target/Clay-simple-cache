/**
 * Thin HubSpot client for reading list memberships (CRM v3 Lists API).
 *
 * Flow:
 *   1. Page through GET /crm/v3/lists/{listId}/memberships → contact record IDs.
 *   2. Batch-read those contacts (POST /crm/v3/objects/contacts/batch/read)
 *      to pull email + phone properties.
 *
 * Auth is a per-client HubSpot private-app token (Bearer).
 * Works for both static and dynamic (active) lists — HubSpot resolves the
 * current membership server-side, so a daily sync keeps dynamic segments fresh.
 */

const HUBSPOT_BASE = "https://api.hubapi.com";
const MEMBERSHIP_PAGE_SIZE = 100;
const BATCH_READ_SIZE = 100;

export interface HubspotListContact {
  hubspot_id: string;
  email: string | null;
  phone: string | null;
  /** HubSpot's computed email domain (hs_email_domain), used for domain-level DNC. */
  email_domain: string | null;
}

export type DncLevel = "individual" | "domain";

export interface DncListInfo {
  listId: string;
  name: string;
  /** null = name matched the prefix but had no recognized (Individual)/(Domain) suffix. */
  level: DncLevel | null;
}

interface ListSearchResponse {
  lists?: { list?: any }[] | any[];
}

/**
 * Classify a DNC list by its name. Matching is substring + case-insensitive so
 * it tolerates client-suffixed names like "TAM - Do Not Contact (Domain) | (Acme)".
 * Anything without a recognized suffix (plain name, "(Inbound)", etc.) returns
 * null — the caller reports these rather than syncing them.
 */
export function classifyDncList(name: string): DncLevel | null {
  const n = (name || "").toLowerCase();
  if (n.includes("(domain)")) return "domain";
  if (n.includes("(individual)")) return "individual";
  return null;
}

/**
 * Find a portal's "<prefix> …" lists and classify each. Only lists whose name
 * starts with the prefix are returned (the search itself is fuzzy).
 */
export async function searchDncLists(
  tokenProvider: TokenProvider,
  prefix: string
): Promise<DncListInfo[]> {
  const res = await hsFetch(`/crm/v3/lists/search`, tokenProvider, {
    method: "POST",
    body: JSON.stringify({ query: prefix, count: 100 }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HubSpot list search failed: HTTP ${res.status} ${body}`);
  }

  const json = (await res.json()) as ListSearchResponse;
  const items = (json.lists || []) as any[];
  const p = prefix.trim().toLowerCase();

  return items
    .map((i) => (i && i.list ? i.list : i))
    .filter((l) => l && typeof l.name === "string" && l.name.toLowerCase().startsWith(p))
    .map((l) => ({
      listId: String(l.listId),
      name: l.name as string,
      level: classifyDncList(l.name),
    }));
}

interface MembershipsResponse {
  results?: { recordId: string }[];
  paging?: { next?: { after?: string } };
}

interface BatchReadResponse {
  results?: { id: string; properties?: Record<string, string | null> }[];
}

/**
 * Resolves a HubSpot bearer token. `force` must bypass any cache and mint a
 * fresh token — used to recover from a mid-run expiry (HTTP 401).
 */
export type TokenProvider = (force?: boolean) => Promise<string>;

async function rawFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Minimum spacing between HubSpot requests, process-wide. HubSpot enforces a
 * TEN_SECONDLY_ROLLING cap (~10 req/s per portal); a large list sync (thousands
 * of membership pages + batch reads) blows past it and gets HTTP 429. Spacing
 * requests ~8/s keeps us safely under the limit. Serialized via a promise chain
 * so concurrent callers queue instead of all firing at once.
 */
const MIN_REQUEST_SPACING_MS = 125;
const MAX_RETRIES = 5;
let throttleChain: Promise<void> = Promise.resolve();

function throttle(): Promise<void> {
  const prior = throttleChain;
  throttleChain = prior.then(() => sleep(MIN_REQUEST_SPACING_MS));
  return prior;
}

/**
 * Fetch with automatic recovery:
 *  - 401: a long sync can outlive its token → force-refresh once and retry.
 *  - 429: respect HubSpot's rate limit → wait Retry-After (or backoff) and retry.
 *  - 5xx (502/503/504): transient gateway blips → exponential backoff and retry.
 * Request bodies are JSON strings, so re-sending `init` is safe.
 */
async function hsFetch(
  path: string,
  tokenProvider: TokenProvider,
  init?: RequestInit
): Promise<Response> {
  let refreshed = false;
  let forceToken = false;
  let lastRes: Response | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    const token = await tokenProvider(forceToken);
    forceToken = false;
    const res = await rawFetch(path, token, init);

    if (res.status === 401 && !refreshed) {
      // Token expired mid-run — mint a fresh one and retry immediately.
      refreshed = true;
      forceToken = true;
      lastRes = res;
      continue;
    }

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      lastRes = res;
      if (attempt === MAX_RETRIES) return res;
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 16_000);
      await sleep(backoff);
      continue;
    }

    return res;
  }

  return lastRes as Response;
}

/** Page through a list's memberships and return all contact record IDs. */
async function fetchListMemberIds(tokenProvider: TokenProvider, listId: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(MEMBERSHIP_PAGE_SIZE) });
    if (after) params.set("after", after);

    const res = await hsFetch(`/crm/v3/lists/${listId}/memberships?${params}`, tokenProvider);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HubSpot memberships failed (list ${listId}): HTTP ${res.status} ${body}`);
    }

    const json = (await res.json()) as MembershipsResponse;
    for (const r of json.results || []) ids.push(r.recordId);
    after = json.paging?.next?.after;
  } while (after);

  return ids;
}

/** Batch-read contacts to get email + phone for the given record IDs. */
async function fetchContactProps(
  tokenProvider: TokenProvider,
  ids: string[]
): Promise<HubspotListContact[]> {
  const out: HubspotListContact[] = [];

  for (let i = 0; i < ids.length; i += BATCH_READ_SIZE) {
    const batch = ids.slice(i, i + BATCH_READ_SIZE);
    const res = await hsFetch(`/crm/v3/objects/contacts/batch/read`, tokenProvider, {
      method: "POST",
      body: JSON.stringify({
        properties: ["email", "phone", "hs_email_domain"],
        inputs: batch.map((id) => ({ id })),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HubSpot batch read failed: HTTP ${res.status} ${body}`);
    }

    const json = (await res.json()) as BatchReadResponse;
    for (const r of json.results || []) {
      out.push({
        hubspot_id: r.id,
        email: r.properties?.email ?? null,
        phone: r.properties?.phone ?? null,
        email_domain: r.properties?.hs_email_domain ?? null,
      });
    }
  }

  return out;
}

/** Full snapshot of a HubSpot list's contacts (email + phone + email domain). */
export async function fetchListContacts(
  tokenProvider: TokenProvider,
  listId: string
): Promise<HubspotListContact[]> {
  const ids = await fetchListMemberIds(tokenProvider, listId);
  if (ids.length === 0) return [];
  return fetchContactProps(tokenProvider, ids);
}
