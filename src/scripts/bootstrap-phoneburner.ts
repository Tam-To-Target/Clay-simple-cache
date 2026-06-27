/**
 * Load the committed client→PhoneBurner-member map (data/clients.json) into the
 * `phoneburner_members` table so the purge knows which members dial for which
 * client. Idempotent: re-run after `npm run clients:generate`.
 *
 *   npm run pb:bootstrap            # all clients in the registry
 *   npm run pb:bootstrap -- <slug>  # a single client
 *
 * Members present in the registry are upserted (active = SDR status 'active');
 * members previously stored but no longer in the registry are deactivated, so a
 * member who stops dialing for a client stops being scrubbed against its DNC.
 */
import dotenv from "dotenv";
dotenv.config();

import prisma from "../db/prisma";
import { clientService } from "../services/client.service";
import { loadRegistry } from "../config/registry";

async function main() {
  const onlySlug = process.argv[2];
  const registry = loadRegistry();
  let targets = registry.clients.filter((c) => (c.phoneburner_members?.length ?? 0) > 0);
  if (onlySlug) targets = targets.filter((c) => c.slug === onlySlug);

  console.log(`Bootstrapping PhoneBurner members for ${targets.length} client(s).\n`);

  let upserted = 0;
  let deactivated = 0;
  const missingClients: string[] = [];

  for (const rc of targets) {
    const client = await clientService.getByExternalId(rc.slug);
    if (!client) {
      missingClients.push(rc.slug);
      console.log(`✗ ${rc.slug} — not in cache (run dnc:bootstrap first); skipped`);
      continue;
    }

    const members = rc.phoneburner_members ?? [];
    const keep = new Set(members.map((m) => m.pb_member_id));

    for (const m of members) {
      // In-scope because the member RECENTLY DIALED for this client (the registry
      // is built from the call window) — that, not requiring status to be exactly
      // 'active', is the signal. We still EXCLUDE an explicitly-inactive SDR so a
      // frozen/offboarded account isn't purged. (API-Access-off members are also
      // skipped at runtime as skipped_no_access.)
      const active = m.status !== "inactive";
      await prisma.phoneburnerMember.upsert({
        where: { client_id_pb_member_id: { client_id: client.id, pb_member_id: m.pb_member_id } },
        update: { pb_username: m.username, active },
        create: {
          client_id: client.id,
          pb_member_id: m.pb_member_id,
          pb_username: m.username,
          active,
        },
      });
      upserted++;
    }

    // Deactivate members no longer mapped to this client (left team / reassigned).
    const existing = await prisma.phoneburnerMember.findMany({
      where: { client_id: client.id, active: true },
    });
    for (const e of existing) {
      if (!keep.has(e.pb_member_id)) {
        await prisma.phoneburnerMember.update({ where: { id: e.id }, data: { active: false } });
        deactivated++;
      }
    }

    const activeCount = members.filter((m) => m.status !== "inactive").length;
    console.log(`● ${rc.slug.padEnd(20)} ${members.length} mapped (${activeCount} active)`);
  }

  console.log(`\nDone: ${upserted} member(s) upserted, ${deactivated} deactivated.`);
  if (missingClients.length) {
    console.log(`⚠ Clients not in cache (run dnc:bootstrap first): ${missingClients.join(", ")}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("pb:bootstrap failed:", err?.message || err);
  process.exit(1);
});
