import prisma from "../db/prisma";
import type { Client } from "@prisma/client";
import { suggestSimilar } from "./suggest";
import { canonicalClientSlug } from "../config/slug-aliases";

/** Closest known client handles for an unknown client_id (friendlier 404s). */
export async function clientSuggestions(query: string): Promise<string[]> {
  try {
    const clients =
      (await prisma.client.findMany({ select: { external_id: true, name: true } })) || [];
    return suggestSimilar(query, clients.map((c) => ({ id: c.external_id, name: c.name })));
  } catch {
    return [];
  }
}

export interface UpsertClientParams {
  external_id: string;
  name?: string;
  active?: boolean;
  hubspot_portal_id?: string | null;
}

/** Public view of a client. Strips the deprecated token column and reports
 *  `hubspot_connected` from the mapped portal (tokens are resolved on demand via
 *  the provisioner, never stored). */
export function publicClient(client: Client) {
  const { hubspot_access_token: _deprecated, ...rest } = client;
  return {
    ...rest,
    hubspot_connected: !!client.hubspot_portal_id,
  };
}

export const clientService = {
  async getByExternalId(externalId: string): Promise<Client | null> {
    const direct = await prisma.client.findUnique({ where: { external_id: externalId } });
    if (direct) return direct;
    // Fall back to a known slug alias (e.g. GTMOS-style "bridge-it" → "bridgeit").
    const canonical = canonicalClientSlug(externalId);
    if (canonical !== externalId) {
      return prisma.client.findUnique({ where: { external_id: canonical } });
    }
    return null;
  },

  /** Create or update a client keyed by external_id. */
  async upsert(params: UpsertClientParams): Promise<Client> {
    const { external_id, name, active, hubspot_portal_id } = params;

    return prisma.client.upsert({
      where: { external_id },
      update: {
        // Only overwrite fields that were explicitly provided.
        ...(name !== undefined ? { name } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(hubspot_portal_id !== undefined ? { hubspot_portal_id } : {}),
      },
      create: {
        external_id,
        name: name ?? external_id,
        active: active ?? true,
        hubspot_portal_id: hubspot_portal_id ?? null,
      },
    });
  },
};
