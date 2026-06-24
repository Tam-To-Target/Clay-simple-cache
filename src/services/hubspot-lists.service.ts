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
}

interface MembershipsResponse {
  results?: { recordId: string }[];
  paging?: { next?: { after?: string } };
}

interface BatchReadResponse {
  results?: { id: string; properties?: Record<string, string | null> }[];
}

async function hsFetch(
  path: string,
  token: string,
  init?: RequestInit
): Promise<Response> {
  return fetch(`${HUBSPOT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

/** Page through a list's memberships and return all contact record IDs. */
async function fetchListMemberIds(token: string, listId: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;

  do {
    const params = new URLSearchParams({ limit: String(MEMBERSHIP_PAGE_SIZE) });
    if (after) params.set("after", after);

    const res = await hsFetch(`/crm/v3/lists/${listId}/memberships?${params}`, token);
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
  token: string,
  ids: string[]
): Promise<HubspotListContact[]> {
  const out: HubspotListContact[] = [];

  for (let i = 0; i < ids.length; i += BATCH_READ_SIZE) {
    const batch = ids.slice(i, i + BATCH_READ_SIZE);
    const res = await hsFetch(`/crm/v3/objects/contacts/batch/read`, token, {
      method: "POST",
      body: JSON.stringify({
        properties: ["email", "phone"],
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
      });
    }
  }

  return out;
}

/** Full snapshot of a HubSpot list's contacts (email + phone). */
export async function fetchListContacts(
  token: string,
  listId: string
): Promise<HubspotListContact[]> {
  const ids = await fetchListMemberIds(token, listId);
  if (ids.length === 0) return [];
  return fetchContactProps(token, ids);
}
