import prisma from "../db/prisma";
import type { Client, DncSource } from "@prisma/client";
import { dncService, normalizeEntry, NormalizedDncEntry } from "./dnc.service";
import {
  fetchListContacts,
  searchDncLists,
  HubspotListContact,
} from "./hubspot-lists.service";
import { getValidToken } from "./hubspot-token.service";
import { normalizeDomain } from "./normalization";
import { checkDisposable, checkFreeProvider } from "../email-finder/static-lists";

export interface SourceSyncResult {
  source_id: string;
  client_external_id: string;
  hubspot_list_id: string | null;
  label: string | null;
  level: string;
  status: "ok" | "error" | "skipped";
  entry_count: number;
  domain_count: number;
  error?: string;
}

export interface DiscoverResult {
  client_external_id: string;
  portal_id: string | null;
  status: "ok" | "error";
  sources_active: number;
  deactivated: { list_id: string | null; name: string | null }[];
  /** Lists that matched the prefix but had no Individual/Domain suffix — reported, not synced. */
  unclassified: { client_external_id: string; list_id: string; name: string }[];
  error?: string;
}

export function dncListPrefix(): string {
  return process.env.DNC_LIST_NAME_PREFIX || "TAM - Do Not Contact";
}

/**
 * Fail fast with a clear message if the env a sync run needs is missing.
 * Without this, a missing var dies silently on the first DB/provisioner call —
 * which is exactly how the cron service failed when its variables weren't set.
 */
export function assertSyncEnv(): void {
  const required = ["DATABASE_URL", "HUBSPOT_PROVISIONER_URL", "HUBSPOT_PROVISIONER_API_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Set them on this service (a Railway cron service does NOT inherit the web service's variables).`
    );
  }
}

/**
 * Extract a member's corporate email domain for domain-level suppression.
 * Prefers HubSpot's computed hs_email_domain, falls back to the email host.
 * Free/disposable providers (gmail.com, etc.) are excluded so we never suppress
 * a whole public domain.
 */
export function extractCorporateDomain(c: HubspotListContact): string | null {
  const raw =
    c.email_domain ||
    (c.email && c.email.includes("@") ? c.email.split("@")[1] : null);
  if (!raw) return null;
  const d = normalizeDomain(raw);
  if (!d) return null;
  if (checkFreeProvider(d) || checkDisposable(d)) return null;
  return d;
}

/** Build DNC entries from list members according to the source's level. */
function buildEntries(contacts: HubspotListContact[], source: DncSource): NormalizedDncEntry[] {
  const reason = source.label ? `HubSpot list: ${source.label}` : "HubSpot list membership";
  const entries: NormalizedDncEntry[] = [];

  // Exact email/phone suppression — applies to both individual and domain lists.
  for (const c of contacts) {
    const entry = normalizeEntry({
      email: c.email,
      phone: c.phone,
      reason,
      data: { hubspot_contact_id: c.hubspot_id, hubspot_list_id: source.hubspot_list_id },
    });
    if (entry) entries.push(entry);
  }

  // Domain-level lists additionally suppress each member's corporate domain.
  if (source.dnc_level === "domain") {
    const domainReason = source.label
      ? `HubSpot list (domain): ${source.label}`
      : "HubSpot list membership (domain)";
    const seen = new Set<string>();
    for (const c of contacts) {
      const domain = extractCorporateDomain(c);
      if (!domain || seen.has(domain)) continue;
      seen.add(domain);
      entries.push({
        email: null,
        phone_e164: null,
        domain,
        reason: domainReason,
        data: { hubspot_list_id: source.hubspot_list_id, derived_from: "email_domain" },
      });
    }
  }

  return entries;
}

/**
 * Sync a single HubSpot-list source: resolve a fresh token, pull the current
 * membership, build level-appropriate entries, and replace the source's entries.
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
    level: source.dnc_level,
    status: "ok",
    entry_count: 0,
    domain_count: 0,
  };

  if (source.type !== "hubspot_list" || !source.hubspot_list_id) {
    return { ...base, status: "skipped", error: "Not a HubSpot list source" };
  }
  if (!client.hubspot_portal_id) {
    const result = { ...base, status: "error" as const, error: "Client has no HubSpot portal id" };
    await recordSync(source.id, result);
    return result;
  }

  try {
    const portalId = client.hubspot_portal_id;
    const contacts = await fetchListContacts(
      (force) => getValidToken(portalId, { force }),
      source.hubspot_list_id
    );

    const entries = buildEntries(contacts, source);
    const domainCount = entries.filter((e) => e.domain).length;
    const count = await dncService.replaceSourceEntries(
      client.id,
      source.id,
      "hubspot_list",
      entries
    );

    const result = { ...base, status: "ok" as const, entry_count: count, domain_count: domainCount };
    await recordSync(source.id, result);
    return result;
  } catch (err: any) {
    // A deleted/renamed list (e.g. HTTP 404) lands here — recorded per-source,
    // never fatal to the rest of the run.
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

/**
 * Discover a client's DNC lists from HubSpot, (re)classify and upsert a source
 * per Individual/Domain list, deactivate sources whose list has disappeared, and
 * report any unclassified lists. Does NOT sync membership (call syncClient for that).
 */
export async function discoverClient(client: Client): Promise<DiscoverResult> {
  const base: DiscoverResult = {
    client_external_id: client.external_id,
    portal_id: client.hubspot_portal_id,
    status: "ok",
    sources_active: 0,
    deactivated: [],
    unclassified: [],
  };

  if (!client.hubspot_portal_id) {
    return { ...base, status: "error", error: "Client has no HubSpot portal id" };
  }

  let lists;
  try {
    const portalId = client.hubspot_portal_id;
    lists = await searchDncLists((force) => getValidToken(portalId, { force }), dncListPrefix());
  } catch (err: any) {
    return { ...base, status: "error", error: err?.message || String(err) };
  }

  const classified = lists.filter((l) => l.level);
  base.unclassified = lists
    .filter((l) => !l.level)
    .map((l) => ({ client_external_id: client.external_id, list_id: l.listId, name: l.name }));

  // Upsert a source per classified list.
  for (const l of classified) {
    await prisma.dncSource.upsert({
      where: {
        client_id_hubspot_list_id: { client_id: client.id, hubspot_list_id: l.listId },
      },
      update: { label: l.name, dnc_level: l.level!, active: true },
      create: {
        client_id: client.id,
        type: "hubspot_list",
        hubspot_list_id: l.listId,
        label: l.name,
        dnc_level: l.level!,
        active: true,
      },
    });
  }
  base.sources_active = classified.length;

  // Deactivate active hubspot_list sources whose list is no longer present, and
  // clear their (now-stale) entries so a deleted list stops suppressing.
  const presentIds = new Set(classified.map((l) => l.listId));
  const existing = await prisma.dncSource.findMany({
    where: { client_id: client.id, type: "hubspot_list", active: true },
  });
  for (const s of existing) {
    if (s.hubspot_list_id && !presentIds.has(s.hubspot_list_id)) {
      await dncService.replaceSourceEntries(client.id, s.id, "hubspot_list", []);
      await prisma.dncSource.update({
        where: { id: s.id },
        data: { active: false, last_sync_status: "deactivated", last_entry_count: 0 },
      });
      base.deactivated.push({ list_id: s.hubspot_list_id, name: s.label });
    }
  }

  return base;
}

/** Discover + sync one client. */
export async function discoverAndSyncClient(
  client: Client
): Promise<{ discover: DiscoverResult; sync: SourceSyncResult[] }> {
  const discover = await discoverClient(client);
  const sync = discover.status === "ok" ? await syncClient(client) : [];
  return { discover, sync };
}

/** Sync all active HubSpot-list sources across all active clients (no re-discovery). */
export async function syncAllHubspotSources(): Promise<SourceSyncResult[]> {
  const clients = await prisma.client.findMany({ where: { active: true } });
  const all: SourceSyncResult[] = [];
  for (const client of clients) {
    all.push(...(await syncClient(client)));
  }
  return all;
}

/** Re-discover + sync every active client (the daily job). */
export async function discoverAndSyncAll(
  onClient?: (index: number, total: number, slug: string, entries: number, error?: string) => void
): Promise<{
  discover: DiscoverResult[];
  sync: SourceSyncResult[];
}> {
  const clients = await prisma.client.findMany({ where: { active: true } });
  const discover: DiscoverResult[] = [];
  const sync: SourceSyncResult[] = [];
  for (let i = 0; i < clients.length; i++) {
    const r = await discoverAndSyncClient(clients[i]);
    discover.push(r.discover);
    sync.push(...r.sync);
    const entries = r.sync.filter((s) => s.status === "ok").reduce((n, s) => n + s.entry_count, 0);
    onClient?.(i + 1, clients.length, clients[i].external_id, entries, r.discover.error);
  }
  return { discover, sync };
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
