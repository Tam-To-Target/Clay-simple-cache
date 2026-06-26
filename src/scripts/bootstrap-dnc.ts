/**
 * Bootstrap the multi-tenant DNC cache from the committed client registry.
 *
 * For each registry client: upsert the cache client (external_id = slug,
 * hubspot_portal_id = portal), discover + classify its "TAM - Do Not Contact …"
 * lists, register a source per list, and sync membership. Idempotent — safe to
 * re-run. Unclassified lists and unmapped portals are reported at the end.
 *
 * Usage:
 *   npm run dnc:bootstrap                # all registry clients
 *   npm run dnc:bootstrap -- <slug>      # a single client
 */
import dotenv from "dotenv";
dotenv.config();

import { clientService } from "../services/client.service";
import { assertSyncEnv, discoverAndSyncClient } from "../services/dnc-sync.service";
import { loadRegistry } from "../config/registry";

async function main() {
  assertSyncEnv();
  const onlySlug = process.argv[2];
  const registry = loadRegistry();

  let targets = registry.clients;
  if (onlySlug) {
    targets = targets.filter((c) => c.slug === onlySlug);
    if (targets.length === 0) throw new Error(`No registry client with slug "${onlySlug}"`);
  }

  console.log(
    `Bootstrapping ${targets.length} client(s) from registry (generated ${registry.generated_at}).\n`
  );

  const unclassified: { client: string; list_id: string; name: string }[] = [];
  const errors: { client: string; error: string }[] = [];
  const noAccess: { client: string; error: string }[] = [];
  let totalEntries = 0;
  let totalDomains = 0;

  for (const rc of targets) {
    const client = await clientService.upsert({
      external_id: rc.slug,
      name: rc.name,
      hubspot_portal_id: rc.portal_id,
    });

    const { discover, sync } = await discoverAndSyncClient(client);

    if (discover.status === "no_access") {
      noAccess.push({ client: rc.slug, error: discover.error || "access revoked" });
      console.log(`⊘ ${rc.slug} — HubSpot access revoked, skipped`);
      continue;
    }

    if (discover.status === "error") {
      errors.push({ client: rc.slug, error: discover.error || "discover failed" });
      console.log(`✗ ${rc.slug} — discover error: ${discover.error}`);
      continue;
    }

    for (const u of discover.unclassified) {
      unclassified.push({ client: rc.slug, list_id: u.list_id, name: u.name });
    }

    const okSources = sync.filter((s) => s.status === "ok");
    const erroredSources = sync.filter((s) => s.status === "error");
    const entries = okSources.reduce((n, s) => n + s.entry_count, 0);
    const domains = okSources.reduce((n, s) => n + s.domain_count, 0);
    totalEntries += entries;
    totalDomains += domains;

    const parts = sync
      .map((s) => {
        const tag = s.status === "ok" ? "✓" : s.status === "skipped" ? "–" : "✗";
        return `${tag} ${s.label ?? s.hubspot_list_id} [${s.level}] ${s.entry_count}` +
          (s.level === "domain" ? `/${s.domain_count}d` : "") +
          (s.error ? ` — ${s.error}` : "");
      })
      .join(", ");

    const flags: string[] = [];
    if (discover.unclassified.length) flags.push(`${discover.unclassified.length} unclassified`);
    if (discover.deactivated.length) flags.push(`${discover.deactivated.length} deactivated`);
    if (erroredSources.length) flags.push(`${erroredSources.length} source error(s)`);

    console.log(
      `● ${rc.slug.padEnd(20)} portal ${rc.portal_id} — ${sync.length} source(s), ${entries} entries` +
        (domains ? ` (${domains} domains)` : "") +
        (flags.length ? `  [${flags.join("; ")}]` : "")
    );
    if (parts) console.log(`    ${parts}`);

    for (const s of erroredSources) errors.push({ client: rc.slug, error: `${s.label}: ${s.error}` });
  }

  console.log(
    `\nDone: ${targets.length} client(s), ${totalEntries} entries (${totalDomains} domain entries).`
  );

  if (unclassified.length) {
    console.log(`\n⚠ Unclassified lists (matched the prefix, NOT synced — review the name suffix):`);
    for (const u of unclassified) console.log(`  - [${u.client}] list ${u.list_id}: "${u.name}"`);
  }

  if (noAccess.length) {
    console.log(`\n⊘ Skipped (HubSpot access revoked — uninstalled or grant gone):`);
    for (const n of noAccess) console.log(`  - [${n.client}] ${n.error}`);
  }

  if (registry.unmapped_portals.length) {
    console.log(`\n⚠ Unmapped portals in tokens DB (no client, skipped):`);
    for (const p of registry.unmapped_portals) console.log(`  - portal ${p}`);
  }

  if (errors.length) {
    console.log(`\n✗ Errors:`);
    for (const e of errors) console.log(`  - [${e.client}] ${e.error}`);
  }

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("DNC bootstrap failed:", err?.message || err);
  process.exit(1);
});
