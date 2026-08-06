/**
 * GTMOS lead ledger client — the consolidation of lead state into one database
 * (GTMOS doc 34 §8).
 *
 * Until now a lead pushed through `POST /admin/hubspot/contacts` was recorded
 * in THIS service's `contact_clients` table. GTMOS doc 33 moved the columns
 * (push_status, push_properties, crm_contact_id, …) onto its own `leads` table
 * and made it the source of truth. This module is how that becomes true in
 * practice rather than only on paper.
 *
 * TWO FLAGS, because a live push path is not something to cut over in one step:
 *
 *   GTMOS_LEADS_WRITE_ENABLED=true
 *     Every push ALSO writes the lead to GTMOS. `contact_clients` is still
 *     written. Dual-write — this is the parallel-run window (doc 33 §7.3), and
 *     the nightly reconciler diffs the two so a divergence is visible before
 *     anything depends on it.
 *
 *   GTMOS_LEADS_AUTHORITATIVE=true
 *     GTMOS is the record. `contact_clients` writes stop, and `backfillClient`
 *     reads its work queue from GTMOS rather than from local rows. This is the
 *     destination: one home for lead state.
 *
 * ⚠️ NEVER THROWS ON A PUSH THAT ALREADY SUCCEEDED. If the lead reached the
 * customer's HubSpot and only the GTMOS write failed, the push was a success —
 * reporting it as a failure would make the GTME team re-push a contact that is
 * already there. Write failures are logged and swallowed; GTMOS's nightly
 * reconciler closes the gap. The QUEUE read is different and does throw: a
 * backfill that silently treats an unreachable queue as "nothing to do" would
 * report success having pushed nothing.
 */

export interface GtmosLeadPayload {
  client_id?: string | null;
  hubspot_portal_id?: string | null;
  client_slug?: string | null;

  email?: string | null;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  linkedin_url?: string | null;
  ttt_profile_id?: string | null;

  company_name?: string | null;
  company_domain?: string | null;
  job_title?: string | null;
  website?: string | null;

  lead_source?: string | null;
  lead_origin?: string | null;
  lead_origin_details?: string | null;
  campaign_name?: string | null;
  campaign_type?: string | null;

  first_seen_at?: string | null;
  dnc_status?: boolean | null;
  dnc_matched_on?: string | null;

  crm_platform?: string | null;
  hubspot_contact_id?: string | null;
  push_status?: string | null;
  push_properties?: Record<string, any> | null;
  push_check_dnc?: boolean | null;
  push_attempts?: number | null;
  push_error?: string | null;
  last_push_attempt_at?: string | null;

  source_system?: string | null;
  external_ids?: Record<string, any> | null;
}

export interface GtmosPendingLead {
  lead_id: string;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  ttt_profile_id: string | null;
  push_status: string | null;
  push_properties: Record<string, any>;
  push_check_dnc: boolean;
  push_attempts: number;
  push_error: string | null;
  crm_contact_id: string | null;
  added_at: string | null;
}

/** Dual-write on. Leads are mirrored into GTMOS on every push. */
export function gtmosWriteEnabled(): boolean {
  return (
    process.env.GTMOS_LEADS_WRITE_ENABLED === "true" || gtmosAuthoritative()
  );
}

/**
 * GTMOS owns lead state. `contact_clients` stops being written and the push
 * queue is read from GTMOS.
 *
 * Implies write-enabled (see above) — being authoritative without writing there
 * would mean the record of a push lives nowhere at all, which is worse than
 * either endpoint of the migration.
 */
export function gtmosAuthoritative(): boolean {
  return process.env.GTMOS_LEADS_AUTHORITATIVE === "true";
}

function config(): { baseUrl: string; secret: string } | null {
  const baseUrl = process.env.SDR_LAUNCH_INTERNAL_URL;
  // The INBOUND credential GTMOS checks on /api/internal/leads. Distinct from
  // SDR_LAUNCH_INTERNAL_SECRET (which GTMOS's own internal routes accept) only
  // if the deployment configures it so; both are read here in that order.
  const secret =
    process.env.GTMOS_LEADS_INTERNAL_SECRET ?? process.env.SDR_LAUNCH_INTERNAL_SECRET;
  if (!baseUrl || !secret) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), secret };
}

/**
 * Mirror one or more leads into GTMOS.
 *
 * Returns a summary rather than throwing. `{ ok: false }` means the ledger did
 * not record the push; it never means the push itself failed.
 */
export async function pushLeadsToGtmos(
  leads: GtmosLeadPayload[]
): Promise<{ ok: boolean; created?: number; updated?: number; failed?: number; error?: string }> {
  if (leads.length === 0) return { ok: true, created: 0, updated: 0, failed: 0 };

  const cfg = config();
  if (!cfg) {
    return { ok: false, error: "SDR_LAUNCH_INTERNAL_URL / secret not configured" };
  }

  try {
    const res = await fetch(`${cfg.baseUrl}/api/internal/leads`, {
      method: "POST",
      headers: { "X-Internal-Secret": cfg.secret, "Content-Type": "application/json" },
      // The route accepts a bare object or `{ leads: [...] }`; always send the
      // batch shape so a one-item push and a 500-item backfill take the same
      // code path on both sides.
      body: JSON.stringify({ leads }),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    // 207 is PARTIAL success and must not read as failure — some rows landed.
    if (!res.ok && res.status !== 207) {
      return { ok: false, error: `HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}` };
    }
    return {
      ok: true,
      created: body.created ?? 0,
      updated: body.updated ?? 0,
      failed: body.failed ?? 0,
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Fetch the CRM push queue for one client from GTMOS.
 *
 * ⚠️ THROWS on a transport or configuration failure, unlike the write above.
 * A backfill that treats an unreachable queue as an empty one would print
 * "0 candidates, done" and look like a clean run having pushed nothing.
 */
export async function fetchPendingPushLeads(opts: {
  clientSlug?: string | null;
  hubspotPortalId?: string | null;
  clientId?: string | null;
  statuses?: string[];
  limit?: number;
}): Promise<GtmosPendingLead[]> {
  const cfg = config();
  if (!cfg) {
    throw new Error(
      "GTMOS_LEADS_AUTHORITATIVE is on but SDR_LAUNCH_INTERNAL_URL / secret is not configured"
    );
  }

  const params = new URLSearchParams();
  // Portal id first, slug second — TTT's external_id and GTMOS's slug diverge
  // for a meaningful share of clients (bridgeit/bridge-it, gtg/
  // geographic-technologies-group), and resolving on the slug alone misfiles
  // them (GTMOS doc 33 §7.1).
  if (opts.clientId) params.set("client_id", opts.clientId);
  if (opts.hubspotPortalId) params.set("hubspot_portal_id", opts.hubspotPortalId);
  if (opts.clientSlug) params.set("client_slug", opts.clientSlug);
  if (opts.statuses?.length) params.set("statuses", opts.statuses.join(","));
  params.set("limit", String(Math.min(1000, Math.max(1, opts.limit ?? 200))));

  const res = await fetch(`${cfg.baseUrl}/api/internal/leads/pending-push?${params}`, {
    headers: { "X-Internal-Secret": cfg.secret },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GTMOS pending-push failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { leads?: GtmosPendingLead[] };
  return json.leads ?? [];
}
