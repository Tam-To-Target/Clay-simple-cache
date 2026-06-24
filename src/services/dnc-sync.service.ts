import prisma from "../db/prisma";
import type { Client, DncSource } from "@prisma/client";
import { dncService, normalizeEntry, NormalizedDncEntry } from "./dnc.service";
import { fetchListContacts } from "./hubspot-lists.service";

export interface SourceSyncResult {
  source_id: string;
  client_external_id: string;
  hubspot_list_id: string | null;
  label: string | null;
  status: "ok" | "error" | "skipped";
  entry_count: number;
  error?: string;
}

/**
 * Sync a single HubSpot-list source: pull the current list membership,
 * normalize each contact, and replace the source's entries with the snapshot.
 */
export async function syncHubspotSource(
  client: Client,
  source: DncSource
): Promise<SourceSyncResult> {
  const base: SourceSyncResult = {
    source_id: source.id,
    client_external_id: client.external_id,
    hubspot_list_id: source.hubspot_list_id,
    label: source.label,
    status: "ok",
    entry_count: 0,
  };

  if (source.type !== "hubspot_list" || !source.hubspot_list_id) {
    return { ...base, status: "skipped", error: "Not a HubSpot list source" };
  }
  if (!client.hubspot_access_token) {
    const result = { ...base, status: "error" as const, error: "Client has no HubSpot access token" };
    await recordSync(source.id, result);
    return result;
  }

  try {
    const contacts = await fetchListContacts(client.hubspot_access_token, source.hubspot_list_id);

    const entries: NormalizedDncEntry[] = [];
    for (const c of contacts) {
      const entry = normalizeEntry({
        email: c.email,
        phone: c.phone,
        reason: source.label ? `HubSpot list: ${source.label}` : "HubSpot list membership",
        data: { hubspot_contact_id: c.hubspot_id, hubspot_list_id: source.hubspot_list_id },
      });
      if (entry) entries.push(entry);
    }

    const count = await dncService.replaceSourceEntries(
      client.id,
      source.id,
      "hubspot_list",
      entries
    );

    const result = { ...base, status: "ok" as const, entry_count: count };
    await recordSync(source.id, result);
    return result;
  } catch (err: any) {
    const result = { ...base, status: "error" as const, error: err?.message || String(err) };
    await recordSync(source.id, result);
    return result;
  }
}

/** Sync every active HubSpot-list source for one client. */
export async function syncClient(client: Client): Promise<SourceSyncResult[]> {
  const sources = await prisma.dncSource.findMany({
    where: { client_id: client.id, type: "hubspot_list", active: true },
  });

  const results: SourceSyncResult[] = [];
  for (const source of sources) {
    results.push(await syncHubspotSource(client, source));
  }
  return results;
}

/** Sync all active HubSpot-list sources across all active clients. */
export async function syncAllHubspotSources(): Promise<SourceSyncResult[]> {
  const clients = await prisma.client.findMany({ where: { active: true } });
  const all: SourceSyncResult[] = [];
  for (const client of clients) {
    all.push(...(await syncClient(client)));
  }
  return all;
}

async function recordSync(sourceId: string, result: SourceSyncResult): Promise<void> {
  await prisma.dncSource.update({
    where: { id: sourceId },
    data: {
      last_synced_at: new Date(),
      last_sync_status: result.status,
      last_sync_error: result.error ?? null,
      last_entry_count: result.entry_count,
    },
  });
}
