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
import { saveRegistry, RegistryClient, RegistryPbMember, ClientRegistry } from "../config/registry";

interface SdrClientRow {
  client_uuid: string;
  hubspot_portal_id: string;
  slug: string;
  name: string;
  client_reference_name: string | null;
  website: string | null;
  status: string;
}

// How far back in the call log to look when deciding which SDRs currently dial
// for a client. Recent calls = active assignment; a stale window would scrub a
// book against a client the SDR no longer serves (matters for multi-client SDRs).
const PB_MAP_CALL_WINDOW_DAYS = Number(process.env.PB_MAP_CALL_WINDOW_DAYS) || 120;

async function withSdrLaunch<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env.SDR_LAUNCH_DATABASE_URL;
  if (!url) throw new Error("SDR_LAUNCH_DATABASE_URL is not set (needed to map portals -> slugs)");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function fetchSdrClients(c: Client): Promise<Map<string, SdrClientRow>> {
  const res = await c.query<SdrClientRow>(
    `SELECT id AS client_uuid, hubspot_portal_id, slug, name, client_reference_name, website, status
       FROM clients
      WHERE hubspot_portal_id IS NOT NULL`
  );
  const byPortal = new Map<string, SdrClientRow>();
  for (const row of res.rows) byPortal.set(String(row.hubspot_portal_id), row);
  return byPortal;
}

interface PbMemberRow {
  client_uuid: string;
  pb_member_id: string;
  full_name: string | null;
  email: string | null;
  status: string | null;
}

/** client uuid -> PhoneBurner members that have recently dialed for that client. */
async function fetchPbMembersByClient(c: Client): Promise<Map<string, RegistryPbMember[]>> {
  const res = await c.query<PbMemberRow>(
    `SELECT DISTINCT cs.client_id AS client_uuid,
            s.provider_user_ids->>'phoneburner' AS pb_member_id,
            s.full_name, s.email, s.status
       FROM (
         SELECT DISTINCT client_id, sdr_id
           FROM calls
          WHERE provider = 'phoneburner'
            AND sdr_id IS NOT NULL
            AND client_id IS NOT NULL
            AND started_at > now() - ($1::int * interval '1 day')
       ) cs
       JOIN sdrs s ON s.id = cs.sdr_id
      WHERE s.provider_user_ids->>'phoneburner' IS NOT NULL`,
    [PB_MAP_CALL_WINDOW_DAYS]
  );

  const byClient = new Map<string, RegistryPbMember[]>();
  for (const r of res.rows) {
    const list = byClient.get(r.client_uuid) ?? [];
    if (!list.some((m) => m.pb_member_id === r.pb_member_id)) {
      list.push({
        pb_member_id: String(r.pb_member_id),
        name: r.full_name ?? null,
        username: r.email ?? null,
        status: r.status ?? null,
      });
    }
    byClient.set(r.client_uuid, list);
  }
  return byClient;
}

async function main() {
  const [portalIds, { sdrByPortal, pbByClient }] = await Promise.all([
    listPortalIds(),
    withSdrLaunch(async (c) => ({
      sdrByPortal: await fetchSdrClients(c),
      pbByClient: await fetchPbMembersByClient(c),
    })),
  ]);

  const clients: RegistryClient[] = [];
  const unmapped: string[] = [];

  for (const portalId of portalIds) {
    const row = sdrByPortal.get(portalId);
    if (!row) {
      unmapped.push(portalId);
      continue;
    }
    const pbMembers = pbByClient.get(row.client_uuid) ?? [];
    clients.push({
      slug: row.slug,
      portal_id: portalId,
      name: row.name,
      client_reference_name: row.client_reference_name ?? null,
      domain: row.website ? normalizeDomain(row.website) : null,
      ...(pbMembers.length ? { phoneburner_members: pbMembers } : {}),
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
  for (const c of clients) {
    const pb = c.phoneburner_members?.length ? `  [${c.phoneburner_members.length} PB member(s)]` : "";
    console.log(`  ✓ ${c.slug.padEnd(20)} portal ${c.portal_id}  (${c.name})${pb}`);
  }
  for (const p of unmapped) console.log(`  ? portal ${p} — no matching client (skipped)`);
}

main().catch((err) => {
  console.error("generate-clients failed:", err?.message || err);
  process.exit(1);
});
