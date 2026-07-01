/**
 * HubSpot implementation of the shared CrmAdapter contract.
 *
 * Wraps the proven idempotent upsert in hubspot-contacts.service (create →
 * 409-update), translating its result/errors into the CRM-agnostic shape so
 * callers (and a future Salesforce adapter) are uniform.
 */
import {
  upsertHubspotContact,
  HubspotApiError,
} from "../services/hubspot-contacts.service";
import { HubspotAccessError } from "../services/hubspot-token.service";
import type { CrmAdapter, CrmContact, CrmContext, CrmPushResult } from "./adapter";

/** Map a CrmContact to HubSpot contact properties. Pure — unit-tested. */
export function contactToHubSpotProperties(c: CrmContact): Record<string, any> {
  const p: Record<string, any> = {};
  const set = (key: string, v: any) => {
    if (v != null && v !== "") p[key] = v;
  };
  set("email", c.email);
  set("phone", c.phone);
  set("firstname", c.firstName);
  set("lastname", c.lastName);
  set("company", c.company);
  set("jobtitle", c.jobTitle);
  set("hs_linkedin_url", c.linkedinUrl);
  set("website", c.website);
  if (c.properties) {
    // Explicit native properties are forwarded verbatim — including "" so a
    // caller can CLEAR a field on an existing contact (PATCH semantics). Only
    // null/undefined are dropped. (The mapped convenience fields above still
    // skip empties, since those are sugar, not an intentional clear.)
    for (const [k, v] of Object.entries(c.properties)) {
      if (v !== undefined && v !== null) p[k] = v;
    }
  }
  return p;
}

export const hubSpotCrmAdapter: CrmAdapter = {
  platform: "hubspot",

  async upsertContact(contact: CrmContact, ctx: CrmContext): Promise<CrmPushResult> {
    const props = contactToHubSpotProperties(contact);
    if (!props.email && !props.phone) {
      return { ok: false, retryable: false, code: null, error: "contact has neither email nor phone" };
    }
    try {
      const r = await upsertHubspotContact(ctx.accountId, props);
      return { ok: true, action: r.created ? "created" : "updated", externalId: r.id };
    } catch (e) {
      if (e instanceof HubspotAccessError) {
        // The portal's OAuth grant is missing/revoked — access isn't active yet.
        // Not a transient failure: the caller should store & backfill later.
        return { ok: false, retryable: false, code: e.status, error: e.message, notConnected: true };
      }
      if (e instanceof HubspotApiError) {
        // 4xx (bad property, etc.) is fatal; 429/5xx is retryable.
        const retryable = e.status === 429 || e.status >= 500;
        return { ok: false, retryable, code: e.status, error: e.message };
      }
      return {
        ok: false,
        retryable: true,
        code: null,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
