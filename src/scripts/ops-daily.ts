/**
 * Unified daily ops entrypoint — replaces the two separately-scheduled crons
 * (`dnc:sync` then `pb:purge`) with a single script for one Railway cron:
 *
 *   1. HubSpot DNC sync (`discoverAndSyncAll` / `discoverAndSyncClient`) — skips
 *      HubSpot membership pulls for sources whose `hs_list_size` hasn't moved
 *      (see dnc-sync.service.ts), so most days this phase is cheap.
 *   2. PhoneBurner purge (`runPurge`, mode "auto" by default) — targeted,
 *      index-only deletes for members whose book was fully scanned recently;
 *      a full book scan (+ identity-index rebuild) for members due one
 *      (PB_FULL_SCAN_MAX_AGE_HOURS, default weekly).
 *
 * Usage:
 *   npm run ops:daily                    # all clients, sync skip-unchanged, purge mode=auto
 *   npm run ops:daily -- cust_123        # a single client
 *   npm run ops:daily -- --full          # force full sync (ignore skip-unchanged) AND full PB scans
 *   npm run ops:daily -- --dry-run       # force purge dry-run (overrides PB_PURGE_DRY_RUN)
 *   npm run ops:daily -- --execute       # force purge live deletes (overrides PB_PURGE_DRY_RUN)
 *
 * This is intended to be the ONLY Railway cron for DNC/PB ops. The hourly
 * in-process detector (src/scheduler.ts, DETECTOR_ENABLED=true on the web
 * service) keeps things fresher between daily runs at near-zero cost when
 * nothing changed; this script's periodic full scans are the reconciliation
 * backstop that catches drift the cheap checks can miss.
 *
 * The old `npm run dnc:sync` / `npm run pb:purge` scripts still work
 * independently (e.g. for a one-off single-phase re-run) — see README.md.
 */
import dotenv from "dotenv";
dotenv.config();

import { clientService } from "../services/client.service";
import {
  assertSyncEnv,
  warmupDatabase,
  discoverAndSyncAll,
  discoverAndSyncClient,
  DiscoverResult,
  SourceSyncResult,
} from "../services/dnc-sync.service";
import { runPurge, purgeOptionsFromEnv } from "../services/phoneburner-purge.service";

/**
 * Fail fast with a clear message if the env this run needs is missing.
 * Merges the checks from both `sync-dnc.ts` (assertSyncEnv) and
 * `purge-phoneburner.ts` (member tokens come from GTMOS, not a PB admin
 * token) so a single missing var can't let one phase silently no-op.
 */
function assertPurgeEnv(): void {
  const required = ["DATABASE_URL", "SDR_LAUNCH_INTERNAL_URL", "SDR_LAUNCH_INTERNAL_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them on this service (a Railway cron service does NOT inherit the web service's variables).`
    );
  }
}

async function main() {
  assertSyncEnv();
  assertPurgeEnv();
  // Neon autosuspends when idle; wake it (with retry) before the run so a cold
  // compute doesn't kill the cron on its first query.
  await warmupDatabase();

  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const forceDry = args.includes("--dry-run");
  const forceExecute = args.includes("--execute");
  const slug = args.find((a) => !a.startsWith("--"));

  const purgeOpts = purgeOptionsFromEnv({
    dryRun: forceExecute ? false : forceDry ? true : undefined,
    mode: full ? "full" : "auto",
  });

  console.log(
    `Starting daily DNC ops${slug ? ` for client "${slug}"` : " for all active clients"} — ` +
      `sync ${full ? "FULL (forced)" : "skip-unchanged"}, purge ${purgeOpts.dryRun ? "DRY-RUN" : "LIVE"} ` +
      `mode=${purgeOpts.mode}…`
  );

  // ---- Phase 1: HubSpot DNC sync ----------------------------------------
  console.log("\n=== Phase 1: DNC sync ===");
  let discover: DiscoverResult[];
  let sync: SourceSyncResult[];

  if (slug) {
    const client = await clientService.getByExternalId(slug);
    if (!client) throw new Error(`Unknown client_id: ${slug}`);
    const r = await discoverAndSyncClient(client, { force: full });
    discover = [r.discover];
    sync = r.sync;
  } else {
    const r = await discoverAndSyncAll((i, total, s, entries, error) => {
      console.log(`  [${i}/${total}] ${s}: ${entries} entries${error ? ` — ERROR: ${error}` : ""}`);
    }, { force: full });
    discover = r.discover;
    sync = r.sync;
  }

  const ok = sync.filter((r) => r.status === "ok");
  const skippedUnchanged = sync.filter((r) => r.status === "skipped_unchanged");
  const syncErrored = sync.filter((r) => r.status === "error");
  const totalEntries = ok.reduce((s, r) => s + r.entry_count, 0);
  const totalAdded = ok.reduce((s, r) => s + (r.added ?? 0), 0);
  const totalRemoved = ok.reduce((s, r) => s + (r.removed ?? 0), 0);
  const discoverErrors = discover.filter((d) => d.status === "error");
  const noAccess = discover.filter((d) => d.status === "no_access");

  console.log(
    `DNC sync complete: ${sync.length} source(s), ${ok.length} ok (+${totalAdded}/-${totalRemoved}), ` +
      `${skippedUnchanged.length} skipped-unchanged, ${syncErrored.length} error(s), ` +
      `${noAccess.length} no-access, ${totalEntries} entries.`
  );
  for (const r of sync) {
    const tag =
      r.status === "ok"
        ? "✓"
        : r.status === "skipped_unchanged"
          ? "↻"
          : r.status === "skipped"
            ? "–"
            : r.status === "no_access"
              ? "⊘"
              : "✗";
    const diffSuffix = r.status === "ok" ? ` (+${r.added ?? 0}/-${r.removed ?? 0})` : "";
    console.log(
      `  ${tag} [${r.client_external_id}] list ${r.hubspot_list_id ?? "-"} [${r.level}] (${r.label ?? "no label"}): ` +
        `${r.entry_count} entries${diffSuffix}${r.error ? ` — ${r.error}` : ""}`
    );
  }
  for (const d of discoverErrors) {
    console.log(`  ✗ discover [${d.client_external_id}]: ${d.error}`);
  }

  // ---- Phase 2: PhoneBurner purge ---------------------------------------
  console.log("\n=== Phase 2: PhoneBurner purge ===");
  const summary = await runPurge(purgeOpts, slug);
  const t = summary.totals;

  console.log(
    `Purge ${summary.status.toUpperCase()} (run ${summary.run_id}, ${summary.dry_run ? "dry-run" : "live"}): ` +
      `${t.clients_processed} client(s), ${t.members_processed} member(s) processed ` +
      `(${t.full_scan_members} full-scan, ${t.targeted_members} targeted), ` +
      `${t.members_skipped} skipped, ${t.contacts_scanned} scanned, ${t.collisions_found} collisions, ` +
      `${purgeOpts.dryRun ? `${t.deleted} would-delete` : `${t.deleted} deleted`}, ${t.failed} failed` +
      `${t.protected_other_client ? `, ${t.protected_other_client} kept (shared-book)` : ""}.`
  );

  // ---- Combined summary ---------------------------------------------------
  console.log("\n=== Daily ops summary ===");
  console.log(
    `sync: ${ok.length} ok, ${skippedUnchanged.length} skipped-unchanged, ${syncErrored.length} error(s), ` +
      `+${totalAdded}/-${totalRemoved} entries`
  );
  console.log(
    `purge: ${summary.status} — ${t.deleted} ${purgeOpts.dryRun ? "would-delete" : "deleted"}, ${t.failed} failed ` +
      `(${t.full_scan_members} full-scan / ${t.targeted_members} targeted member run(s))`
  );

  const syncFailed = syncErrored.length > 0 || discoverErrors.length > 0;
  const purgeFailed = summary.status !== "ok";
  if (syncFailed || purgeFailed) {
    console.log(
      `\n⚠ Daily ops completed with issues: ${syncFailed ? "sync errors" : ""}${
        syncFailed && purgeFailed ? "; " : ""
      }${purgeFailed ? `purge status=${summary.status}` : ""}`
    );
  }

  process.exit(syncFailed || purgeFailed ? 1 : 0);
}

main().catch((err) => {
  console.error("ops:daily failed:", err?.message || err);
  process.exit(1);
});
