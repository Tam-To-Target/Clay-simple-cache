/**
 * Thin HubSpot client for reading list memberships (CRM v3 Lists API).
 *
 * Flow:
 *   1. Page through GET /crm/v3/lists/{listId}/memberships → record IDs.
 *   2. Batch-read those records to pull the identifiers we suppress on.
 *
 * Two list object types are supported, because a DNC segment can be built on
 * either object:
 *   - CONTACT lists (`0-1`) → batch-read contacts for email + phone
 *     (+ hs_email_domain), which feed individual AND domain-level suppression.
 *   - COMPANY lists (`0-2`) → batch-read companies for `domain` (falling back to
 *     `website`). A company has no email or phone of its own, so a company list
 *     is inherently DOMAIN-level; each member yields exactly one domain entry.
 *     Company members are surfaced as {@link HubspotListContact} with null
 *     email/phone and the company domain in `email_domain`, so the entry-building
 *     and diffing downstream stay object-agnostic.
 *
 * Auth is a per-client HubSpot private-app token (Bearer).
 * Works for both static and dynamic (active) lists — HubSpot resolves the
 * current membership server-side, so a daily sync keeps dynamic segments fresh.
 */

import { normalizeDomain } from "./normalization";
import { createThrottle, withRetry } from "./http-retry";

/** HubSpot object type ids for the list kinds we can sync. */
export const CONTACT_OBJECT_TYPE = "0-1";
export const COMPANY_OBJECT_TYPE = "0-2";

const HUBSPOT_BASE = "https://api.hubapi.com";
// The v3 memberships endpoint accepts limit <= 250; using the max halves the
// number of paging calls on large lists vs. the old 100.
const MEMBERSHIP_PAGE_SIZE = 250;
const BATCH_READ_SIZE = 100;

/** Optional per-call throttle override — see {@link createKeyedThrottle} in http-retry. */
export interface HsCallOpts {
  throttle?: () => Promise<void>;
}

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
  /** Current membership size (HubSpot's hs_list_size), or null if unavailable. */
  contact_count: number | null;
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
  prefix: string,
  opts?: HsCallOpts
): Promise<DncListInfo[]> {
  const res = await hsFetch(
    `/crm/v3/lists/search`,
    tokenProvider,
    {
      method: "POST",
      body: JSON.stringify({ query: prefix, count: 100 }),
    },
    opts?.throttle
  );
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
      contact_count:
        l.additionalProperties?.hs_list_size != null ? Number(l.additionalProperties.hs_list_size) : null,
    }));
}

/**
 * Fetch a single list's metadata (name) by id. Returns null if the list doesn't
 * exist in this portal (404) — used by the id→level override path, where an
 * override configured for one client won't exist in another client's portal.
 */
export async function fetchListById(
  tokenProvider: TokenProvider,
  listId: string,
  opts?: HsCallOpts
): Promise<{ listId: string; name: string; objectTypeId: string | null } | null> {
  const res = await hsFetch(`/crm/v3/lists/${encodeURIComponent(listId)}`, tokenProvider, undefined, opts?.throttle);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HubSpot get list ${listId} failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { list?: any; name?: string; listId?: string };
  const l = json.list ?? json;
  if (!l || typeof l.name !== "string") return null;
  return {
    listId: String(l.listId ?? listId),
    name: l.name,
    objectTypeId: l.objectTypeId != null ? String(l.objectTypeId) : null,
  };
}

/**
 * Which CRM object a list is built on (`0-1` contacts, `0-2` companies).
 *
 * Never throws: a 404/error/unparseable response returns null, which callers
 * treat as "assume contacts" — the historical behaviour, so a transient HubSpot
 * failure degrades to the old code path instead of aborting a sync.
 */
export async function fetchListObjectType(
  tokenProvider: TokenProvider,
  listId: string,
  opts?: HsCallOpts
): Promise<string | null> {
  try {
    const meta = await fetchListById(tokenProvider, listId, opts);
    return meta?.objectTypeId ?? null;
  } catch {
    return null;
  }
}

/**
 * Cheap size check for change detection: fetches only `hs_list_size` instead
 * of paging memberships. Never throws — a missing/404/unparseable size
 * returns null, which callers treat as "must do a full sync" (safe default).
 */
export async function fetchListSize(
  tokenProvider: TokenProvider,
  listId: string,
  opts?: HsCallOpts
): Promise<number | null> {
  try {
    const res = await hsFetch(
      `/crm/v3/lists/${encodeURIComponent(listId)}?additionalPropertyNames=hs_list_size`,
      tokenProvider,
      undefined,
      opts?.throttle
    );
    if (res.status === 404 || !res.ok) return null;
    const json = (await res.json()) as { list?: any; additionalProperties?: any };
    const l = json.list ?? json;
    const raw = l?.additionalProperties?.hs_list_size;
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export interface HubspotListSummary {
  listId: string;
  name: string;
  processingType?: string | null;
  /** Current membership size (HubSpot's hs_list_size), or null if unavailable. */
  contact_count: number | null;
}

/**
 * Search a portal's HubSpot lists by name (or list all when query is empty).
 * Used by the admin lookup endpoint so a caller can find a list id from its name
 * before pinning it as a DNC source. Not prefix-filtered.
 */
export async function searchLists(
  tokenProvider: TokenProvider,
  query = "",
  count = 100,
  opts?: HsCallOpts
): Promise<HubspotListSummary[]> {
  const res = await hsFetch(
    `/crm/v3/lists/search`,
    tokenProvider,
    {
      method: "POST",
      body: JSON.stringify({ query, count }),
    },
    opts?.throttle
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HubSpot list search failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as ListSearchResponse;
  const items = (json.lists || []) as any[];
  return items
    .map((i) => (i && i.list ? i.list : i))
    .filter((l) => l && l.listId != null && typeof l.name === "string")
    .map((l) => ({
      listId: String(l.listId),
      name: l.name as string,
      processingType: l.processingType ?? null,
      contact_count:
        l.additionalProperties?.hs_list_size != null ? Number(l.additionalProperties.hs_list_size) : null,
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

/**
 * Minimum spacing between HubSpot requests, process-wide. HubSpot enforces a
 * TEN_SECONDLY_ROLLING cap (~10 req/s per portal); a large list sync (thousands
 * of membership pages + batch reads) blows past it and gets HTTP 429. Spacing
 * requests ~8/s keeps us safely under the limit.
 */
const MIN_REQUEST_SPACING_MS = 125;
const MAX_RETRIES = 5;
const MAX_TOKEN_REFRESHES = 3;
const throttle = createThrottle(MIN_REQUEST_SPACING_MS);

/**
 * Fetch with automatic recovery (shared throttle + 401-refresh + 429/5xx retry).
 * See {@link withRetry}. Request bodies are JSON strings, so retrying is safe.
 */
async function hsFetch(
  path: string,
  tokenProvider: TokenProvider,
  init?: RequestInit,
  throttleOverride?: () => Promise<void>
): Promise<Response> {
  return withRetry((token) => rawFetch(path, token, init), tokenProvider, {
    throttle: throttleOverride ?? throttle,
    maxRetries: MAX_RETRIES,
    maxTokenRefreshes: MAX_TOKEN_REFRESHES,
  });
}

/** Page through a list's memberships and return all contact record IDs. */
async function fetchListMemberIds(
  tokenProvider: TokenProvider,
  listId: string,
  opts?: HsCallOpts
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(MEMBERSHIP_PAGE_SIZE) });
    if (after) params.set("after", after);

    const res = await hsFetch(
      `/crm/v3/lists/${listId}/memberships?${params}`,
      tokenProvider,
      undefined,
      opts?.throttle
    );
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

/**
 * Generic batch-read helper: given arbitrary contact record IDs and a set of
 * property names, returns a map of id -> properties (raw HubSpot values,
 * `null` where a property is unset). Chunks requests at `BATCH_READ_SIZE`.
 *
 * Returns an empty Map (no HTTP call) when `ids` is empty.
 */
export async function batchReadContactProperties(
  tokenProvider: TokenProvider,
  ids: string[],
  properties: string[],
  opts?: HsCallOpts
): Promise<Map<string, Record<string, string | null>>> {
  return batchReadObjectProperties(tokenProvider, "contacts", ids, properties, opts);
}

/**
 * Same as {@link batchReadContactProperties} but for any CRM object collection
 * (`contacts`, `companies`, …). Kept separate so the contacts signature — used
 * by meeting protection — stays unchanged.
 */
export async function batchReadObjectProperties(
  tokenProvider: TokenProvider,
  objectPath: "contacts" | "companies",
  ids: string[],
  properties: string[],
  opts?: HsCallOpts
): Promise<Map<string, Record<string, string | null>>> {
  const out = new Map<string, Record<string, string | null>>();
  if (ids.length === 0) return out;

  for (let i = 0; i < ids.length; i += BATCH_READ_SIZE) {
    const batch = ids.slice(i, i + BATCH_READ_SIZE);
    const res = await hsFetch(
      `/crm/v3/objects/${objectPath}/batch/read`,
      tokenProvider,
      {
        method: "POST",
        body: JSON.stringify({
          properties,
          inputs: batch.map((id) => ({ id })),
        }),
      },
      opts?.throttle
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HubSpot batch read failed: HTTP ${res.status} ${body}`);
    }

    const json = (await res.json()) as BatchReadResponse;
    for (const r of json.results || []) {
      out.set(r.id, r.properties ?? {});
    }
  }

  return out;
}

/**
 * Batch-read COMPANY records and surface each as a {@link HubspotListContact}
 * carrying only a domain.
 *
 * `domain` is HubSpot's canonical company domain; `website` is the fallback for
 * portals that filled the latter only (normalizeDomain strips scheme/www/path,
 * so a raw "https://www.acme.org/x" reduces cleanly). A company with neither is
 * returned with a null `email_domain` — deliberately kept rather than dropped so
 * callers can count and report how many members were unusable, which is the
 * difference between "the segment isn't wired up" and "the segment has no
 * domains in it".
 */
async function fetchCompanyProps(
  tokenProvider: TokenProvider,
  ids: string[],
  opts?: HsCallOpts
): Promise<HubspotListContact[]> {
  const propsById = await batchReadObjectProperties(
    tokenProvider,
    "companies",
    ids,
    ["domain", "website"],
    opts
  );

  const out: HubspotListContact[] = [];
  for (const [id, properties] of propsById) {
    const raw = properties.domain || properties.website || null;
    out.push({
      hubspot_id: id,
      email: null,
      phone: null,
      email_domain: raw ? normalizeDomain(raw) : null,
    });
  }
  return out;
}

/**
 * Full snapshot of a COMPANY list's members as domain-bearing pseudo-contacts.
 *
 * No incremental (`known`) path: a company member produces only a domain entry
 * downstream, and those rows carry no per-record HubSpot id to rebuild a cache
 * from, so every sync re-reads the membership. That is cheap in practice because
 * the caller skips unchanged lists by `hs_list_size` before getting here.
 */
export async function fetchListCompanies(
  tokenProvider: TokenProvider,
  listId: string,
  opts?: HsCallOpts
): Promise<HubspotListContact[]> {
  const rawIds = await fetchListMemberIds(tokenProvider, listId, opts);
  const ids = [...new Set(rawIds)];
  if (ids.length === 0) return [];
  return fetchCompanyProps(tokenProvider, ids, opts);
}

/** Batch-read contacts to get email + phone for the given record IDs. */
async function fetchContactProps(
  tokenProvider: TokenProvider,
  ids: string[],
  opts?: HsCallOpts
): Promise<HubspotListContact[]> {
  const propsById = await batchReadContactProperties(
    tokenProvider,
    ids,
    ["email", "phone", "hs_email_domain"],
    opts
  );

  const out: HubspotListContact[] = [];
  for (const [id, properties] of propsById) {
    out.push({
      hubspot_id: id,
      email: properties.email ?? null,
      phone: properties.phone ?? null,
      email_domain: properties.hs_email_domain ?? null,
    });
  }

  return out;
}

/**
 * Full snapshot of a HubSpot list's contacts (email + phone + email domain).
 *
 * When `opts.known` is provided (a map of hubspot_id -> previously-fetched
 * HubspotListContact, e.g. reconstructed from cached `dnc_entries`), member
 * ids already present in it are reused as-is and only the NEW ids are
 * batch-read — the incremental-sync path from the optimization spec. Without
 * `known` (or on the first sync) this behaves exactly as before: every
 * member id is batch-read. Membership ids are deduped before use.
 */
export async function fetchListContacts(
  tokenProvider: TokenProvider,
  listId: string,
  opts?: HsCallOpts & { known?: Map<string, HubspotListContact> }
): Promise<HubspotListContact[]> {
  const rawIds = await fetchListMemberIds(tokenProvider, listId, opts);
  const ids = [...new Set(rawIds)];
  if (ids.length === 0) return [];

  const known = opts?.known;
  if (!known || known.size === 0) {
    return fetchContactProps(tokenProvider, ids, opts);
  }

  const knownContacts: HubspotListContact[] = [];
  const unknownIds: string[] = [];
  for (const id of ids) {
    const cached = known.get(id);
    if (cached) knownContacts.push(cached);
    else unknownIds.push(id);
  }

  const freshContacts = unknownIds.length > 0 ? await fetchContactProps(tokenProvider, unknownIds, opts) : [];
  return [...knownContacts, ...freshContacts];
}
