/**
 * Generate the committed client registry (data/clients.json).
 *
 * Joins the tokens DB (which portals have an installed HubSpot app) with the
 * SDR Launch clients table (the Airtable-synced source of slug + name + portal),
 * producing one registry entry per portal that maps to a known client. Portals
 * with no matching client are recorded under `unmapped_portals`.
 *
 * Run once (and whenever the roster changes):  npm run clients:generate
 */
import dotenv from "dotenv";
dotenv.config();

import { Client } from "pg";
import { listPortalIds } from "../services/tokens-db.service";
import { normalizeDomain } from "../services/normalization";
import { saveRegistry, RegistryClient, ClientRegistry } from "../config/registry";

interface SdrClientRow {
  hubspot_portal_id: string;
  slug: string;
  name: string;
  client_reference_name: string | null;
  website: string | null;
  status: string;
}

async function fetchSdrClients(): Promise<Map<string, SdrClientRow>> {
  const url = process.env.SDR_LAUNCH_DATABASE_URL;
  if (!url) throw new Error("SDR_LAUNCH_DATABASE_URL is not set (needed to map portals -> slugs)");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<SdrClientRow>(
      `SELECT hubspot_portal_id, slug, name, client_reference_name, website, status
         FROM clients
        WHERE hubspot_portal_id IS NOT NULL`
    );
    const byPortal = new Map<string, SdrClientRow>();
    for (const row of res.rows) byPortal.set(String(row.hubspot_portal_id), row);
    return byPortal;
  } finally {
    await client.end();
  }
}

async function main() {
  const [portalIds, sdrByPortal] = await Promise.all([listPortalIds(), fetchSdrClients()]);

  const clients: RegistryClient[] = [];
  const unmapped: string[] = [];

  for (const portalId of portalIds) {
    const row = sdrByPortal.get(portalId);
    if (!row) {
      unmapped.push(portalId);
      continue;
    }
    clients.push({
      slug: row.slug,
      portal_id: portalId,
      name: row.name,
      client_reference_name: row.client_reference_name ?? null,
      domain: row.website ? normalizeDomain(row.website) : null,
    });
  }

  clients.sort((a, b) => a.slug.localeCompare(b.slug));

  const registry: ClientRegistry = {
    generated_at: new Date().toISOString(),
    clients,
    unmapped_portals: unmapped.sort(),
  };
  saveRegistry(registry);

  console.log(`Registry written: ${clients.length} client(s), ${unmapped.length} unmapped portal(s).`);
  for (const c of clients) console.log(`  ✓ ${c.slug.padEnd(20)} portal ${c.portal_id}  (${c.name})`);
  for (const p of unmapped) console.log(`  ? portal ${p} — no matching client (skipped)`);
}

main().catch((err) => {
  console.error("generate-clients failed:", err?.message || err);
  process.exit(1);
});
