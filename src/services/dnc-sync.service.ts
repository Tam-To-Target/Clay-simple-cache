import prisma from "../db/prisma";
import type { Client, DncSource } from "@prisma/client";
import { dncService, normalizeEntry, NormalizedDncEntry } from "./dnc.service";
import {
  fetchListContacts,
  fetchListSize,
  searchDncLists,
  DncLevel,
  HubspotListContact,
} from "./hubspot-lists.service";
import { getValidToken, HubspotAccessError } from "./hubspot-token.service";
import { createKeyedThrottle, mapWithConcurrency } from "./http-retry";
import { normalizeDomain } from "./normalization";
import { checkDisposable, checkFreeProvider } from "../email-finder/static-lists";

export interface SourceSyncResult {
  source_id: string;
  client_external_id: string;
  hubspot_list_id: string | null;
  label: string | null;
  level: string;
  status: "ok" | "error" | "skipped" | "no_access" | "skipped_unchanged";
  entry_count: number;
  domain_count: number;
  /** Rows inserted by the diff (undefined when the sync didn't run a diff, e.g. skipped_unchanged). */
  added?: number;
  /** Rows deleted by the diff. */
  removed?: number;
  error?: string;
}

export interface DiscoverResult {
  client_external_id: string;
  portal_id: string | null;
  // 'skipped' = client has no HubSpot portal (e.g. onboarding not finished) —
  // an expected long-lived state, NOT a failure; runs must not exit non-zero
  // for it night after night.
  status: "ok" | "error" | "no_access" | "skipped";
  sources_active: number;
  deactivated: { list_id: string | null; name: string | null }[];
  /** Lists that matched the prefix but had no Individual/Domain suffix — reported, not synced. */
  unclassified: { client_external_id: string; list_id: string; name: string }[];
  /** Classified lists discovered this run, with current membership size — fed into syncClient's skip-unchanged check. */
  lists: { listId: string; name: string; level: DncLevel; contact_count: number | null }[];
  error?: string;
}

export interface DetectResult {
  client_external_id: string;
  changed: boolean;
  reason?: string;
  error?: string;
}

export function dncListPrefix(): string {
  return process.env.DNC_LIST_NAME_PREFIX || "TAM - Do Not Contact";
}

/**
 * Clients synced in parallel. Read at call time (not module load) so tests can
 * set it per-case and a running process picks up a Railway var change on the
 * next invocation without a redeploy.
 */
function dncSyncConcurrency(): number {
  const n = Number(process.env.DNC_SYNC_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4;
}

/**
 * Max age of a source's last FULL membership sync before a size-unchanged
 * result is no longer trusted (catches a same-size list swap). Read at call
 * time — see {@link dncSyncConcurrency}.
 */
function fullRefreshHours(): number {
  const n = Number(process.env.DNC_FULL_REFRESH_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 168;
}

// HubSpot's rate limit is per-portal; a single process-wide throttle would
// needlessly serialize unrelated clients against each other during a
// concurrent multi-client run. Keyed + memoized so all calls for one portal
// still share the same ~8 req/s pacing.
const hsThrottleFor = createKeyedThrottle(125);

/**
 * Ping the database with retry/backoff before a scheduled run starts.
 *
 * Neon computes autosuspend when idle, so a cron that fires while the compute is
 * asleep can fail on its very first query with `P1001 Can't reach database
 * server` — which is exactly how the daily sync died. The web service never sees
 * this because constant traffic keeps the compute warm. Retrying gives Neon a
 * few seconds to resume. (Also prefer the pooled `-pooler` DATABASE_URL for
 * scheduled jobs — it tolerates resumes far better than a direct connection.)
 *
 * Only connection failures (P1001) are retried; any other error is re-thrown at
 * once. Returns once a `SELECT 1` succeeds, or throws after the last attempt.
 */
export async function warmupDatabase(
  opts: { attempts?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<void> {
  const attempts = opts.attempts ?? 6;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let i = 1; i <= attempts; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      if (i > 1) console.log(`Database reachable after ${i} attempt(s).`);
      return;
    } catch (err: any) {
      const msg = err?.message || String(err);
      const isConnErr =
        err?.code === "P1001" ||
        err?.errorCode === "P1001" ||
        /can't reach database server|P1001/i.test(msg);
      if (!isConnErr || i === attempts) throw err;
      const delay = baseDelayMs * 2 ** (i - 1);
      console.log(
        `DB unreachable (attempt ${i}/${attempts}) — Neon compute may be resuming; retrying in ${delay}ms…`
      );
      await sleep(delay);
    }
  }
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
  // email_domain is carried in `data` (not just used inline) so a later
  // incremental sync can reconstruct a HubspotListContact from the cached
  // dnc_entries row without a batch-read (see buildKnownContactsMap).
  for (const c of contacts) {
    const entry = normalizeEntry({
      email: c.email,
      phone: c.phone,
      reason,
      data: {
        hubspot_contact_id: c.hubspot_id,
        hubspot_list_id: source.hubspot_list_id,
        email_domain: c.email_domain,
      },
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
 * Reconstruct a "known contacts" map from a source's existing dnc_entries —
 * rows written by buildEntries carry `hubspot_contact_id` (+ email_domain) in
 * `data`, so an incremental sync can skip batch-reading any HubSpot id we've
 * already cached and only pull the NEW membership ids. Domain-derived rows
 * (data.derived_from === "email_domain") have no hubspot_contact_id and are
 * naturally excluded.
 */
async function buildKnownContactsMap(sourceId: string): Promise<Map<string, HubspotListContact>> {
  const rows = await prisma.dncEntry.findMany({
    where: { source_id: sourceId },
    select: { email: true, phone_e164: true, data: true },
  });

  const known = new Map<string, HubspotListContact>();
  for (const row of rows) {
    const data = (row.data as Record<string, unknown>) || {};
    const hubspotId = data.hubspot_contact_id;
    if (typeof hubspotId !== "string" || !hubspotId) continue;
    known.set(hubspotId, {
      hubspot_id: hubspotId,
      email: row.email,
      phone: row.phone_e164,
      email_domain: typeof data.email_domain === "string" ? data.email_domain : null,
    });
  }
  return known;
}

/**
 * Sync a single HubSpot-list source: resolve a fresh token, pull the current
 * membership, build level-appropriate entries, and diff-write the source's
 * entries.
 *
 * Three paths, cheapest first:
 *  - **skip-unchanged**: caller already knows the list's current size
 *    (`opts.currentSize`, typically from discovery's `hs_list_size`) and it
 *    matches what we last saw, the last sync was clean, and we're not overdue
 *    for a full re-pull → zero API calls.
 *  - **incremental**: something might have changed but a full re-read isn't
 *    due yet → page memberships, batch-read only ids we haven't cached.
 *  - **full refresh**: overdue (or `opts.force`) → batch-read every id,
 *    regardless of the cache, and reset the full-sync clock.
 */
export async function syncHubspotSource(
  client: Client,
  source: DncSource,
  opts?: { currentSize?: number | null; force?: boolean }
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

  const force = opts?.force ?? false;
  const currentSize = opts?.currentSize;
  const fullSyncAgeMs = source.last_full_sync_at ? Date.now() - source.last_full_sync_at.getTime() : Infinity;
  const fullRefreshDue = fullSyncAgeMs > fullRefreshHours() * 3_600_000;

  if (
    !force &&
    !fullRefreshDue &&
    currentSize != null &&
    source.last_list_size === currentSize &&
    source.last_sync_status === "ok"
  ) {
    const result: SourceSyncResult = {
      ...base,
      status: "skipped_unchanged",
      entry_count: source.last_entry_count,
    };
    // A skip IS a successful verification — bump last_synced_at/status so the
    // next run's "how stale is this" checks stay accurate — but leave
    // last_list_size/last_full_sync_at/last_entry_count untouched (nothing
    // was actually re-read).
    await recordSync(source.id, result, { skipOnly: true });
    return result;
  }

  try {
    const portalId = client.hubspot_portal_id;
    const tokenProvider = (forceToken?: boolean) => getValidToken(portalId, { force: forceToken });
    const throttle = hsThrottleFor(portalId);
    const doFullRefresh = force || fullRefreshDue;

    const contacts = doFullRefresh
      ? await fetchListContacts(tokenProvider, source.hubspot_list_id, { throttle })
      : await fetchListContacts(tokenProvider, source.hubspot_list_id, {
          throttle,
          known: await buildKnownContactsMap(source.id),
        });

    const entries = buildEntries(contacts, source);
    const domainCount = entries.filter((e) => e.domain).length;
    const diff = await dncService.diffSourceEntries(client.id, source.id, "hubspot_list", entries);

    const result: SourceSyncResult = {
      ...base,
      status: "ok",
      entry_count: diff.count,
      domain_count: domainCount,
      added: diff.added,
      removed: diff.removed,
    };
    await recordSync(source.id, result, {
      last_list_size: currentSize ?? contacts.length,
      last_full_sync_at: doFullRefresh ? new Date() : undefined,
    });
    return result;
  } catch (err: any) {
    // Client revoked HubSpot access (app uninstalled / grant gone): skip this
    // source, never fail the run.
    const status = err instanceof HubspotAccessError ? ("no_access" as const) : ("error" as const);
    // A deleted/renamed list (e.g. HTTP 404) also lands here — recorded
    // per-source, never fatal to the rest of the run.
    const result = { ...base, status, error: err?.message || String(err) };
    await recordSync(source.id, result);
    return result;
  }
}

/**
 * Sync every active HubSpot-list source for one client.
 *
 * `opts.sizeByListId` (typically discovery's fresh `hs_list_size` per list) is
 * consulted first; a manual-origin source not covered by it (manual pins
 * often live outside the discovered-list search) gets its own cheap
 * `fetchListSize` lookup so it can still take the skip-unchanged path. A null
 * size (unknown) is passed straight through — `syncHubspotSource` treats an
 * unknown size as "must sync".
 */
export async function syncClient(
  client: Client,
  opts?: { sizeByListId?: Map<string, number | null>; force?: boolean }
): Promise<SourceSyncResult[]> {
  const sources = await prisma.dncSource.findMany({
    where: { client_id: client.id, type: "hubspot_list", active: true },
  });

  const portalId = client.hubspot_portal_id;
  const sizeByListId = opts?.sizeByListId;
  const force = opts?.force ?? false;

  const results: SourceSyncResult[] = [];
  for (const source of sources) {
    let currentSize: number | null | undefined = source.hubspot_list_id
      ? sizeByListId?.get(source.hubspot_list_id)
      : undefined;

    if (currentSize === undefined && source.origin === "manual" && source.hubspot_list_id && portalId && !force) {
      currentSize = await fetchListSize(
        (f) => getValidToken(portalId, { force: f }),
        source.hubspot_list_id,
        { throttle: hsThrottleFor(portalId) }
      );
    }

    results.push(await syncHubspotSource(client, source, { currentSize, force }));
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
    lists: [],
  };

  if (!client.hubspot_portal_id) {
    // Expected state for a client whose portal isn't connected yet — skip,
    // don't error (an error here made every nightly run exit 1 forever).
    return { ...base, status: "skipped", error: "Client has no HubSpot portal id" };
  }

  let lists;
  try {
    const portalId = client.hubspot_portal_id;
    lists = await searchDncLists((force) => getValidToken(portalId, { force }), dncListPrefix(), {
      throttle: hsThrottleFor(portalId),
    });
  } catch (err: any) {
    // Access revoked (app uninstalled / grant gone) → skip, not a hard error.
    const status = err instanceof HubspotAccessError ? ("no_access" as const) : ("error" as const);
    return { ...base, status, error: err?.message || String(err) };
  }

  const classified = lists.filter((l) => l.level);
  base.unclassified = lists
    .filter((l) => !l.level)
    .map((l) => ({ client_external_id: client.external_id, list_id: l.listId, name: l.name }));
  base.lists = classified.map((l) => ({
    listId: l.listId,
    name: l.name,
    level: l.level!,
    contact_count: l.contact_count,
  }));

  // Manual pins are the registry of record — discovery never touches them (a
  // manual pin on a convention-named list keeps its explicit level).
  const manualIds = new Set(
    (
      await prisma.dncSource.findMany({
        where: { client_id: client.id, type: "hubspot_list", origin: "manual" },
        select: { hubspot_list_id: true },
      })
    )
      .map((s) => s.hubspot_list_id)
      .filter((id): id is string => !!id)
  );

  // Upsert a source per classified list discovery owns.
  for (const l of classified) {
    if (manualIds.has(l.listId)) continue;
    await prisma.dncSource.upsert({
      where: {
        client_id_hubspot_list_id: { client_id: client.id, hubspot_list_id: l.listId },
      },
      update: { label: l.name, dnc_level: l.level!, active: true },
      create: {
        client_id: client.id,
        type: "hubspot_list",
        origin: "discovered",
        hubspot_list_id: l.listId,
        label: l.name,
        dnc_level: l.level!,
        active: true,
      },
    });
  }
  base.sources_active = classified.length;

  // Deactivate DISCOVERED hubspot_list sources whose list is no longer present,
  // and clear their (now-stale) entries. Manual pins (origin='manual') are the
  // registry of record and are NEVER auto-deactivated here.
  const presentIds = new Set(classified.map((l) => l.listId));
  const existing = await prisma.dncSource.findMany({
    where: { client_id: client.id, type: "hubspot_list", active: true, origin: "discovered" },
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
  client: Client,
  opts?: { force?: boolean }
): Promise<{ discover: DiscoverResult; sync: SourceSyncResult[] }> {
  const discover = await discoverClient(client);
  if (discover.status !== "ok") return { discover, sync: [] };
  const sizeByListId = new Map<string, number | null>(discover.lists.map((l) => [l.listId, l.contact_count]));
  const sync = await syncClient(client, { sizeByListId, force: opts?.force });
  return { discover, sync };
}

/** Sync all active HubSpot-list sources across all active clients (no re-discovery). */
export async function syncAllHubspotSources(opts?: { force?: boolean }): Promise<SourceSyncResult[]> {
  const clients = await prisma.client.findMany({ where: { active: true } });
  const all = await mapWithConcurrency(clients, dncSyncConcurrency(), async (client) => {
    try {
      return await syncClient(client, { force: opts?.force });
    } catch (err: any) {
      // One client's unexpected failure must never abort the rest of the pool.
      return [
        {
          source_id: "",
          client_external_id: client.external_id,
          hubspot_list_id: null,
          label: null,
          level: "",
          status: "error" as const,
          entry_count: 0,
          domain_count: 0,
          error: err?.message || String(err),
        },
      ];
    }
  });
  return all.flat();
}

/** Re-discover + sync every active client (the daily job). */
export async function discoverAndSyncAll(
  onClient?: (index: number, total: number, slug: string, entries: number, error?: string) => void,
  opts?: { force?: boolean }
): Promise<{
  discover: DiscoverResult[];
  sync: SourceSyncResult[];
}> {
  const clients = await prisma.client.findMany({ where: { active: true } });
  const total = clients.length;
  let done = 0;

  const perClient = await mapWithConcurrency(clients, dncSyncConcurrency(), async (client) => {
    let discover: DiscoverResult;
    let sync: SourceSyncResult[];
    try {
      const r = await discoverAndSyncClient(client, opts);
      discover = r.discover;
      sync = r.sync;
    } catch (err: any) {
      // Per-client try/catch — one client's failure can't fail the whole run.
      discover = {
        client_external_id: client.external_id,
        portal_id: client.hubspot_portal_id,
        status: "error",
        sources_active: 0,
        deactivated: [],
        unclassified: [],
        lists: [],
        error: err?.message || String(err),
      };
      sync = [];
    }

    done++;
    // With clients running concurrently, callbacks may fire out of order —
    // `done` is a completion counter, not this client's position in `clients`.
    const entries = sync.filter((s) => s.status === "ok").reduce((n, s) => n + s.entry_count, 0);
    onClient?.(done, total, client.external_id, entries, discover.error);

    return { discover, sync };
  });

  return {
    discover: perClient.map((r) => r.discover),
    sync: perClient.flatMap((r) => r.sync),
  };
}

/**
 * Hourly in-process change detector: for each active client, spend ONE
 * `searchDncLists` call (+ one `fetchListSize` per manual source) to check
 * whether anything about its DNC lists moved — a new/missing list, a
 * name/size drift on a discovered list, or a size drift on a manual pin. When
 * nothing moved, that's the entire cost of the check. When something did,
 * `discoverAndSyncClient` runs for that client (its own skip-unchanged logic
 * still applies per-source, so only the list(s) that actually changed get a
 * real membership pull).
 */
export async function detectAndSyncChangedClients(): Promise<{
  checked: number;
  changed: DetectResult[];
  sync: SourceSyncResult[];
}> {
  const clients = await prisma.client.findMany({ where: { active: true } });
  const changed: DetectResult[] = [];
  const sync: SourceSyncResult[] = [];

  await mapWithConcurrency(clients, dncSyncConcurrency(), async (client) => {
    try {
      if (!client.hubspot_portal_id) {
        changed.push({ client_external_id: client.external_id, changed: false, reason: "no_portal" });
        return;
      }
      const portalId = client.hubspot_portal_id;

      let lists;
      try {
        lists = await searchDncLists((force) => getValidToken(portalId, { force }), dncListPrefix(), {
          throttle: hsThrottleFor(portalId),
        });
      } catch (err: any) {
        if (err instanceof HubspotAccessError) {
          changed.push({ client_external_id: client.external_id, changed: false, reason: "no_access" });
        } else {
          changed.push({
            client_external_id: client.external_id,
            changed: false,
            error: err?.message || String(err),
          });
        }
        return;
      }

      const classified = lists.filter((l) => l.level);
      const classifiedById = new Map(classified.map((l) => [l.listId, l]));

      const [discoveredSources, manualSources] = await Promise.all([
        prisma.dncSource.findMany({
          where: { client_id: client.id, type: "hubspot_list", active: true, origin: "discovered" },
        }),
        prisma.dncSource.findMany({
          where: { client_id: client.id, type: "hubspot_list", active: true, origin: "manual" },
        }),
      ]);
      const discoveredById = new Map(discoveredSources.map((s) => [s.hubspot_list_id, s]));

      let diff = false;
      let reason: string | undefined;

      for (const l of classified) {
        const existing = discoveredById.get(l.listId);
        if (!existing) {
          diff = true;
          reason = "new_list";
          break;
        }
        if (existing.label !== l.name) {
          diff = true;
          reason = "name_drift";
          break;
        }
        // A null contact_count means HubSpot didn't report a size — that's
        // "no signal", not "changed"; treating it as drift would re-sync the
        // list on every detector tick forever. The daily full pass covers it.
        if (l.contact_count != null && existing.last_list_size !== l.contact_count) {
          diff = true;
          reason = "size_drift";
          break;
        }
      }
      if (!diff) {
        for (const s of discoveredSources) {
          if (s.hubspot_list_id && !classifiedById.has(s.hubspot_list_id)) {
            diff = true;
            reason = "missing_list";
            break;
          }
        }
      }
      if (!diff) {
        for (const s of manualSources) {
          if (!s.hubspot_list_id) continue;
          const size = await fetchListSize((force) => getValidToken(portalId, { force }), s.hubspot_list_id, {
            throttle: hsThrottleFor(portalId),
          });
          // null = size unavailable — no signal, not drift (see above).
          if (size != null && size !== s.last_list_size) {
            diff = true;
            reason = "manual_size_drift";
            break;
          }
        }
      }

      if (!diff) {
        // A client with no active hubspot_list sources at all AND nothing
        // discovered in the portal has nothing to compare — that's a valid
        // "unchanged" state, not an error.
        const noLists = classified.length === 0 && discoveredSources.length === 0 && manualSources.length === 0;
        changed.push({
          client_external_id: client.external_id,
          changed: false,
          reason: noLists ? "no_lists" : undefined,
        });
        return;
      }

      const detected: DetectResult = { client_external_id: client.external_id, changed: true, reason };
      changed.push(detected);
      try {
        const r = await discoverAndSyncClient(client);
        sync.push(...r.sync);
      } catch (err: any) {
        detected.error = err?.message || String(err);
      }
    } catch (err: any) {
      changed.push({ client_external_id: client.external_id, changed: false, error: err?.message || String(err) });
    }
  });

  return { checked: clients.length, changed, sync };
}

interface RecordSyncExtra {
  last_list_size?: number | null;
  last_full_sync_at?: Date;
  /** Skip-unchanged verification: touch only last_synced_at/last_sync_status. */
  skipOnly?: boolean;
}

async function recordSync(sourceId: string, result: SourceSyncResult, extra?: RecordSyncExtra): Promise<void> {
  if (extra?.skipOnly) {
    await prisma.dncSource.update({
      where: { id: sourceId },
      data: {
        last_synced_at: new Date(),
        last_sync_status: "ok",
      },
    });
    return;
  }

  await prisma.dncSource.update({
    where: { id: sourceId },
    data: {
      last_synced_at: new Date(),
      last_sync_status: result.status,
      last_sync_error: result.error ?? null,
      last_entry_count: result.entry_count,
      ...(extra?.last_list_size !== undefined ? { last_list_size: extra.last_list_size } : {}),
      ...(extra?.last_full_sync_at !== undefined ? { last_full_sync_at: extra.last_full_sync_at } : {}),
    },
  });
}
