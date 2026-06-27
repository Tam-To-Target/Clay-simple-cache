/**
 * Daily PhoneBurner DNC purge. Deletes, from each client's PhoneBurner members'
 * books, every contact that collides with that client's cached DNC list.
 *
 * MUST run AFTER `npm run dnc:sync` (needs a fresh DNC cache).
 *
 *   npm run pb:purge                 # all eligible clients (dry-run unless PB_PURGE_DRY_RUN=false)
 *   npm run pb:purge -- <slug>       # a single client
 *   npm run pb:purge -- --dry-run    # force dry-run (compute + audit, no deletes)
 *   npm run pb:purge -- --execute    # force real deletes (overrides PB_PURGE_DRY_RUN)
 */
import dotenv from "dotenv";
dotenv.config();

import { runPurge, purgeOptionsFromEnv } from "../services/phoneburner-purge.service";

function assertEnv(): void {
  const required = ["DATABASE_URL", "PHONEBURNER_ADMIN_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them on this service (a Railway cron service does NOT inherit the web service's variables).`
    );
  }
}

async function main() {
  assertEnv();

  const args = process.argv.slice(2);
  const forceDry = args.includes("--dry-run");
  const forceExecute = args.includes("--execute");
  const slug = args.find((a) => !a.startsWith("--"));

  const opts = purgeOptionsFromEnv({
    dryRun: forceExecute ? false : forceDry ? true : undefined,
  });

  console.log(
    `Starting PhoneBurner purge — ${opts.dryRun ? "DRY-RUN (no deletes)" : "LIVE (deletes enabled)"}` +
      `${slug ? ` for client "${slug}"` : ""}, maxRatio=${opts.maxRatio}, domains=${opts.includeDomains}` +
      `${opts.maxDeletesPerRun ? `, cap=${opts.maxDeletesPerRun}` : ""}…`
  );

  const summary = await runPurge(opts, slug);
  const t = summary.totals;

  console.log(
    `\nPurge ${summary.status.toUpperCase()} (run ${summary.run_id}, ${summary.dry_run ? "dry-run" : "live"}): ` +
      `${t.clients_processed} client(s), ${t.members_processed} member(s) processed, ` +
      `${t.members_skipped} skipped, ${t.contacts_scanned} scanned, ${t.collisions_found} collisions, ` +
      `${opts.dryRun ? `${t.deleted} would-delete` : `${t.deleted} deleted`}, ${t.failed} failed.`
  );

  for (const c of summary.clients) {
    for (const m of c.members) {
      const tag =
        m.status === "ok" ? "✓" :
        m.status === "error" ? "✗" :
        m.status === "aborted_ratio" ? "⛔" : "⊘";
      console.log(
        `  ${tag} [${c.client_external_id}] member ${m.pb_member_id}` +
          `${m.pb_username ? ` (${m.pb_username})` : ""}: ${m.status} — ` +
          `${m.contacts_scanned} scanned, ${m.collisions} collisions, ${m.deleted} ${opts.dryRun ? "would-delete" : "deleted"}` +
          `${m.failed ? `, ${m.failed} failed` : ""}${m.error ? ` — ${m.error}` : ""}`
      );
    }
  }

  process.exit(summary.status === "ok" ? 0 : 1);
}

main().catch((err) => {
  console.error("pb:purge failed:", err?.message || err);
  process.exit(1);
});
