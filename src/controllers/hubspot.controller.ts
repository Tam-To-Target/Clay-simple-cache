import { Request, Response } from "express";
import { clientService, clientSuggestions } from "../services/client.service";
import { dncService, normalizeCheckIdentifiers } from "../services/dnc.service";
import { profileService } from "../services/profile.service";
import { contactPushService } from "../services/contact-push.service";
import { normalizeEmail, normalizePhone, normalizeLinkedIn } from "../services/normalization";
import {
  normalizeCampaignType,
  CAMPAIGN_TYPE_OPTIONS,
} from "../services/hubspot-contacts.service";
import { getCrmAdapter } from "../crm/registry";

/**
 * Cache the lead as a canonical Profile (best-effort — recordProfile never
 * throws) and return its id so we can link it to the customer on the
 * contact_clients bridge. `extra` carries reserved provenance (e.g. last_push).
 */
async function cacheLeadProfile(
  properties: Record<string, any>,
  extra: Record<string, unknown> = {}
): Promise<string | null> {
  const phone = properties.phone ? normalizePhone(String(properties.phone)) : null;
  const linkedinUrl = properties.linkedin_url ? String(properties.linkedin_url) : undefined;
  const { profile_id } = await profileService.recordProfile(
    {
      email: properties.email ? normalizeEmail(String(properties.email)) : undefined,
      phone_e164: phone?.e164,
      linkedin_url: linkedinUrl,
      linkedin_slug: linkedinUrl ? normalizeLinkedIn(linkedinUrl) || undefined : undefined,
    },
    {
      ...properties,
      ...(phone?.national ? { phone_national: phone.national } : {}),
      ...extra,
    }
  );
  return profile_id;
}

// Fields the contact MUST carry (HubSpot internal property names). `email` is the
// identity; the rest are TAM's standard outbound attribution properties.
const REQUIRED_PROPERTIES = [
  "email",
  "campaign_name",
  "campaign_type",
  "lead_origin",
  "lead_origin_details",
];

// Body keys that control the request rather than becoming HubSpot properties.
const CONTROL_KEYS = new Set(["client_id", "check_dnc", "properties"]);

export const hubspotController = {
  /**
   * POST /admin/hubspot/contacts
   * Body: {
   *   client_id, email, campaign_name, campaign_type, lead_origin, lead_origin_details,
   *   check_dnc?: boolean,            // if true, skip the push when the contact is suppressed
   *   properties?: { <internal>: val }, // extra HubSpot properties
   *   ...<internal>: val              // extra properties may also be top-level
   * }
   * Creates the contact in the client's HubSpot portal (updates if the email
   * already exists). Any extra key must be a valid HubSpot internal property name.
   */
  async createContact(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body || {};
      const { client_id, check_dnc } = body;

      if (!client_id) {
        res.status(400).json({ error: "client_id is required" });
        return;
      }

      // Collect properties: top-level keys (minus control keys) + nested `properties`.
      const properties: Record<string, any> = {};
      for (const [k, v] of Object.entries(body)) {
        if (!CONTROL_KEYS.has(k) && v !== undefined && v !== null) properties[k] = v;
      }
      if (body.properties && typeof body.properties === "object") {
        for (const [k, v] of Object.entries(body.properties)) {
          if (v !== undefined && v !== null) properties[k] = v;
        }
      }

      const missing = REQUIRED_PROPERTIES.filter(
        (k) => properties[k] === undefined || String(properties[k]).trim() === ""
      );
      if (missing.length) {
        res.status(400).json({ error: `Missing required field(s): ${missing.join(", ")}` });
        return;
      }

      const campaignType = normalizeCampaignType(properties.campaign_type);
      if (!campaignType) {
        res.status(400).json({
          error: `Invalid campaign_type "${properties.campaign_type}". Must be one of: ${CAMPAIGN_TYPE_OPTIONS.join(", ")}`,
        });
        return;
      }
      properties.campaign_type = campaignType;

      const client = await clientService.getByExternalId(client_id);
      if (!client || !client.active) {
        const suggestions = await clientSuggestions(client_id);
        res.status(404).json({
          error: `Unknown or inactive client_id: ${client_id}`,
          ...(suggestions.length ? { suggestions } : {}),
        });
        return;
      }

      // Optional DNC guard — a suppressed contact is neither pushed nor stored.
      if (check_dnc) {
        const ids = normalizeCheckIdentifiers({
          email: properties.email,
          phone: properties.phone,
        });
        const match = await dncService.findMatch(client.id, ids);
        if (match) {
          res.status(200).json({
            status: "do_not_contact",
            created: false,
            pushed: false,
            stored: false,
            client_id,
            reason: match.entry.reason || "Contact is on the client's Do Not Contact list",
            matched_on: match.matchedOn,
            matched_value: match.matchedValue,
          });
          return;
        }
      }

      // Always cache the lead as a canonical Profile first — this gives us the
      // contact_id we link on contact_clients, whether or not it reaches the CRM.
      const contactId = await cacheLeadProfile(properties);

      // ── No CRM connected yet → STORE, don't error. ──────────────────────────
      // We often build a customer's list weeks before their HubSpot access lands.
      // The lead sits as 'pending' and is replayed by /admin/hubspot/backfill.
      if (!client.hubspot_portal_id) {
        if (contactId)
          await contactPushService.upsertPushLink({
            clientId: client.id,
            contactId,
            status: "pending",
            properties,
            checkDnc: !!check_dnc,
          });
        res.status(200).json({
          status: "pending",
          pushed: false,
          stored: true,
          push_status: "pending",
          client_id,
          contact_id: contactId,
          reason: "No HubSpot portal connected yet — lead stored; run /admin/hubspot/backfill once access is granted.",
        });
        return;
      }

      // Egress goes through the shared CRM adapter (Phase 4) — HubSpot today,
      // pluggable for other CRMs. Properties are passed verbatim.
      const adapter = getCrmAdapter("hubspot");
      if (!adapter) {
        res.status(500).json({ error: "No CRM adapter available for hubspot" });
        return;
      }
      const push = await adapter.upsertContact({ properties }, { accountId: client.hubspot_portal_id });

      if (push.ok) {
        // Record push provenance on the shared Profile (namespaced, can't collide
        // with a caller property or the /dnc-check writer).
        await cacheLeadProfile(properties, {
          last_push: {
            client_id,
            hubspot_portal_id: client.hubspot_portal_id,
            hubspot_contact_id: push.externalId,
            at: new Date().toISOString(),
          },
        });
        if (contactId)
          await contactPushService.upsertPushLink({
            clientId: client.id,
            contactId,
            status: "pushed",
            properties,
            checkDnc: !!check_dnc,
            hubspotContactId: push.externalId,
            incrementAttempt: true,
          });
        res.json({
          status: "ok",
          pushed: true,
          stored: true,
          push_status: "pushed",
          created: push.action === "created",
          client_id,
          hubspot_portal_id: client.hubspot_portal_id,
          contact_id: contactId,
          hubspot_contact_id: push.externalId,
          dnc_checked: !!check_dnc,
        });
        return;
      }

      // Portal exists but the OAuth grant isn't active yet → treat like "not
      // connected": store as pending, no error.
      if (push.notConnected) {
        if (contactId)
          await contactPushService.upsertPushLink({
            clientId: client.id,
            contactId,
            status: "pending",
            properties,
            checkDnc: !!check_dnc,
            error: push.error,
            incrementAttempt: true,
          });
        res.status(200).json({
          status: "pending",
          pushed: false,
          stored: true,
          push_status: "pending",
          client_id,
          contact_id: contactId,
          reason: "HubSpot access not active for this portal yet — lead stored; run /admin/hubspot/backfill once access is granted.",
        });
        return;
      }

      // A genuine caller error (bad property, etc.) — surface it, don't store a
      // doomed lead that backfill would retry forever.
      if (!push.retryable && push.code && push.code >= 400 && push.code < 500) {
        res.status(422).json({ error: push.error });
        return;
      }

      // Transient upstream failure (429/5xx). Store as 'failed' so it isn't lost;
      // backfill will retry. Reported with 200 + retryable:true (lossless).
      if (contactId)
        await contactPushService.upsertPushLink({
          clientId: client.id,
          contactId,
          status: "failed",
          properties,
          checkDnc: !!check_dnc,
          error: push.error,
          incrementAttempt: true,
        });
      res.status(200).json({
        status: "stored_push_failed",
        pushed: false,
        stored: true,
        push_status: "failed",
        retryable: true,
        client_id,
        contact_id: contactId,
        error: push.error,
      });
    } catch (error: any) {
      res.status(502).json({ error: error?.message || "Internal server error" });
    }
  },

  /**
   * POST /admin/hubspot/backfill
   * Body: { client_id, limit?, dry_run?, statuses?: string[] }
   * Replays stored leads (default: 'pending' + 'failed') into the client's
   * HubSpot portal once access is available, re-checking DNC per lead and
   * flipping each row's push_status. Use `dry_run:true` to preview.
   */
  async backfill(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, limit, dry_run, statuses } = req.body || {};
      if (!client_id) {
        res.status(400).json({ error: "client_id is required" });
        return;
      }
      const client = await clientService.getByExternalId(client_id);
      if (!client || !client.active) {
        const suggestions = await clientSuggestions(client_id);
        res.status(404).json({
          error: `Unknown or inactive client_id: ${client_id}`,
          ...(suggestions.length ? { suggestions } : {}),
        });
        return;
      }
      if (!client.hubspot_portal_id) {
        res.status(400).json({
          error: `Client ${client_id} still has no hubspot_portal_id — connect HubSpot before backfilling.`,
        });
        return;
      }

      const allowed = ["pending", "failed", "skipped_dnc", "pushed"];
      const requested = Array.isArray(statuses)
        ? statuses.filter((s: unknown): s is string => typeof s === "string" && allowed.includes(s))
        : undefined;

      const summary = await contactPushService.backfillClient(client, {
        limit: limit != null ? Number(limit) : undefined,
        dryRun: dry_run === true || dry_run === "true",
        statuses: requested as any,
      });
      res.json({ status: "ok", ...summary });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },
};
