/**
 * Push-to-CRM state + backfill (Phase 4).
 *
 * A lead pushed via POST /admin/hubspot/contacts is always recorded with a
 * `push_status`. When the customer's CRM isn't connected yet (no portal, or the
 * OAuth grant hasn't been granted), the push is STORED as 'pending' rather than
 * erroring — we routinely build a customer's list weeks before receiving their
 * HubSpot access. Once access arrives, `backfillClient` replays every
 * non-'pushed' lead through the CRM adapter and flips its status.
 *
 * ⚠️ WHERE that state lives is now a migration in progress (GTMOS doc 34 §8).
 * Historically: `contact_clients` here. The destination: GTMOS `leads`, which is
 * the source of truth for the ledger and the only place the /leads page, the MCP
 * tools and the REST API can see. Two flags move it, and
 * services/gtmos-leads.service.ts documents them:
 *
 *   GTMOS_LEADS_WRITE_ENABLED  → dual-write; contact_clients still authoritative
 *   GTMOS_LEADS_AUTHORITATIVE  → GTMOS is the record; contact_clients not written
 *                                and the backfill queue is read from GTMOS
 *
 * ⚠️ The `contact_clients` COLUMNS are deliberately not dropped. This service's
 * `start` script runs `prisma db push` WITHOUT `--accept-data-loss`; a
 * destructive drop crash-loops the deploy. They stop being written first, and
 * are removed later in their own deliberate migration.
 */
import type { Client } from "@prisma/client";
import prisma from "../db/prisma";
import { getCrmAdapter } from "../crm/registry";
import { dncService, normalizeCheckIdentifiers } from "./dnc.service";
import {
  fetchPendingPushLeads,
  gtmosAuthoritative,
  gtmosWriteEnabled,
  pushLeadsToGtmos,
  type GtmosLeadPayload,
  type GtmosPendingLead,
} from "./gtmos-leads.service";

export type PushStatus = "pending" | "pushed" | "failed" | "skipped_dnc";

interface UpsertPushLinkParams {
  clientId: string;
  contactId: string;
  status: PushStatus;
  /** CRM property snapshot to (re)push. Only written when provided. */
  properties?: Record<string, any>;
  /** DNC-enforcement intent. Only written when provided. */
  checkDnc?: boolean;
  /** HubSpot id once pushed. Pass null to leave unchanged on update. */
  hubspotContactId?: string | null;
  error?: string | null;
  /** Bump push_attempts (true for real push attempts, false for a plain store). */
  incrementAttempt?: boolean;
}

/**
 * Send one lead's push outcome to the GTMOS ledger.
 *
 * Loads the profile and client here rather than threading them through every
 * caller: the push path is low-volume (one contact per request), and a lookup
 * that is always correct beats an optional parameter that half the call sites
 * forget to pass.
 *
 * ⚠️ Resolves the client by HUBSPOT PORTAL ID first, external_id second. TTT's
 * `external_id` and GTMOS's `slug` diverge for a meaningful share of clients
 * (`bridgeit`/`bridge-it`, `gtg`/`geographic-technologies-group`) — GTMOS doc 33
 * §7.1 measured 4,597 of 5,373 ledger rows landing on the wrong client under
 * slug-first resolution. Both are sent; GTMOS prefers the portal.
 */
async function mirrorToGtmos(params: {
  clientId: string;
  contactId: string;
  status: PushStatus;
  properties?: Record<string, any>;
  checkDnc?: boolean;
  hubspotContactId?: string | null;
  error?: string | null;
  attempts: number;
  firstSeenAt: Date;
  lastAttemptAt: Date;
}): Promise<void> {
  try {
    const [profile, client] = await Promise.all([
      prisma.profile.findUnique({ where: { id: params.contactId } }),
      prisma.client.findUnique({ where: { id: params.clientId } }),
    ]);
    if (!profile || !client) return;

    const props = params.properties ?? {};
    const payload: GtmosLeadPayload = {
      hubspot_portal_id: client.hubspot_portal_id ?? null,
      client_slug: client.external_id,

      email: profile.email ?? props.email ?? null,
      phone: profile.phone_e164 ?? props.phone ?? null,
      linkedin_url: profile.linkedin_url ?? null,
      first_name: props.firstname ?? props.first_name ?? null,
      last_name: props.lastname ?? props.last_name ?? null,
      // The successor key: lets GTMOS resolve this row forward to the same
      // person on every subsequent push, even if the email later changes.
      ttt_profile_id: profile.id,

      company_name: props.company ?? null,
      job_title: props.jobtitle ?? props.job_title ?? null,
      website: props.website ?? null,

      campaign_name: props.campaign_name ?? null,
      campaign_type: props.campaign_type ?? null,
      lead_origin: props.lead_origin ?? null,
      lead_origin_details: props.lead_origin_details ?? null,

      // ⚠️ The lead's "date added" is when WE first saw it, not now(). A
      // defaulted timestamp would restamp every re-push with today's date and
      // destroy the cohort view on the GTMOS side.
      first_seen_at: params.firstSeenAt.toISOString(),

      crm_platform: "hubspot",
      hubspot_contact_id: params.hubspotContactId ?? null,
      push_status: params.status,
      push_properties: params.properties ?? null,
      push_check_dnc: params.checkDnc,
      push_attempts: params.attempts,
      push_error: params.error ?? null,
      last_push_attempt_at: params.lastAttemptAt.toISOString(),
      dnc_status: params.status === "skipped_dnc" ? true : undefined,

      source_system: "ttt_api",
      external_ids: { ttt_profile_id: profile.id },
    };

    const result = await pushLeadsToGtmos([payload]);
    if (!result.ok) {
      console.warn(`[contact-push] GTMOS mirror failed (non-fatal): ${result.error}`);
    }
  } catch (err: any) {
    console.warn(`[contact-push] GTMOS mirror threw (non-fatal): ${err?.message ?? err}`);
  }
}

/**
 * One row of the backfill work queue, whichever side it came from.
 *
 * Only the four fields the replay loop actually reads. Keeping it this narrow
 * is deliberate: a wider type would tempt the loop into using a field only one
 * of the two sources can supply, and the divergence would show up as a
 * mode-specific bug months later.
 */
interface BackfillRow {
  contact_id: string;
  email: string | null;
  phone: string | null;
  push_properties: Record<string, any>;
  push_check_dnc: boolean;
}

function fromGtmosPending(lead: GtmosPendingLead): BackfillRow {
  return {
    // The GTMOS lead carries our profile id forward (mirrorToGtmos sets it), so
    // the status write-back below still addresses a TTT profile. Falling back to
    // the GTMOS lead id would write a foreign key that resolves to nothing here.
    contact_id: lead.ttt_profile_id ?? lead.lead_id,
    email: lead.email,
    phone: lead.phone_e164 ?? lead.phone,
    push_properties: lead.push_properties ?? {},
    push_check_dnc: lead.push_check_dnc,
  };
}

export const contactPushService = {
  /**
   * Upsert the contact_clients row carrying this lead's push state. Idempotent
   * on (contact_id, client_id). Created rows are tagged source='pushed'; an
   * existing association's source is never downgraded.
   */
  async upsertPushLink(params: UpsertPushLinkParams) {
    const { clientId, contactId, status, properties, checkDnc, hubspotContactId, error, incrementAttempt } = params;
    const now = new Date();

    // ⚠️ Even in authoritative mode the LINK is still written — only the push_*
    // columns stop. `contact_clients` is two things at once: a record of the
    // push (which is moving to GTMOS) and the profile↔client bridge that
    // enrichment attribution and cross-customer reuse are counted from (which
    // is not). Dropping the row entirely would take the second with the first.
    const pushState = gtmosAuthoritative()
      ? {}
      : {
          push_status: status,
          push_error: error ?? null,
          last_push_attempt_at: now,
          ...(properties ? { push_properties: properties } : {}),
          ...(checkDnc !== undefined ? { push_check_dnc: checkDnc } : {}),
          ...(hubspotContactId !== undefined ? { hubspot_contact_id: hubspotContactId } : {}),
          ...(incrementAttempt ? { push_attempts: { increment: 1 } } : {}),
        };

    const row = await prisma.contactClient.upsert({
      where: { contact_id_client_id: { contact_id: contactId, client_id: clientId } },
      update: pushState,
      create: {
        contact_id: contactId,
        client_id: clientId,
        source: "pushed",
        last_enriched_at: now,
        ...(gtmosAuthoritative()
          ? {}
          : {
              push_status: status,
              push_check_dnc: checkDnc ?? true,
              push_error: error ?? null,
              push_attempts: incrementAttempt ? 1 : 0,
              last_push_attempt_at: now,
              ...(properties ? { push_properties: properties } : {}),
              ...(hubspotContactId ? { hubspot_contact_id: hubspotContactId } : {}),
            }),
      },
    });

    // Mirror into the GTMOS ledger. Fire-and-log: see the header note — a push
    // that already reached the customer's HubSpot must not be reported as a
    // failure because our bookkeeping call didn't land.
    if (gtmosWriteEnabled()) {
      await mirrorToGtmos({
        clientId,
        contactId,
        status,
        properties,
        checkDnc,
        hubspotContactId,
        error,
        attempts: row.push_attempts,
        firstSeenAt: row.first_seen_at,
        lastAttemptAt: now,
      });
    }

    return row;
  },

  /** How many leads are waiting (pending) / errored (failed) per status. */
  async pushCounts(clientId: string): Promise<Record<string, number>> {
    const rows = await prisma.contactClient.groupBy({
      by: ["push_status"],
      where: { client_id: clientId, push_status: { not: null } },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) if (r.push_status) out[r.push_status] = r._count._all;
    return out;
  },

  /**
   * Replay stored leads into the client's CRM. Call once HubSpot access lands.
   * Re-enforces DNC per row (a lead may have been suppressed while it waited),
   * updates each row's status, and returns a per-run summary.
   */
  async backfillClient(
    client: Client,
    opts: { limit?: number; dryRun?: boolean; statuses?: PushStatus[] } = {}
  ) {
    const { dryRun = false } = opts;
    const statuses = opts.statuses?.length ? opts.statuses : (["pending", "failed"] as PushStatus[]);
    const take = Math.min(1000, Math.max(1, opts.limit ?? 200));

    const summary = {
      client_id: client.external_id,
      hubspot_portal_id: client.hubspot_portal_id,
      dry_run: dryRun,
      candidates: 0,
      created: 0,
      updated: 0,
      skipped_dnc: 0,
      still_pending: 0,
      failed: 0,
      results: [] as Array<Record<string, any>>,
    };

    if (!client.hubspot_portal_id) {
      return { ...summary, error: "client has no hubspot_portal_id — cannot backfill" };
    }
    const adapter = getCrmAdapter("hubspot");
    if (!adapter) return { ...summary, error: "no CRM adapter available for hubspot" };

    // ── The work queue ─────────────────────────────────────────────────────────
    //
    // In authoritative mode this comes from GTMOS, which is the whole point of
    // the consolidation: if the queue were still read locally, `contact_clients`
    // would remain the operational source of truth no matter what the writes
    // did, and the second home would never actually close (doc 34 §8).
    //
    // Normalized to one shape so the loop below is identical either way — the
    // alternative is two copies of the DNC re-check and the status transitions,
    // which is exactly where a "we fixed it in one path" bug lives.
    const rows: BackfillRow[] = gtmosAuthoritative()
      ? (
          await fetchPendingPushLeads({
            hubspotPortalId: client.hubspot_portal_id,
            clientSlug: client.external_id,
            statuses,
            limit: take,
          })
        ).map(fromGtmosPending)
      : (
          await prisma.contactClient.findMany({
            where: { client_id: client.id, push_status: { in: statuses } },
            include: { contact: true },
            orderBy: { first_seen_at: "asc" },
            take,
          })
        ).map((r) => ({
          contact_id: r.contact_id,
          email: r.contact.email,
          phone: r.contact.phone_e164,
          push_properties: (r.push_properties as Record<string, any>) ?? {},
          push_check_dnc: r.push_check_dnc,
        }));

    summary.candidates = rows.length;

    for (const row of rows) {
      const props = row.push_properties;
      const email = props.email ?? row.email ?? undefined;
      const base = { contact_id: row.contact_id, email } as Record<string, any>;

      // Re-enforce DNC — the lead may have been suppressed while it waited.
      if (row.push_check_dnc) {
        const match = await dncService.findMatch(
          client.id,
          normalizeCheckIdentifiers({ email, phone: props.phone })
        );
        if (match) {
          if (!dryRun)
            await this.upsertPushLink({ clientId: client.id, contactId: row.contact_id, status: "skipped_dnc", error: null });
          summary.skipped_dnc++;
          summary.results.push({ ...base, outcome: "skipped_dnc", matched_on: match.matchedOn });
          continue;
        }
      }

      if (Object.keys(props).length === 0) {
        summary.failed++;
        summary.results.push({ ...base, outcome: "failed", error: "no stored push_properties to replay" });
        if (!dryRun)
          await this.upsertPushLink({ clientId: client.id, contactId: row.contact_id, status: "failed", error: "no stored push_properties to replay" });
        continue;
      }

      if (dryRun) {
        summary.results.push({ ...base, outcome: "would_push" });
        continue;
      }

      const push = await adapter.upsertContact({ properties: props }, { accountId: client.hubspot_portal_id });
      if (push.ok) {
        await this.upsertPushLink({
          clientId: client.id,
          contactId: row.contact_id,
          status: "pushed",
          hubspotContactId: push.externalId,
          error: null,
          incrementAttempt: true,
        });
        if (push.action === "created") summary.created++;
        else summary.updated++;
        summary.results.push({ ...base, outcome: push.action, hubspot_contact_id: push.externalId });
      } else {
        // Still not connected → keep it pending; anything else → failed (retryable next run).
        const status: PushStatus = push.notConnected ? "pending" : "failed";
        await this.upsertPushLink({
          clientId: client.id,
          contactId: row.contact_id,
          status,
          error: push.error,
          incrementAttempt: true,
        });
        if (status === "pending") summary.still_pending++;
        else summary.failed++;
        summary.results.push({ ...base, outcome: status, error: push.error });
      }
    }

    return summary;
  },
};
