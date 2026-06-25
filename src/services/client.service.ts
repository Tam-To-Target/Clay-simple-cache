import prisma from "../db/prisma";
import type { Client } from "@prisma/client";
import { suggestSimilar } from "./suggest";

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
  hubspot_access_token?: string | null;
}

/** Strip the HubSpot token before returning a client over the API. */
export function publicClient(client: Client) {
  const { hubspot_access_token, ...rest } = client;
  return {
    ...rest,
    hubspot_connected: !!hubspot_access_token,
  };
}

export const clientService = {
  async getByExternalId(externalId: string): Promise<Client | null> {
    return prisma.client.findUnique({ where: { external_id: externalId } });
  },

  /** Create or update a client keyed by external_id. */
  async upsert(params: UpsertClientParams): Promise<Client> {
    const { external_id, name, active, hubspot_portal_id, hubspot_access_token } = params;

    return prisma.client.upsert({
      where: { external_id },
      update: {
        // Only overwrite fields that were explicitly provided.
        ...(name !== undefined ? { name } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(hubspot_portal_id !== undefined ? { hubspot_portal_id } : {}),
        ...(hubspot_access_token !== undefined ? { hubspot_access_token } : {}),
      },
      create: {
        external_id,
        name: name ?? external_id,
        active: active ?? true,
        hubspot_portal_id: hubspot_portal_id ?? null,
        hubspot_access_token: hubspot_access_token ?? null,
      },
    });
  },
};
