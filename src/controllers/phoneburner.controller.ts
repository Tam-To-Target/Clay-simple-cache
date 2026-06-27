import { Request, Response } from "express";
import { clientService, clientSuggestions } from "../services/client.service";
import { runPurge, purgeOptionsFromEnv } from "../services/phoneburner-purge.service";

export const phoneburnerController = {
  /**
   * POST /admin/phoneburner/purge
   * Body: { client_id?, dry_run? }
   * Runs the PhoneBurner DNC purge for one client (by external_id) or all
   * eligible clients. Dry-run by default (env PB_PURGE_DRY_RUN, default true)
   * unless `dry_run:false` is passed explicitly.
   */
  async purge(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, dry_run } = req.body || {};

      if (!process.env.PHONEBURNER_ADMIN_TOKEN) {
        res.status(400).json({ error: "PHONEBURNER_ADMIN_TOKEN is not configured on this service" });
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

      const opts = purgeOptionsFromEnv({ dryRun: typeof dry_run === "boolean" ? dry_run : undefined });
      const summary = await runPurge(opts, client_id || undefined);
      res.json({ status: "ok", run: summary });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },
};
