import { Request, Response } from "express";
import { clientService, clientSuggestions } from "../services/client.service";
import { runEmailbisonSuppress } from "../services/emailbison-suppress.service";

export const emailbisonController = {
  /**
   * POST /admin/emailbison/suppress
   * Body: { client_id?, dry_run? }
   * Push a client's (or all eligible clients') newly-DNC'd emails + domains into
   * the EmailBison workspace blocklist. Dry-run by default
   * (env EMAILBISON_SUPPRESS_DRY_RUN, default true) unless `dry_run:false`.
   *
   * Note: this endpoint runs regardless of EMAILBISON_SUPPRESS_ENABLED (that gate
   * only governs the automatic ops:daily / scheduler passes); an explicit admin
   * call is always allowed, but still honors the dry-run default.
   */
  async suppress(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, dry_run } = req.body || {};

      // Workspace keys are resolved from GTMOS, so the internal-API config must exist.
      if (!process.env.SDR_LAUNCH_INTERNAL_URL || !process.env.SDR_LAUNCH_INTERNAL_SECRET) {
        res.status(400).json({
          error:
            "SDR_LAUNCH_INTERNAL_URL and SDR_LAUNCH_INTERNAL_SECRET must be set to resolve EmailBison keys from GTMOS",
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

      const summary = await runEmailbisonSuppress(
        { dryRun: typeof dry_run === "boolean" ? dry_run : undefined },
        client_id || undefined
      );
      res.json({ status: "ok", run: summary });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },
};
