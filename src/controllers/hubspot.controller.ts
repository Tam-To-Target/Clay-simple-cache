import { Request, Response } from "express";
import { clientService, clientSuggestions } from "../services/client.service";
import { dncService, normalizeCheckIdentifiers } from "../services/dnc.service";
import { profileService } from "../services/profile.service";
import { normalizeEmail, normalizePhone, normalizeLinkedIn } from "../services/normalization";
import {
  upsertHubspotContact,
  normalizeCampaignType,
  CAMPAIGN_TYPE_OPTIONS,
  HubspotApiError,
} from "../services/hubspot-contacts.service";

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
      if (!client.hubspot_portal_id) {
        res.status(400).json({ error: `Client ${client_id} has no hubspot_portal_id` });
        return;
      }

      // Optional DNC guard — do not push a suppressed contact.
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
            client_id,
            reason: match.entry.reason || "Contact is on the client's Do Not Contact list",
            matched_on: match.matchedOn,
            matched_value: match.matchedValue,
          });
          return;
        }
      }

      const result = await upsertHubspotContact(client.hubspot_portal_id, properties);

      // Cache the pushed lead as a profile so GET /profiles can return it later
      // (best-effort — recordProfile never throws, so it can't fail the push).
      const phone = properties.phone ? normalizePhone(String(properties.phone)) : null;
      const linkedinUrl = properties.linkedin_url ? String(properties.linkedin_url) : undefined;
      const cached = await profileService.recordProfile(
        {
          email: properties.email ? normalizeEmail(String(properties.email)) : undefined,
          phone_e164: phone?.e164,
          linkedin_url: linkedinUrl,
          linkedin_slug: linkedinUrl ? normalizeLinkedIn(linkedinUrl) || undefined : undefined,
        },
        {
          ...properties,
          ...(phone?.national ? { phone_national: phone.national } : {}),
          // Provenance lives under a reserved namespace so it can never collide
          // with a caller-supplied property (e.g. a contact field named `source`)
          // nor with the /dnc-check writer (which owns `last_dnc_check`).
          last_push: {
            client_id,
            hubspot_portal_id: client.hubspot_portal_id,
            hubspot_contact_id: result.id,
            at: new Date().toISOString(),
          },
        }
      );

      res.json({
        status: "ok",
        pushed: true,
        created: result.created,
        client_id,
        hubspot_portal_id: client.hubspot_portal_id,
        contact_id: result.id,
        dnc_checked: !!check_dnc,
        cached_profile_id: cached.profile_id,
      });
    } catch (error: any) {
      // Surface HubSpot 4xx (e.g. a bad property name) as a client error.
      if (error instanceof HubspotApiError && error.status >= 400 && error.status < 500) {
        res.status(422).json({ error: error.message });
        return;
      }
      res.status(502).json({ error: error?.message || "Internal server error" });
    }
  },
};
