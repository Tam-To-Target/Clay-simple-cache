import prisma from "../db/prisma";
import type { Prisma } from "@prisma/client";
import { normalizeEmail, normalizePhone, normalizeDomain } from "./normalization";

export type DncSourceType = "csv" | "hubspot_list" | "manual";

/** A normalized contact identifier set. At least one field should be present. */
export interface DncIdentifiers {
  email?: string | null;
  phone_e164?: string | null;
  domain?: string | null;
}

/** Raw entry (pre-normalization) used by importers/sync. */
export interface RawDncEntry {
  email?: string | null;
  phone?: string | null;
  domain?: string | null;
  reason?: string | null;
  data?: Record<string, unknown>;
}

export interface NormalizedDncEntry {
  email: string | null;
  phone_e164: string | null;
  domain: string | null;
  reason: string | null;
  data: Record<string, unknown>;
}

/**
 * Normalize the identifiers from a /dnc-check request body.
 * Domain is taken explicitly OR derived from the email's host (for lookup
 * purposes only — we never WRITE a derived domain into the DNC list).
 */
export function normalizeCheckIdentifiers(input: {
  email?: string;
  phone?: string;
  domain?: string;
}): DncIdentifiers & { email_domain: string | null } {
  const email = input.email ? normalizeEmail(input.email) : null;
  const phone = input.phone ? normalizePhone(input.phone)?.e164 ?? null : null;
  const explicitDomain = input.domain ? normalizeDomain(input.domain) : null;

  // Domain to match against company-level DNC entries.
  const emailDomain = email && email.includes("@") ? email.split("@")[1] : null;

  return {
    email,
    phone_e164: phone,
    domain: explicitDomain,
    email_domain: emailDomain,
  };
}

/** Normalize a raw entry coming from a CSV row or HubSpot contact. */
export function normalizeEntry(raw: RawDncEntry): NormalizedDncEntry | null {
  const email = raw.email ? normalizeEmail(raw.email) : null;
  const phone = raw.phone ? normalizePhone(raw.phone)?.e164 ?? null : null;
  const domain = raw.domain ? normalizeDomain(raw.domain) : null;

  // An entry with no usable identifier is useless — drop it.
  if (!email && !phone && !domain) return null;

  return {
    email: email || null,
    phone_e164: phone,
    domain,
    reason: raw.reason?.trim() || null,
    data: raw.data ?? {},
  };
}

/** Result of a diff-based source sync. `count` is the resulting total for the source. */
export interface DiffSyncResult {
  count: number;
  added: number;
  removed: number;
  changed: boolean;
}

/**
 * Identity key used to diff a source's existing rows against a freshly-fetched
 * entry set. Two entries are "the same row" iff every identifier matches
 * (null/empty normalized identically on both sides).
 */
function entryIdentityKey(e: {
  email?: string | null;
  phone_e164?: string | null;
  domain?: string | null;
}): string {
  return `${e.email ?? ""}|${e.phone_e164 ?? ""}|${e.domain ?? ""}`;
}

export const dncService = {
  /**
   * Find the first DNC entry for a client matching ANY of the provided
   * identifiers (email, phone, explicit domain, or the email's domain).
   * Returns the entry with its source attached, or null.
   */
  async findMatch(
    clientId: string,
    ids: DncIdentifiers & { email_domain?: string | null }
  ) {
    const or: Prisma.DncEntryWhereInput[] = [];
    if (ids.email) or.push({ email: ids.email });
    if (ids.phone_e164) or.push({ phone_e164: ids.phone_e164 });

    // Match a domain-level entry against either the explicit domain or the
    // domain extracted from the email.
    const domains = [ids.domain, ids.email_domain].filter(Boolean) as string[];
    if (domains.length > 0) or.push({ domain: { in: domains } });

    if (or.length === 0) return null;

    const entry = await prisma.dncEntry.findFirst({
      where: { client_id: clientId, OR: or },
      include: { source: true },
      orderBy: { created_at: "asc" },
    });

    if (!entry) return null;

    // Report which identifier triggered the match.
    let matchedOn: "email" | "phone" | "domain";
    let matchedValue: string;
    if (ids.email && entry.email === ids.email) {
      matchedOn = "email";
      matchedValue = entry.email;
    } else if (ids.phone_e164 && entry.phone_e164 === ids.phone_e164) {
      matchedOn = "phone";
      matchedValue = entry.phone_e164;
    } else {
      matchedOn = "domain";
      matchedValue = entry.domain ?? "";
    }

    return { entry, matchedOn, matchedValue };
  },

  /**
   * Reconcile a source's entries with a freshly-fetched set BY DIFF instead of
   * wholesale replace: only rows whose identity key (email|phone|domain) is
   * genuinely new are inserted, only rows whose key vanished are deleted, and
   * everything else is left untouched — including its `created_at`. That
   * timestamp is the whole point: with a full delete+reinsert every row's
   * `created_at` resets on every sync, so it can never be used as a "have we
   * already processed this entry" watermark (see PhoneburnerMember.dnc_processed_through).
   * With diff-based writes, `created_at` only moves for rows that actually changed.
   */
  async diffSourceEntries(
    clientId: string,
    sourceId: string,
    sourceType: DncSourceType,
    entries: NormalizedDncEntry[]
  ): Promise<DiffSyncResult> {
    const existing = await prisma.dncEntry.findMany({
      where: { source_id: sourceId },
      select: { id: true, email: true, phone_e164: true, domain: true },
    });

    // First-wins de-dup on both sides: existing rows shouldn't collide (the
    // identity columns are effectively unique per source), but incoming
    // entries can (e.g. the same person appears twice in a HubSpot list page).
    const existingByKey = new Map<string, { id: string }>();
    for (const row of existing) {
      const key = entryIdentityKey(row);
      if (!existingByKey.has(key)) existingByKey.set(key, { id: row.id });
    }

    const incomingByKey = new Map<string, NormalizedDncEntry>();
    for (const e of entries) {
      const key = entryIdentityKey(e);
      if (!incomingByKey.has(key)) incomingByKey.set(key, e);
    }

    const toInsert: NormalizedDncEntry[] = [];
    for (const [key, e] of incomingByKey) {
      if (!existingByKey.has(key)) toInsert.push(e);
    }

    const toDeleteIds: string[] = [];
    for (const [key, row] of existingByKey) {
      if (!incomingByKey.has(key)) toDeleteIds.push(row.id);
    }

    const insertRows = toInsert.map((e) => ({
      client_id: clientId,
      source_id: sourceId,
      source_type: sourceType,
      email: e.email,
      phone_e164: e.phone_e164,
      domain: e.domain,
      reason: e.reason,
      data: e.data as Prisma.InputJsonValue,
    }));

    // Chunk deletes — Postgres/Prisma `IN` lists get unwieldy past ~1000 ids.
    const deleteIdChunks: string[][] = [];
    for (let i = 0; i < toDeleteIds.length; i += 1000) {
      deleteIdChunks.push(toDeleteIds.slice(i, i + 1000));
    }

    const ops: Prisma.PrismaPromise<any>[] = [
      ...deleteIdChunks.map((chunk) => prisma.dncEntry.deleteMany({ where: { id: { in: chunk } } })),
      ...(insertRows.length > 0 ? [prisma.dncEntry.createMany({ data: insertRows })] : []),
    ];

    if (ops.length > 0) {
      await prisma.$transaction(ops);
    }

    const added = toInsert.length;
    const removed = toDeleteIds.length;
    const changed = added > 0 || removed > 0;

    if (changed) {
      await prisma.client.update({
        where: { id: clientId },
        data: { dnc_changed_at: new Date() },
      });
    }

    return { count: incomingByKey.size, added, removed, changed };
  },

  /**
   * Replace ALL entries belonging to a source with a fresh set (full snapshot).
   * Used by HubSpot sync and CSV "replace" imports.
   *
   * Implemented as a thin delegate to `diffSourceEntries` — the external
   * contract (returns the resulting count) is unchanged, but it's no longer
   * destructive to rows that are still present in the new set: their
   * `created_at` survives instead of being reset by a delete+reinsert.
   */
  async replaceSourceEntries(
    clientId: string,
    sourceId: string,
    sourceType: DncSourceType,
    entries: NormalizedDncEntry[]
  ): Promise<number> {
    const result = await this.diffSourceEntries(clientId, sourceId, sourceType, entries);
    return result.count;
  },

  /** Append entries to a source without clearing existing ones. */
  async appendSourceEntries(
    clientId: string,
    sourceId: string,
    sourceType: DncSourceType,
    entries: NormalizedDncEntry[]
  ): Promise<number> {
    if (entries.length === 0) return 0;
    await prisma.dncEntry.createMany({
      data: entries.map((e) => ({
        client_id: clientId,
        source_id: sourceId,
        source_type: sourceType,
        email: e.email,
        phone_e164: e.phone_e164,
        domain: e.domain,
        reason: e.reason,
        data: e.data as Prisma.InputJsonValue,
      })),
    });
    return entries.length;
  },
};
