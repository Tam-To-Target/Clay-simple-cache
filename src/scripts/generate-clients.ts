/**
 * Generate the committed client registry (data/clients.json).
 *
 * Driven by the GTMOS customer directory (slug + name + portal + PhoneBurner
 * dialers), enriched with the tokens DB (which portals have an installed HubSpot
 * app). A client earns a registry entry when it has EITHER an installed HubSpot
 * portal OR at least one PhoneBurner dialer. Portals with no matching client are
 * recorded under `unmapped_portals`.
 *
 * This used to iterate PORTALS, which silently excluded every non-HubSpot client:
 * a Salesforce customer has no portal, so it never reached the registry, so
 * `pb:bootstrap` never registered its PB seats, so the DNC purge never scrubbed
 * its dialers — the client's suppression list existed but did nothing. Iterating
 * clients instead (portal optional) is what makes CRM-agnostic DNC work.
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

// GTMOS carries bucket/pseudo clients that are not real customers. `unassigned`
// is the catch-all every unmapped dialer lands in — registering its ~15 members
// would scrub unrelated books against a meaningless DNC set.
const PSEUDO_CLIENT_SLUGS = new Set(["unassigned", "unknown", "internal", "test"]);

async function main() {
  const [portalIds, clients] = await Promise.all([
    listPortalIds(),
    fetchClients({ pbMembers: true, windowDays: PB_MAP_CALL_WINDOW_DAYS }),
  ]);

  const installedPortals = new Set(portalIds.map(String));
  const claimedPortals = new Set<string>();

  const registryClients: RegistryClient[] = [];
  const skipped: string[] = [];

  for (const row of clients) {
    if (PSEUDO_CLIENT_SLUGS.has(row.slug)) continue;

    // NOTE: deliberately NOT filtering on `row.status`. Archived clients keep
    // large live DNC lists (kaleidoscope ~108k entries, studentbridge ~56k) and
    // still have dialers attached; gating on status drops them from the registry
    // and silently stops enforcing their suppression — the same archived-status
    // footgun that previously killed the EmailBison sync. Suppression is
    // protective, so it must outlive the engagement.

    // Only claim the portal when the HubSpot app is actually installed on it —
    // otherwise the client is effectively portal-less for our purposes.
    const portalId =
      row.hubspotPortalId && installedPortals.has(String(row.hubspotPortalId))
        ? String(row.hubspotPortalId)
        : null;
    if (portalId) claimedPortals.add(portalId);

    const pbMembers: RegistryPbMember[] = (row.pbMembers ?? []).map((m) => ({
      pb_member_id: String(m.pbMemberId),
      name: m.name ?? null,
      username: m.email ?? null,
      status: m.status ?? null,
    }));

    // Nothing to act on: no HubSpot lists to sync and no dialer book to scrub.
    if (!portalId && pbMembers.length === 0) {
      skipped.push(row.slug);
      continue;
    }

    registryClients.push({
      slug: row.slug,
      portal_id: portalId,
      name: row.name,
      client_reference_name: row.clientReferenceName ?? null,
      domain: row.website ? normalizeDomain(row.website) : null,
      crm_platform: row.crmPlatform ?? null,
      ...(pbMembers.length ? { phoneburner_members: pbMembers } : {}),
    });
  }

  const unmapped = portalIds.map(String).filter((p) => !claimedPortals.has(p));

  registryClients.sort((a, b) => a.slug.localeCompare(b.slug));

  const registry: ClientRegistry = {
    generated_at: new Date().toISOString(),
    clients: registryClients,
    unmapped_portals: unmapped.sort(),
  };
  saveRegistry(registry);

  const portalLess = registryClients.filter((c) => !c.portal_id);
  console.log(
    `Registry written: ${registryClients.length} client(s) ` +
      `(${portalLess.length} without a HubSpot portal), ${unmapped.length} unmapped portal(s).`
  );
  for (const c of registryClients) {
    const pb = c.phoneburner_members?.length ? `  [${c.phoneburner_members.length} PB member(s)]` : "";
    const crm = c.portal_id ? `portal ${c.portal_id}` : `no portal (${c.crm_platform ?? "CRM ?"})`;
    console.log(`  ✓ ${c.slug.padEnd(32)} ${crm.padEnd(26)} (${c.name})${pb}`);
  }
  for (const p of unmapped) console.log(`  ? portal ${p} — no matching client (skipped)`);
  for (const s of skipped) console.log(`  – ${s} — no portal and no PB dialer (skipped)`);
}

main().catch((err) => {
  console.error("generate-clients failed:", err?.message || err);
  process.exit(1);
});
