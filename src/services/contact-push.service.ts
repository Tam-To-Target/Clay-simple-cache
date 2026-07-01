/**
 * Push-to-CRM state + backfill (Phase 4).
 *
 * A lead pushed via POST /admin/hubspot/contacts is always recorded on the
 * contact_clients bridge with a `push_status`. When the customer's CRM isn't
 * connected yet (no portal, or the OAuth grant hasn't been granted), the push is
 * STORED as 'pending' rather than erroring — we routinely build a customer's
 * list weeks before receiving their HubSpot access. Once access arrives,
 * `backfillClient` replays every non-'pushed' lead through the CRM adapter and
 * flips its status.
 */
import type { Client } from "@prisma/client";
import prisma from "../db/prisma";
import { getCrmAdapter } from "../crm/registry";
import { dncService, normalizeCheckIdentifiers } from "./dnc.service";

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

export const contactPushService = {
  /**
   * Upsert the contact_clients row carrying this lead's push state. Idempotent
   * on (contact_id, client_id). Created rows are tagged source='pushed'; an
   * existing association's source is never downgraded.
   */
  async upsertPushLink(params: UpsertPushLinkParams) {
    const { clientId, contactId, status, properties, checkDnc, hubspotContactId, error, incrementAttempt } = params;
    const now = new Date();
    return prisma.contactClient.upsert({
      where: { contact_id_client_id: { contact_id: contactId, client_id: clientId } },
      update: {
        push_status: status,
        push_error: error ?? null,
        last_push_attempt_at: now,
        ...(properties ? { push_properties: properties } : {}),
        ...(checkDnc !== undefined ? { push_check_dnc: checkDnc } : {}),
        ...(hubspotContactId !== undefined ? { hubspot_contact_id: hubspotContactId } : {}),
        ...(incrementAttempt ? { push_attempts: { increment: 1 } } : {}),
      },
      create: {
        contact_id: contactId,
        client_id: clientId,
        source: "pushed",
        push_status: status,
        push_check_dnc: checkDnc ?? true,
        push_error: error ?? null,
        push_attempts: incrementAttempt ? 1 : 0,
        last_push_attempt_at: now,
        last_enriched_at: now,
        ...(properties ? { push_properties: properties } : {}),
        ...(hubspotContactId ? { hubspot_contact_id: hubspotContactId } : {}),
      },
    });
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

    const rows = await prisma.contactClient.findMany({
      where: { client_id: client.id, push_status: { in: statuses } },
      include: { contact: true },
      orderBy: { first_seen_at: "asc" },
      take,
    });
    summary.candidates = rows.length;

    for (const row of rows) {
      const props = ((row.push_properties as Record<string, any>) ?? {}) as Record<string, any>;
      const email = props.email ?? row.contact.email ?? undefined;
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
