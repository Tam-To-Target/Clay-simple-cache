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
   * Replace ALL entries belonging to a source with a fresh set (full snapshot).
   * Used by HubSpot sync and CSV "replace" imports. Atomic per source.
   */
  async replaceSourceEntries(
    clientId: string,
    sourceId: string,
    sourceType: DncSourceType,
    entries: NormalizedDncEntry[]
  ): Promise<number> {
    const rows = entries.map((e) => ({
      client_id: clientId,
      source_id: sourceId,
      source_type: sourceType,
      email: e.email,
      phone_e164: e.phone_e164,
      domain: e.domain,
      reason: e.reason,
      data: e.data as Prisma.InputJsonValue,
    }));

    await prisma.$transaction([
      prisma.dncEntry.deleteMany({ where: { source_id: sourceId } }),
      ...(rows.length > 0
        ? [prisma.dncEntry.createMany({ data: rows })]
        : []),
    ]);

    return rows.length;
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
