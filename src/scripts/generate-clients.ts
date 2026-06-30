/**
 * Generate the committed client registry (data/clients.json).
 *
 * Joins the tokens DB (which portals have an installed HubSpot app) with the
 * GTMOS customer directory (the source of slug + name + portal + PhoneBurner
 * dialers), producing one registry entry per portal that maps to a known
 * client. Portals with no matching client are recorded under `unmapped_portals`.
 *
 * The GTMOS directory is read over the internal API (sdr-launch.service) — we no
 * longer open a direct connection to the GTMOS database.
 *
 * Run once (and whenever the roster changes):  npm run clients:generate
 */
import dotenv from "dotenv";
dotenv.config();

import { listPortalIds } from "../services/tokens-db.service";
import { fetchClients } from "../services/sdr-launch.service";
import { normalizeDomain } from "../services/normalization";
import { saveRegistry, RegistryClient, RegistryPbMember, ClientRegistry } from "../config/registry";

// How far back in the call log GTMOS looks when deciding which SDRs currently
// dial for a client. Recent calls = active assignment; a stale window would
// scrub a book against a client the SDR no longer serves (multi-client SDRs).
const PB_MAP_CALL_WINDOW_DAYS = Number(process.env.PB_MAP_CALL_WINDOW_DAYS) || 120;

async function main() {
  const [portalIds, clients] = await Promise.all([
    listPortalIds(),
    fetchClients({ pbMembers: true, windowDays: PB_MAP_CALL_WINDOW_DAYS }),
  ]);

  // Index GTMOS clients by portal id (only those that carry one).
  const byPortal = new Map<string, (typeof clients)[number]>();
  for (const c of clients) {
    if (c.hubspotPortalId) byPortal.set(String(c.hubspotPortalId), c);
  }

  const registryClients: RegistryClient[] = [];
  const unmapped: string[] = [];

  for (const portalId of portalIds) {
    const row = byPortal.get(String(portalId));
    if (!row) {
      unmapped.push(portalId);
      continue;
    }
    const pbMembers: RegistryPbMember[] = (row.pbMembers ?? []).map((m) => ({
      pb_member_id: String(m.pbMemberId),
      name: m.name ?? null,
      username: m.email ?? null,
      status: m.status ?? null,
    }));
    registryClients.push({
      slug: row.slug,
      portal_id: String(portalId),
      name: row.name,
      client_reference_name: row.clientReferenceName ?? null,
      domain: row.website ? normalizeDomain(row.website) : null,
      ...(pbMembers.length ? { phoneburner_members: pbMembers } : {}),
    });
  }

  registryClients.sort((a, b) => a.slug.localeCompare(b.slug));

  const registry: ClientRegistry = {
    generated_at: new Date().toISOString(),
    clients: registryClients,
    unmapped_portals: unmapped.sort(),
  };
  saveRegistry(registry);

  console.log(
    `Registry written: ${registryClients.length} client(s), ${unmapped.length} unmapped portal(s).`
  );
  for (const c of registryClients) {
    const pb = c.phoneburner_members?.length ? `  [${c.phoneburner_members.length} PB member(s)]` : "";
    console.log(`  ✓ ${c.slug.padEnd(20)} portal ${c.portal_id}  (${c.name})${pb}`);
  }
  for (const p of unmapped) console.log(`  ? portal ${p} — no matching client (skipped)`);
}

main().catch((err) => {
  console.error("generate-clients failed:", err?.message || err);
  process.exit(1);
});
