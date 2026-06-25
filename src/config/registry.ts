/**
 * Client registry — the committed map of client slug -> HubSpot portal.
 *
 * Generated ONCE by `npm run clients:generate` (joins the tokens DB with the
 * SDR Launch clients table, which is itself synced from Airtable). Stored at
 * `data/clients.json` and committed so the runtime never needs the SDR Launch
 * DB. Re-run the generator when the client roster changes.
 */
import fs from "fs";
import path from "path";

export interface RegistryClient {
  slug: string;
  portal_id: string;
  name: string;
  client_reference_name: string | null;
  domain: string | null;
}

export interface ClientRegistry {
  generated_at: string;
  clients: RegistryClient[];
  /** Portals in the tokens DB with no matching client (skipped at bootstrap). */
  unmapped_portals: string[];
}

const REGISTRY_PATH = path.join(process.cwd(), "data", "clients.json");

export function registryPath(): string {
  return REGISTRY_PATH;
}

export function loadRegistry(): ClientRegistry {
  const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
  return JSON.parse(raw) as ClientRegistry;
}

export function saveRegistry(registry: ClientRegistry): void {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

/** lowercase, spaces -> hyphens, strip anything but [a-z0-9-]. */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
