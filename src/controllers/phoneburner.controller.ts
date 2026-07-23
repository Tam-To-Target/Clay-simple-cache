import { Request, Response } from "express";
import { clientService, clientSuggestions } from "../services/client.service";
import { runPurge, purgeOptionsFromEnv } from "../services/phoneburner-purge.service";
import {
  resolveClientSdrs,
  selectSdr,
  uploadContacts,
  UploadInputError,
} from "../services/phoneburner-upload.service";

export const phoneburnerController = {
  /**
   * POST /admin/phoneburner/purge
   * Body: { client_id?, dry_run?, override_ratio_ceiling? }
   * Runs the PhoneBurner DNC purge for one client (by external_id) or all
   * eligible clients. Dry-run by default (env PB_PURGE_DRY_RUN, default true)
   * unless `dry_run:false` is passed explicitly.
   *
   * `override_ratio_ceiling:true` bypasses the 30% collision-ratio safety gate
   * for a confirmed-heavy client (e.g. StudentBridge). It REQUIRES `client_id`
   * (400 otherwise) — the ceiling is never bypassed for an all-clients run.
   */
  async purge(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, dry_run, override_ratio_ceiling } = req.body || {};
      const overrideRatioCeiling = override_ratio_ceiling === true;

      if (overrideRatioCeiling && !client_id) {
        res.status(400).json({
          error:
            "override_ratio_ceiling requires client_id — the DNC ratio ceiling is never bypassed for an all-clients run",
        });
        return;
      }

      // Member tokens are resolved from GTMOS (each SDR's own PhoneBurner PAT),
      // so the internal-API config must be present.
      if (!process.env.SDR_LAUNCH_INTERNAL_URL || !process.env.SDR_LAUNCH_INTERNAL_SECRET) {
        res.status(400).json({
          error: "SDR_LAUNCH_INTERNAL_URL and SDR_LAUNCH_INTERNAL_SECRET must be set to resolve PhoneBurner tokens from GTMOS",
        });
        return;
      }

      if (client_id) {
        const client = await clientService.getByExternalId(client_id);
        if (!client || !client.active) {
          const suggestions = await clientSuggestions(client_id);
          res.status(404).json({
            error: `Unknown or inactive client_id: ${client_id}`,
            ...(suggestions.length ? { suggestions } : {}),
          });
          return;
        }
      }

      const opts = purgeOptionsFromEnv({
        dryRun: typeof dry_run === "boolean" ? dry_run : undefined,
        overrideRatioCeiling,
      });
      const summary = await runPurge(opts, client_id || undefined);
      res.json({ status: "ok", run: summary });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },

  /**
   * POST /admin/phoneburner/upload
   * Body: {
   *   client_id,                       // client slug (required)
   *   sdr?,                            // slug | name | email | pb_member_id
   *                                    //   (required only when >1 SDR is assigned)
   *   campaign?, lead_score?, attempt?, tags?,    // labeling (see service)
   *   dnc_scrub? = true, on_duplicate? = "update", dry_run? = false,
   *   contacts: (string | { phone, first_name?, last_name?, name?, company?, email?, title?, notes? })[]
   * }
   * Uploads a lead list into the assigned SDR's PhoneBurner book: client tag +
   * "<ClientTag>: <Campaign>" tags, a "Lead Score" custom field (auto-minted for
   * the client unless `lead_score` is given, stamped on net-new contacts only),
   * scrubbing the client's DNC first by default.
   *
   * When more than one SDR is assigned and `sdr` is missing/ambiguous, responds
   * 409 with { needs_sdr:true, sdrs:[…] } so the caller can pick.
   */
  async upload(req: Request, res: Response): Promise<void> {
    try {
      const {
        client_id,
        sdr,
        campaign,
        lead_score,
        lead_group, // deprecated alias for lead_score
        attempt,
        tags,
        dnc_scrub,
        on_duplicate,
        dry_run,
        contacts,
      } = req.body || {};

      if (!client_id) {
        res.status(400).json({ error: "client_id is required" });
        return;
      }
      if (!Array.isArray(contacts) || contacts.length === 0) {
        res.status(400).json({ error: "contacts must be a non-empty array" });
        return;
      }

      // The SDR's dialing token is resolved from GTMOS, so its config must exist.
      if (!process.env.SDR_LAUNCH_INTERNAL_URL || !process.env.SDR_LAUNCH_INTERNAL_SECRET) {
        res.status(400).json({
          error:
            "SDR_LAUNCH_INTERNAL_URL and SDR_LAUNCH_INTERNAL_SECRET must be set to resolve PhoneBurner tokens from GTMOS",
        });
        return;
      }

      // getByExternalId resolves known slug aliases (e.g. GTMOS-style "bridge-it").
      const client = await clientService.getByExternalId(client_id);
      if (!client || !client.active) {
        const suggestions = await clientSuggestions(client_id);
        res.status(404).json({
          error: `Unknown or inactive client_id: ${client_id}`,
          ...(suggestions.length ? { suggestions } : {}),
        });
        return;
      }

      const sdrs = await resolveClientSdrs(client);
      const chosen = selectSdr(sdrs, typeof sdr === "string" ? sdr : undefined);

      const result = await uploadContacts(client, chosen, contacts, {
        campaign,
        leadScore: typeof lead_score === "string" ? lead_score : typeof lead_group === "string" ? lead_group : undefined,
        attempt,
        tags: Array.isArray(tags) ? tags : undefined,
        dncScrub: typeof dnc_scrub === "boolean" ? dnc_scrub : undefined,
        onDuplicate: on_duplicate === "skip" ? "skip" : on_duplicate === "update" ? "update" : undefined,
        dryRun: dry_run === true,
      });

      res.json({ status: "ok", ...result });
    } catch (error: any) {
      if (error instanceof UploadInputError) {
        res.status(error.status).json({ error: error.message, ...(error.payload || {}) });
        return;
      }
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },
};
