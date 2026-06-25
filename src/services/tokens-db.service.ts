/**
 * Read-only access to the HubSpot tokens DB (Railway `portal_tokens`).
 *
 * This is a SEPARATE database from the cache's own Postgres, so it uses a
 * lightweight `pg` connection rather than Prisma. We only ever read the set of
 * portal IDs that have an installed HubSpot app — the actual tokens are resolved
 * (and refreshed) via the provisioner, never read from here directly.
 */
import { Client } from "pg";

/** Returns every portal_id present in the tokens DB, as strings. */
export async function listPortalIds(): Promise<string[]> {
  const url = process.env.HUBSPOT_TOKES_DATABASE_URL;
  if (!url) throw new Error("HUBSPOT_TOKES_DATABASE_URL is not set");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ portal_id: string }>(
      "SELECT portal_id FROM portal_tokens ORDER BY portal_id"
    );
    return res.rows.map((r) => String(r.portal_id));
  } finally {
    await client.end();
  }
}
