/**
 * Client registry — the committed map of client slug -> CRM + PhoneBurner dialers.
 *
 * Generated ONCE by `npm run clients:generate` (joins the tokens DB with the
 * SDR Launch clients table, which is itself synced from Airtable). Stored at
 * `data/clients.json` and committed so the runtime never needs the SDR Launch
 * DB. Re-run the generator when the client roster changes.
 *
 * `portal_id` is NULLABLE: a client on Salesforce (or any non-HubSpot CRM) has
 * no portal, but still dials in PhoneBurner and therefore still needs its DNC
 * enforced. Keying the registry on the portal used to silence those clients
 * entirely — their PB seats were never registered, so the purge skipped them.
 * Anything HubSpot-specific must branch on `portal_id` being non-null.
 */
import fs from "fs";
import path from "path";

export interface RegistryPbMember {
  pb_member_id: string;
  name: string | null;
  username: string | null;
  /** SDR status in SDR Launch ('active' etc.) — drives the member's active flag. */
  status: string | null;
}

export interface RegistryClient {
  slug: string;
  /** HubSpot portal id, or null for a client whose CRM isn't HubSpot (e.g. Salesforce). */
  portal_id: string | null;
  name: string;
  client_reference_name: string | null;
  domain: string | null;
  /** GTMOS `crmPlatform` ('HubSpot' | 'Salesforce' | …), for reporting/branching. */
  crm_platform: string | null;
  /** PhoneBurner members that dial for this client (for the DNC purge). */
  phoneburner_members?: RegistryPbMember[];
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
