/**
 * Create/update contacts in a client's HubSpot portal (CRM v3 Contacts API).
 *
 * Auth is the per-portal token resolved (and refreshed on 401) via the
 * provisioner — same path the DNC sync uses. Creating a contact whose email
 * already exists is treated as an update (HubSpot returns 409 with the existing
 * id), so the endpoint is idempotent.
 */
import { getValidToken } from "./hubspot-token.service";

const HUBSPOT_BASE = "https://api.hubapi.com";

/** Allowed values for the `campaign_type` enum (from the provisioner property def). */
export const CAMPAIGN_TYPE_OPTIONS = [
  "Inbound",
  "Targeted List",
  "Signal",
  "Event",
  "ICP Fit",
] as const;

/** Resolve a caller-supplied campaign_type to its canonical value (case-insensitive). */
export function normalizeCampaignType(input: string): string | null {
  const v = String(input).trim().toLowerCase();
  return CAMPAIGN_TYPE_OPTIONS.find((o) => o.toLowerCase() === v) ?? null;
}

/** Error carrying the upstream HTTP status so the controller can map 4xx vs 5xx. */
export class HubspotApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HubspotApiError";
    this.status = status;
  }
}

async function hsFetch(portalId: string, path: string, init: RequestInit): Promise<Response> {
  const doFetch = (token: string) =>
    fetch(`${HUBSPOT_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });

  let res = await doFetch(await getValidToken(portalId));
  if (res.status === 401) res = await doFetch(await getValidToken(portalId, { force: true }));
  return res;
}

export interface UpsertContactResult {
  /** true if a new contact was created, false if an existing one was updated. */
  created: boolean;
  id: string;
  properties: Record<string, any>;
}

/**
 * Create a contact; if one with the same email already exists, update it instead.
 * `properties` keys must be HubSpot internal property names.
 */
export async function upsertHubspotContact(
  portalId: string,
  properties: Record<string, any>
): Promise<UpsertContactResult> {
  const createRes = await hsFetch(portalId, `/crm/v3/objects/contacts`, {
    method: "POST",
    body: JSON.stringify({ properties }),
  });

  if (createRes.ok) {
    const json = (await createRes.json()) as { id: string; properties: Record<string, any> };
    return { created: true, id: json.id, properties: json.properties };
  }

  // Already exists → update the existing contact (idempotent upsert).
  if (createRes.status === 409) {
    const body = await createRes.text().catch(() => "");
    const existingId = body.match(/Existing ID:\s*(\d+)/i)?.[1] ?? body.match(/"id"\s*:\s*"?(\d+)"?/)?.[1];
    if (!existingId) {
      throw new HubspotApiError(`Contact already exists but existing id was not parseable: ${body}`, 409);
    }
    const updRes = await hsFetch(portalId, `/crm/v3/objects/contacts/${existingId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties }),
    });
    if (updRes.ok) {
      const json = (await updRes.json()) as { id: string; properties: Record<string, any> };
      return { created: false, id: existingId, properties: json.properties };
    }
    const updBody = await updRes.text().catch(() => "");
    throw new HubspotApiError(
      `Contact exists (id ${existingId}) but update failed: HTTP ${updRes.status} ${updBody}`,
      updRes.status
    );
  }

  const body = await createRes.text().catch(() => "");
  throw new HubspotApiError(`HubSpot contact create failed: HTTP ${createRes.status} ${body}`, createRes.status);
}

/**
 * PATCH arbitrary properties onto an existing object by id. Used by fit scoring
 * to write the computed score + reasoning onto the record the caller names
 * (default object type "contacts"; e.g. "companies" for account-level scoring).
 * The record must already exist — scoring pushes onto a known target, it does
 * not create records.
 */
export async function updateObjectProperties(
  portalId: string,
  objectType: string,
  objectId: string,
  properties: Record<string, any>
): Promise<void> {
  const res = await hsFetch(portalId, `/crm/v3/objects/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HubspotApiError(
      `Update ${objectType}/${objectId} failed: HTTP ${res.status} ${body}`,
      res.status
    );
  }
}

/**
 * Find company record ids whose `domain` exactly matches (case-insensitive; the
 * caller passes an already-normalized bare domain). Returns all matching ids so
 * the caller can detect/handle duplicates. Used by fit-score push to locate the
 * target company when no explicit object id is supplied.
 */
export async function searchCompanyIdsByDomain(
  portalId: string,
  domain: string
): Promise<string[]> {
  const res = await hsFetch(portalId, `/crm/v3/objects/companies/search`, {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }],
      properties: ["domain"],
      limit: 10,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HubspotApiError(`Company search by domain failed: HTTP ${res.status} ${body}`, res.status);
  }
  const json = (await res.json()) as { results?: Array<{ id: string }> };
  return (json.results || []).map((r) => r.id);
}

/** Create an object of `objectType` with `properties`; returns the new id. */
export async function createObject(
  portalId: string,
  objectType: string,
  properties: Record<string, any>
): Promise<string> {
  const res = await hsFetch(portalId, `/crm/v3/objects/${encodeURIComponent(objectType)}`, {
    method: "POST",
    body: JSON.stringify({ properties }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HubspotApiError(`Create ${objectType} failed: HTTP ${res.status} ${body}`, res.status);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

/** Delete a contact by id (used for test cleanup). */
export async function deleteHubspotContact(portalId: string, id: string): Promise<void> {
  const res = await hsFetch(portalId, `/crm/v3/objects/contacts/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new HubspotApiError(`Delete contact ${id} failed: HTTP ${res.status}`, res.status);
  }
}
