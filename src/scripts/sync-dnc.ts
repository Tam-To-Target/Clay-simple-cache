/**
 * Daily DNC sync — pulls current HubSpot list memberships into the DNC tables.
 *
 * Usage:
 *   npm run dnc:sync                 # sync all active clients
 *   npm run dnc:sync -- <client_id>  # sync a single client (external_id)
 *
 * Intended to be run by a platform scheduler (e.g. Railway cron) at least daily.
 * The same work is also exposed at POST /admin/dnc/sync for HTTP-based crons.
 */
import dotenv from "dotenv";
dotenv.config();

import { clientService } from "../services/client.service";
import { syncAllHubspotSources, syncClient } from "../services/dnc-sync.service";

async function main() {
  const clientId = process.argv[2];

  const results = clientId
    ? await (async () => {
        const client = await clientService.getByExternalId(clientId);
        if (!client) throw new Error(`Unknown client_id: ${clientId}`);
        return syncClient(client);
      })()
    : await syncAllHubspotSources();

  const ok = results.filter((r) => r.status === "ok");
  const errored = results.filter((r) => r.status === "error");
  const totalEntries = ok.reduce((sum, r) => sum + r.entry_count, 0);

  console.log(
    `DNC sync complete: ${results.length} source(s), ${ok.length} ok, ${errored.length} error(s), ${totalEntries} entries.`
  );
  for (const r of results) {
    const tag = r.status === "ok" ? "✓" : r.status === "skipped" ? "–" : "✗";
    console.log(
      `  ${tag} [${r.client_external_id}] list ${r.hubspot_list_id ?? "-"} (${r.label ?? "no label"}): ` +
        `${r.entry_count} entries${r.error ? ` — ${r.error}` : ""}`
    );
  }

  process.exit(errored.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("DNC sync failed:", err?.message || err);
  process.exit(1);
});
