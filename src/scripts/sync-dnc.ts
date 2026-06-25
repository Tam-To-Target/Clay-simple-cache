/**
 * Daily DNC sync — re-discovers each client's HubSpot DNC lists (picks up newly
 * created lists, reclassifies, deactivates deleted ones) and refreshes membership
 * into the DNC tables.
 *
 * Usage:
 *   npm run dnc:sync                 # all active clients
 *   npm run dnc:sync -- <slug>       # a single client (external_id)
 *
 * Intended to be run by a platform scheduler (e.g. Railway cron) at least daily.
 * The same work is exposed at POST /admin/dnc/discover for HTTP-based crons.
 */
import dotenv from "dotenv";
dotenv.config();

import { clientService } from "../services/client.service";
import {
  discoverAndSyncAll,
  discoverAndSyncClient,
  DiscoverResult,
  SourceSyncResult,
} from "../services/dnc-sync.service";

async function main() {
  const slug = process.argv[2];

  let discover: DiscoverResult[];
  let sync: SourceSyncResult[];

  if (slug) {
    const client = await clientService.getByExternalId(slug);
    if (!client) throw new Error(`Unknown client_id: ${slug}`);
    const r = await discoverAndSyncClient(client);
    discover = [r.discover];
    sync = r.sync;
  } else {
    const r = await discoverAndSyncAll();
    discover = r.discover;
    sync = r.sync;
  }

  const ok = sync.filter((r) => r.status === "ok");
  const errored = sync.filter((r) => r.status === "error");
  const totalEntries = ok.reduce((s, r) => s + r.entry_count, 0);
  const discoverErrors = discover.filter((d) => d.status === "error");

  console.log(
    `DNC sync complete: ${sync.length} source(s), ${ok.length} ok, ${errored.length} error(s), ${totalEntries} entries.`
  );
  for (const r of sync) {
    const tag = r.status === "ok" ? "✓" : r.status === "skipped" ? "–" : "✗";
    console.log(
      `  ${tag} [${r.client_external_id}] list ${r.hubspot_list_id ?? "-"} [${r.level}] (${r.label ?? "no label"}): ` +
        `${r.entry_count} entries${r.error ? ` — ${r.error}` : ""}`
    );
  }

  const unclassified = discover.flatMap((d) => d.unclassified);
  if (unclassified.length) {
    console.log(`Unclassified lists (not synced):`);
    for (const u of unclassified) console.log(`  - [${u.client_external_id}] ${u.list_id}: "${u.name}"`);
  }
  for (const d of discoverErrors) {
    console.log(`  ✗ discover [${d.client_external_id}]: ${d.error}`);
  }

  process.exit(errored.length > 0 || discoverErrors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("DNC sync failed:", err?.message || err);
  process.exit(1);
});
