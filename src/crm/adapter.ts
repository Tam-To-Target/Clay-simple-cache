/**
 * Shared CRM-egress contract (Phase 4) — the Contact Platform side.
 *
 * Mirrors the canonical contract defined in GTMOS (lib/crm/adapter.ts). Contact
 * egress flows through this interface so adding a CRM (Salesforce, …) is one new
 * adapter, and the HubSpot push logic doesn't drift between the two services.
 */

export interface CrmContact {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  jobTitle?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  /** Extra CRM-native properties, set verbatim. */
  properties?: Record<string, any>;
}

export interface CrmContext {
  /** HubSpot portalId, Salesforce accountId, etc. */
  accountId: string;
}

export type CrmPushResult =
  | { ok: true; action: "created" | "updated"; externalId: string }
  | {
      ok: false;
      retryable: boolean;
      code: number | null;
      error: string;
      /**
       * The account isn't connected/authorized (OAuth grant missing or revoked),
       * as opposed to a transient error. A "store the lead and backfill later"
       * signal — callers should NOT treat this as a hard failure.
       */
      notConnected?: boolean;
    };

export interface CrmAdapter {
  readonly platform: string;
  upsertContact(contact: CrmContact, ctx: CrmContext): Promise<CrmPushResult>;
}
