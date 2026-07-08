/**
 * PhoneBurner DNC purge — Option B (live-fetch PB, compare to cached DNC, delete).
 * See PHONEBURNER_DNC_PURGE_PLAN.md and DNC_OPTIMIZATION_SPEC.md (Agent D).
 *
 * Two modes, chosen per member:
 *   - FULL scan: load the client's DNC identifier sets from `dnc_entries`, page
 *     the member's ENTIRE PhoneBurner book, collide each contact in memory,
 *     delete collisions, and rebuild the member's identity index
 *     (`phoneburner_contact_index`) as a byproduct — PB has no search API, so a
 *     full scan is the only way to enumerate a book. Demoted to a periodic
 *     reconciliation cadence (PB_FULL_SCAN_MAX_AGE_HOURS).
 *   - TARGETED purge: no book scan. Look up ONLY the client's DNC entries added
 *     since the member's watermark (`dnc_processed_through`) in the identity
 *     index, live-refetch each hit, and delete with ~1 API call per candidate.
 *
 * Safety (unchanged, applies to BOTH modes): dry-run by default, full
 * pre-delete snapshot audit row in `phoneburner_deletions`, HARD_MAX_RATIO=0.3
 * collision ratio gate, optional per-run delete cap, shared-book guard (only
 * delete a contact when EVERY client the member dials for suppresses it).
 */

import prisma from "../db/prisma";
import type { Client, PhoneburnerMember } from "@prisma/client";
import { normalizeEmail, normalizePhone, normalizeDomain } from "./normalization";
import { checkDisposable, checkFreeProvider } from "../email-finder/static-lists";
import { getMemberToken, getMemberUsername } from "./phoneburner-token.service";
import { createKeyedThrottle, mapWithConcurrency } from "./http-retry";
import {
  fetchMemberContacts,
  deletePbContact,
  fetchPbContact,
  PhoneburnerAccessError,
  PbContact,
} from "./phoneburner.service";

export interface PurgeOptions {
  dryRun: boolean;
  maxRatio: number;
  includeDomains: boolean;
  maxDeletesPerRun: number | null;
  /**
   * 'full' = today's whole-book scan (+ rebuilds the identity index).
   * 'targeted' = index-only lookup of NEW-since-watermark DNC entries, no scan.
   * 'auto' (default) = per member: full when due (PB_FULL_SCAN_MAX_AGE_HOURS),
   * otherwise targeted; targeted "no index yet" falls back to a full scan.
   */
  mode: "auto" | "full" | "targeted";
}

export type MemberStatus =
  | "ok"
  | "skipped_no_token"
  | "skipped_no_access"
  | "skipped_no_dnc"
  | "skipped_no_new_dnc"
  | "skipped_no_index"
  | "aborted_ratio"
  | "capped"
  | "error";

export interface MemberPurgeResult {
  pb_member_id: string;
  pb_username: string | null;
  status: MemberStatus;
  contacts_scanned: number;
  collisions: number;
  deleted: number;
  failed: number;
  /** Contacts on this client's DNC but kept because another client the member serves still wants them. */
  protected_other_client?: number;
  /** Which purge path actually ran for this member. */
  mode?: "full" | "targeted";
  /** Index rows removed because the live PB contact no longer exists (stale index entry). */
  stale_index?: number;
  error?: string;
}

export interface ClientPurgeResult {
  client_external_id: string;
  client_name: string;
  members: MemberPurgeResult[];
}

export interface DncSets {
  emails: Set<string>;
  phones: Set<string>;
  domains: Set<string>;
}

/**
 * Hard ceiling on the per-member collision ratio. A book more than this fraction
 * on the DNC is NEVER purged — the whole member aborts. Guards the case where a
 * client is running a legitimate campaign INTO a heavily-suppressed segment
 * (e.g. StudentBridge, ~82% on DNC by design), as well as a corrupt/over-broad
 * DNC sync. PB_PURGE_MAX_RATIO may set a STRICTER (lower) gate, but can never
 * raise it above this ceiling.
 */
export const HARD_MAX_RATIO = 0.3;

/** One shared throttle per PB member account, not one process-wide throttle —
 * PhoneBurner's rate limit is per-member, so independent members must not
 * serialize against each other now that purgeClient runs them concurrently. */
const pbThrottleFor = createKeyedThrottle(150);

export function purgeOptionsFromEnv(overrides?: Partial<PurgeOptions>): PurgeOptions {
  const ratio = Number(process.env.PB_PURGE_MAX_RATIO);
  const cap = Number(process.env.PB_PURGE_MAX_DELETES_PER_RUN);
  const requestedRatio =
    overrides?.maxRatio ?? (Number.isFinite(ratio) && ratio > 0 ? ratio : HARD_MAX_RATIO);
  return {
    // Dry-run unless EXPLICITLY disabled — deletes are destructive.
    dryRun: overrides?.dryRun ?? process.env.PB_PURGE_DRY_RUN !== "false",
    // Clamp to the hard ceiling — config can only tighten the gate, never loosen it.
    maxRatio: Math.min(HARD_MAX_RATIO, requestedRatio),
    includeDomains: overrides?.includeDomains ?? process.env.PB_PURGE_INCLUDE_DOMAINS !== "false",
    maxDeletesPerRun: overrides?.maxDeletesPerRun ?? (Number.isFinite(cap) && cap > 0 ? cap : null),
    mode: overrides?.mode ?? "auto",
  };
}

/** Read at call time (not module load) so tests can flip the env var per-case. */
function fullScanMaxAgeHours(): number {
  const raw = Number(process.env.PB_FULL_SCAN_MAX_AGE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 168;
}

/** Read at call time (not module load) so tests can flip the env var per-case. */
function purgeConcurrency(): number {
  const raw = Number(process.env.PB_PURGE_CONCURRENCY);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/** Does this member need a full book scan (vs. reusing the identity index)? */
export function needsFullScan(member: PhoneburnerMember): boolean {
  if (!member.last_full_scan_at) return true;
  const maxAgeMs = fullScanMaxAgeHours() * 60 * 60 * 1000;
  return Date.now() - member.last_full_scan_at.getTime() > maxAgeMs;
}

/** Load a client's DNC identifier sets from the cache. */
export async function loadDncSets(clientId: string): Promise<DncSets> {
  const rows = await prisma.dncEntry.findMany({
    where: { client_id: clientId },
    select: { email: true, phone_e164: true, domain: true },
  });
  const emails = new Set<string>();
  const phones = new Set<string>();
  const domains = new Set<string>();
  for (const r of rows) {
    if (r.email) emails.add(r.email);
    if (r.phone_e164) phones.add(r.phone_e164);
    if (r.domain) domains.add(r.domain);
  }
  return { emails, phones, domains };
}

/** Corporate domain of an email, free/disposable-filtered (DNC-build parity). */
function corporateEmailDomain(email: string): string | null {
  const at = email.indexOf("@");
  if (at < 0) return null;
  const d = normalizeDomain(email.slice(at + 1));
  if (!d) return null;
  if (checkFreeProvider(d) || checkDisposable(d)) return null;
  return d;
}

export interface Collision {
  matched_on: "email" | "phone" | "domain";
  matched_value: string;
}

/**
 * Does a PhoneBurner contact collide with the DNC sets? Normalizes PB fields the
 * SAME way `dnc_entries` were built (email lower, phone→E.164, domain). Checks
 * email, then phone, then (optionally) corporate email-domain.
 */
export function collide(contact: PbContact, sets: DncSets, includeDomains: boolean): Collision | null {
  for (const raw of contact.emails) {
    const e = normalizeEmail(raw);
    if (e && sets.emails.has(e)) return { matched_on: "email", matched_value: e };
  }
  for (const raw of contact.phones) {
    const p = normalizePhone(raw)?.e164;
    if (p && sets.phones.has(p)) return { matched_on: "phone", matched_value: p };
  }
  if (includeDomains) {
    for (const raw of contact.emails) {
      const d = corporateEmailDomain(normalizeEmail(raw));
      if (d && sets.domains.has(d)) return { matched_on: "domain", matched_value: d };
    }
  }
  return null;
}

/** Identifier profile of one PB contact, reconstructed from index rows. */
interface ContactProfile {
  emails: Set<string>;
  phones: Set<string>;
  domains: Set<string>;
}

/**
 * Same collision test as `collide()`, but against a pre-built identifier
 * profile (index rows) instead of a live `PbContact` — used by the targeted
 * path both to confirm a candidate really collides with the owning client's
 * current DNC sets and, identically, to run the shared-book guard against
 * every other serving client's sets.
 */
function collideProfile(profile: ContactProfile, sets: DncSets, includeDomains: boolean): boolean {
  for (const e of profile.emails) if (sets.emails.has(e)) return true;
  for (const p of profile.phones) if (sets.phones.has(p)) return true;
  if (includeDomains) {
    for (const d of profile.domains) if (sets.domains.has(d)) return true;
  }
  return false;
}

/** Split an array into chunks of at most `size` (Postgres/Prisma `IN` lists get unwieldy past ~500-1000). */
function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface IndexRow {
  pb_member_id: string;
  pb_contact_id: string;
  email: string | null;
  phone_e164: string | null;
  domain: string | null;
}

/**
 * One row per (contact, identifier): each normalized email, each normalized
 * E.164 phone, and each distinct corporate email domain (free/disposable
 * filtered — same helper as `collide`), deduped per contact. Contacts with no
 * identifiers at all are skipped (nothing to index them by).
 */
function buildIndexRows(memberId: string, contacts: PbContact[]): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const c of contacts) {
    const emails = new Set<string>();
    const phones = new Set<string>();
    const domains = new Set<string>();
    for (const raw of c.emails) {
      const e = normalizeEmail(raw);
      if (e) {
        emails.add(e);
        const d = corporateEmailDomain(e);
        if (d) domains.add(d);
      }
    }
    for (const raw of c.phones) {
      const p = normalizePhone(raw)?.e164;
      if (p) phones.add(p);
    }
    if (emails.size === 0 && phones.size === 0 && domains.size === 0) continue;
    for (const e of emails) rows.push({ pb_member_id: memberId, pb_contact_id: c.id, email: e, phone_e164: null, domain: null });
    for (const p of phones) rows.push({ pb_member_id: memberId, pb_contact_id: c.id, email: null, phone_e164: p, domain: null });
    for (const d of domains) rows.push({ pb_member_id: memberId, pb_contact_id: c.id, email: null, phone_e164: null, domain: d });
  }
  return rows;
}

const INDEX_CREATE_CHUNK = 5000;

/** Rebuild one member's identity index from a full scan's contact list. Index
 * is advisory (self-heals via the targeted path's stale-entry cleanup), so
 * delete-then-insert doesn't need to be transactional — delete must simply
 * precede inserts. */
async function rebuildMemberIndex(memberId: string, contacts: PbContact[]): Promise<void> {
  await prisma.phoneburnerContactIndex.deleteMany({ where: { pb_member_id: memberId } });
  const rows = buildIndexRows(memberId, contacts);
  for (const chunk of chunkArray(rows, INDEX_CREATE_CHUNK)) {
    if (chunk.length) await prisma.phoneburnerContactIndex.createMany({ data: chunk });
  }
}

/** Replace one contact's index rows from a fresh live record (targeted path,
 * after determining it no longer collides — keeps the index from going stale
 * until the next full scan). */
async function refreshContactIndex(memberId: string, contact: PbContact): Promise<void> {
  await prisma.phoneburnerContactIndex.deleteMany({ where: { pb_member_id: memberId, pb_contact_id: contact.id } });
  const rows = buildIndexRows(memberId, [contact]);
  if (rows.length) await prisma.phoneburnerContactIndex.createMany({ data: rows });
}

interface RunCounters {
  deletedThisRun: number;
}

interface TouchMemberData {
  api_access_ok: boolean;
  last_full_scan_at?: Date;
  dnc_processed_through?: Date;
}

async function touchMember(id: string, data: TouchMemberData): Promise<void> {
  try {
    await prisma.phoneburnerMember.update({
      where: { id },
      data: {
        api_access_ok: data.api_access_ok,
        last_run_at: new Date(),
        ...(data.last_full_scan_at ? { last_full_scan_at: data.last_full_scan_at } : {}),
        ...(data.dnc_processed_through ? { dnc_processed_through: data.dnc_processed_through } : {}),
      },
    });
  } catch {
    /* member row vanished mid-run — non-fatal */
  }
}

/** Purge a single member's PhoneBurner book against a client's DNC sets.
 *
 * `guardSets` are the DNC sets of EVERY client this member dials for (including
 * the current one). A PhoneBurner member has ONE shared book, so a contact is
 * deleted only when it is suppressed by ALL of those clients — never when it is
 * still a live lead for another client the same member serves (no cross-tenant
 * data loss). For the common single-client member, guardSets === [sets].
 *
 * This is the FULL-scan path: it also rebuilds the member's identity index
 * (`phoneburner_contact_index`) as a byproduct — the only way the targeted
 * path later gets ~1-API-call deletes instead of re-scanning the whole book.
 */
export async function purgeMember(
  client: Client,
  member: PhoneburnerMember,
  sets: DncSets,
  guardSets: DncSets[],
  opts: PurgeOptions,
  runId: string | null,
  counters: RunCounters
): Promise<MemberPurgeResult> {
  const base: MemberPurgeResult = {
    pb_member_id: member.pb_member_id,
    pb_username: member.pb_username,
    status: "ok",
    contacts_scanned: 0,
    collisions: 0,
    deleted: 0,
    failed: 0,
    mode: "full",
  };

  // Resolve the member token up front; unknown member → skip (never error).
  const token0 = await getMemberToken(member.pb_member_id);
  if (!token0) {
    await touchMember(member.id, { api_access_ok: false });
    return { ...base, status: "skipped_no_token" };
  }
  const getToken = async (force?: boolean): Promise<string> => {
    const t = await getMemberToken(member.pb_member_id, { force });
    if (!t) throw new Error(`member token unavailable for ${member.pb_member_id}`);
    return t;
  };
  const throttle = pbThrottleFor(member.pb_member_id);

  // Captured BEFORE fetching — this is the instant the scan "sees" the DNC
  // cache, and becomes the new watermark on a clean completion.
  const scanStartedAt = new Date();

  let contacts: PbContact[];
  try {
    contacts = await fetchMemberContacts(member.pb_member_id, getToken, undefined, { throttle });
  } catch (err: any) {
    if (err instanceof PhoneburnerAccessError) {
      await touchMember(member.id, { api_access_ok: false });
      return { ...base, status: "skipped_no_access", error: err.message };
    }
    return { ...base, status: "error", error: err?.message || String(err) };
  }

  base.contacts_scanned = contacts.length;
  base.pb_username = base.pb_username ?? getMemberUsername(member.pb_member_id);

  // The scan itself succeeded — rebuild the identity index regardless of what
  // happens next (dry-run / aborted_ratio / capped / ok all keep this data).
  await rebuildMemberIndex(member.pb_member_id, contacts);

  const collisions: { contact: PbContact; match: Collision }[] = [];
  let protectedByOtherClient = 0;
  for (const c of contacts) {
    const match = collide(c, sets, opts.includeDomains);
    if (!match) continue;
    // Shared-book safety: only delete when SUPPRESSED BY EVERY client this member
    // dials for. If another serving client doesn't suppress it, it may be that
    // client's live lead — leave it.
    const suppressedByAll =
      guardSets.length <= 1 || guardSets.every((g) => collide(c, g, opts.includeDomains) !== null);
    if (!suppressedByAll) {
      protectedByOtherClient++;
      continue;
    }
    collisions.push({ contact: c, match });
  }
  base.collisions = collisions.length;
  if (protectedByOtherClient > 0) base.protected_other_client = protectedByOtherClient;

  // Safety gate — a collision ratio this high signals a legitimate campaign into
  // a suppressed segment or a corrupt/over-broad DNC sync, NOT a normally dirty
  // book. Abort this member's deletes entirely; surface for review. Never purge
  // most of a book. (opts.maxRatio is clamped to HARD_MAX_RATIO upstream.)
  if (contacts.length > 0 && collisions.length / contacts.length > opts.maxRatio) {
    // The scan happened and the index was rebuilt above; do NOT advance the
    // watermark — these entries were never actually collided-and-cleared.
    await touchMember(member.id, { api_access_ok: true, last_full_scan_at: scanStartedAt });
    return { ...base, status: "aborted_ratio" };
  }

  for (const { contact, match } of collisions) {
    if (opts.maxDeletesPerRun !== null && counters.deletedThisRun >= opts.maxDeletesPerRun) {
      base.status = "capped";
      break;
    }

    // Backup-before-delete: snapshot the full record so the delete is re-importable.
    const audit = await prisma.phoneburnerDeletion.create({
      data: {
        client_id: client.id,
        pb_member_id: member.pb_member_id,
        pb_contact_id: contact.id,
        matched_on: match.matched_on,
        matched_value: match.matched_value,
        snapshot: contact.raw as any,
        status: opts.dryRun ? "dry_run" : "pending",
        run_id: runId,
      },
    });

    if (opts.dryRun) {
      base.deleted++; // "would delete"
      continue;
    }

    try {
      const result = await deletePbContact(contact.id, getToken, { throttle });
      await prisma.phoneburnerDeletion.update({
        where: { id: audit.id },
        data: {
          status: result.ok ? "deleted" : "failed",
          http_status: result.status,
          error: result.ok ? null : `unexpected HTTP ${result.status}`,
        },
      });
      if (result.ok) {
        base.deleted++;
        counters.deletedThisRun++;
      } else {
        base.failed++;
      }
    } catch (err: any) {
      await prisma.phoneburnerDeletion.update({
        where: { id: audit.id },
        data: { status: "failed", error: err?.message || String(err) },
      });
      base.failed++;
    }
  }

  // Watermark only advances on a clean LIVE completion (not dry-run, not
  // capped, not aborted — aborted already returned above — and with zero
  // failed deletes: a failed delete must resurface on the next run, not wait
  // for the weekly reconciliation scan).
  const cleanLive = !opts.dryRun && base.status === "ok" && base.failed === 0;
  await touchMember(member.id, {
    api_access_ok: true,
    last_full_scan_at: scanStartedAt,
    dnc_processed_through: cleanLive ? scanStartedAt : undefined,
  });
  return base;
}

/**
 * Targeted purge: no book scan. Looks up ONLY the client's DNC entries added
 * since this member's watermark in the identity index (byproduct of the last
 * full scan), live-refetches each hit for a fresh snapshot, and deletes with
 * ~1 API call per candidate instead of re-scanning the whole book.
 */
export async function targetedPurgeMember(
  client: Client,
  member: PhoneburnerMember,
  opts: PurgeOptions,
  runId: string | null,
  counters: RunCounters,
  ctx: PurgeContext
): Promise<MemberPurgeResult> {
  const base: MemberPurgeResult = {
    pb_member_id: member.pb_member_id,
    pb_username: member.pb_username,
    status: "ok",
    contacts_scanned: 0,
    collisions: 0,
    deleted: 0,
    failed: 0,
    mode: "targeted",
  };

  const watermark = member.dnc_processed_through ?? new Date(0);
  // Captured BEFORE the query — an entry inserted while this run is in flight
  // must stay above the new watermark, or a concurrent sync could slip a row
  // into the gap and have it silently skipped until the next full scan.
  const queriedAt = new Date();
  const newEntries = await prisma.dncEntry.findMany({
    where: { client_id: client.id, created_at: { gt: watermark } },
    select: { email: true, phone_e164: true, domain: true, created_at: true },
  });

  // Nothing new since the watermark — zero API calls, DB-only. Advance the
  // watermark to the query instant (there's nothing pending to resurface later).
  if (newEntries.length === 0) {
    await touchMember(member.id, { api_access_ok: member.api_access_ok, dnc_processed_through: queriedAt });
    return { ...base, status: "skipped_no_new_dnc" };
  }

  // No index rows for this member at all (never had a full scan, or it's a
  // brand new member) — the caller (auto mode) must fall back to a full scan.
  const indexedContacts = await prisma.phoneburnerContactIndex.findMany({
    where: { pb_member_id: member.pb_member_id },
    distinct: ["pb_contact_id"],
    select: { pb_contact_id: true },
  });
  if (indexedContacts.length === 0) {
    return { ...base, status: "skipped_no_index" };
  }
  const indexedContactCount = indexedContacts.length;

  const addedEmails = new Set<string>();
  const addedPhones = new Set<string>();
  const addedDomains = new Set<string>();
  for (const e of newEntries) {
    if (e.email) addedEmails.add(e.email);
    if (e.phone_e164) addedPhones.add(e.phone_e164);
    if (e.domain) addedDomains.add(e.domain);
  }

  // Index lookup (IN-chunks of 500) → candidate pb_contact_ids.
  const candidateContactIds = new Set<string>();
  for (const c of chunkArray([...addedEmails], 500)) {
    const rows = await prisma.phoneburnerContactIndex.findMany({
      where: { pb_member_id: member.pb_member_id, email: { in: c } },
      select: { pb_contact_id: true },
    });
    for (const r of rows) candidateContactIds.add(r.pb_contact_id);
  }
  for (const c of chunkArray([...addedPhones], 500)) {
    const rows = await prisma.phoneburnerContactIndex.findMany({
      where: { pb_member_id: member.pb_member_id, phone_e164: { in: c } },
      select: { pb_contact_id: true },
    });
    for (const r of rows) candidateContactIds.add(r.pb_contact_id);
  }
  if (opts.includeDomains) {
    for (const c of chunkArray([...addedDomains], 500)) {
      const rows = await prisma.phoneburnerContactIndex.findMany({
        where: { pb_member_id: member.pb_member_id, domain: { in: c } },
        select: { pb_contact_id: true },
      });
      for (const r of rows) candidateContactIds.add(r.pb_contact_id);
    }
  }

  // Load ALL index rows for the candidate ids to reconstruct each contact's
  // full identifier profile (needed for the shared-book guard, which must
  // check every identifier a contact has, not just the one that matched).
  const profiles = new Map<string, ContactProfile>();
  for (const c of chunkArray([...candidateContactIds], 500)) {
    const rows = await prisma.phoneburnerContactIndex.findMany({
      where: { pb_member_id: member.pb_member_id, pb_contact_id: { in: c } },
      select: { pb_contact_id: true, email: true, phone_e164: true, domain: true },
    });
    for (const r of rows) {
      let p = profiles.get(r.pb_contact_id);
      if (!p) {
        p = { emails: new Set(), phones: new Set(), domains: new Set() };
        profiles.set(r.pb_contact_id, p);
      }
      if (r.email) p.emails.add(r.email);
      if (r.phone_e164) p.phones.add(r.phone_e164);
      if (r.domain) p.domains.add(r.domain);
    }
  }

  // Shared-book guard, same semantics as the full-scan path: a candidate is
  // deletable only when it collides with EVERY client this member serves.
  const servingIds = ctx.servingClientIds(member.pb_member_id);
  const guardSets = await Promise.all((servingIds.length ? servingIds : [client.id]).map(ctx.getSets));
  const clientSets = await ctx.getSets(client.id);

  const candidatesAfterGuard: string[] = [];
  let protectedByOtherClient = 0;
  for (const contactId of candidateContactIds) {
    const profile = profiles.get(contactId);
    if (!profile) continue;
    // Defensive re-check: the candidate was found via an exact index match on
    // one of the client's own added identifiers, so this should always be
    // true — guards against a data-integrity edge case rather than a normal path.
    if (!collideProfile(profile, clientSets, opts.includeDomains)) continue;
    const suppressedByAll = guardSets.every((g) => collideProfile(profile, g, opts.includeDomains));
    if (!suppressedByAll) {
      protectedByOtherClient++;
      continue;
    }
    candidatesAfterGuard.push(contactId);
  }

  const maxCreatedAt = newEntries.reduce((max, e) => (e.created_at > max ? e.created_at : max), newEntries[0].created_at);

  // Ratio gate — against the TOTAL indexed book size (proxy for the member's
  // book), same intent as the full-scan gate: never let a corrupt/over-broad
  // DNC diff nuke a large fraction of a shared book.
  const ratio = candidatesAfterGuard.length / Math.max(1, indexedContactCount);
  if (ratio > opts.maxRatio) {
    // No API calls were made to reach this decision — retain whatever
    // api_access_ok already said; only bump last_run_at for observability.
    // Watermark deliberately NOT advanced — these entries were never cleared.
    await touchMember(member.id, { api_access_ok: member.api_access_ok });
    return {
      ...base,
      status: "aborted_ratio",
      collisions: candidatesAfterGuard.length,
      protected_other_client: protectedByOtherClient || undefined,
    };
  }

  base.collisions = candidatesAfterGuard.length;
  if (protectedByOtherClient > 0) base.protected_other_client = protectedByOtherClient;

  // Nothing survived the guard — clean completion, nothing to verify/delete.
  if (candidatesAfterGuard.length === 0) {
    await touchMember(member.id, { api_access_ok: member.api_access_ok, dnc_processed_through: maxCreatedAt });
    return base;
  }

  // From here on we need live PB access — resolve the token now, not earlier
  // (keeps the "nothing changed" / "no candidates" paths API-call-free).
  const token0 = await getMemberToken(member.pb_member_id);
  if (!token0) {
    await touchMember(member.id, { api_access_ok: false });
    return { ...base, status: "skipped_no_token" };
  }
  const getToken = async (force?: boolean): Promise<string> => {
    const t = await getMemberToken(member.pb_member_id, { force });
    if (!t) throw new Error(`member token unavailable for ${member.pb_member_id}`);
    return t;
  };
  const throttle = pbThrottleFor(member.pb_member_id);

  let staleIndex = 0;
  for (const contactId of candidatesAfterGuard) {
    let live: PbContact | null;
    try {
      live = await fetchPbContact(contactId, getToken, { throttle });
    } catch (err: any) {
      if (err instanceof PhoneburnerAccessError) {
        // Conservative: leave the watermark untouched — this run didn't
        // finish verifying all candidates against the live book.
        await touchMember(member.id, { api_access_ok: false });
        return {
          ...base,
          status: "skipped_no_access",
          error: err.message,
          stale_index: staleIndex || undefined,
        };
      }
      base.failed++;
      continue;
    }

    if (live === null) {
      // Already gone from PB — stale index entry, not a delete or a failure.
      await prisma.phoneburnerContactIndex.deleteMany({
        where: { pb_member_id: member.pb_member_id, pb_contact_id: contactId },
      });
      staleIndex++;
      continue;
    }

    // Re-verify against the client's FULL current DNC sets on the LIVE
    // record — the shared book may have changed since the index was built.
    const liveMatch = collide(live, clientSets, opts.includeDomains);
    if (!liveMatch) {
      // No longer suppressed by the owning client — refresh this contact's
      // index rows from the live record instead of leaving stale identifiers.
      await refreshContactIndex(member.pb_member_id, live);
      continue;
    }

    if (opts.maxDeletesPerRun !== null && counters.deletedThisRun >= opts.maxDeletesPerRun) {
      base.status = "capped";
      break;
    }

    const audit = await prisma.phoneburnerDeletion.create({
      data: {
        client_id: client.id,
        pb_member_id: member.pb_member_id,
        pb_contact_id: live.id,
        matched_on: liveMatch.matched_on,
        matched_value: liveMatch.matched_value,
        snapshot: live.raw as any,
        status: opts.dryRun ? "dry_run" : "pending",
        run_id: runId,
      },
    });

    if (opts.dryRun) {
      base.deleted++;
      continue;
    }

    try {
      const result = await deletePbContact(live.id, getToken, { throttle });
      await prisma.phoneburnerDeletion.update({
        where: { id: audit.id },
        data: {
          status: result.ok ? "deleted" : "failed",
          http_status: result.status,
          error: result.ok ? null : `unexpected HTTP ${result.status}`,
        },
      });
      if (result.ok) {
        base.deleted++;
        counters.deletedThisRun++;
        await prisma.phoneburnerContactIndex.deleteMany({
          where: { pb_member_id: member.pb_member_id, pb_contact_id: live.id },
        });
      } else {
        base.failed++;
      }
    } catch (err: any) {
      await prisma.phoneburnerDeletion.update({
        where: { id: audit.id },
        data: { status: "failed", error: err?.message || String(err) },
      });
      base.failed++;
    }
  }

  if (staleIndex > 0) base.stale_index = staleIndex;

  // Watermark only advances on a clean LIVE completion (not dry-run, not
  // capped — access-error/aborted already returned above — and with zero
  // failed deletes/fetches, so failures self-retry next run instead of
  // waiting for the weekly reconciliation scan).
  const cleanLive = !opts.dryRun && base.status === "ok" && base.failed === 0;
  await touchMember(member.id, {
    api_access_ok: true,
    dnc_processed_through: cleanLive ? maxCreatedAt : undefined,
  });
  return base;
}

/** Shared per-run context: a memoized DNC-set loader + the cross-client serving map. */
export interface PurgeContext {
  getSets: (clientId: string) => Promise<DncSets>;
  /** Every client id a PhoneBurner member dials for (across ALL active clients). */
  servingClientIds: (pbMemberId: string) => string[];
}

/** Decide + run the right purge path for one member per `opts.mode`. */
async function purgeMemberDispatch(
  client: Client,
  member: PhoneburnerMember,
  sets: DncSets,
  opts: PurgeOptions,
  runId: string | null,
  counters: RunCounters,
  ctx: PurgeContext
): Promise<MemberPurgeResult> {
  const runFull = async (): Promise<MemberPurgeResult> => {
    const servingIds = ctx.servingClientIds(member.pb_member_id);
    const guardSets = await Promise.all((servingIds.length ? servingIds : [client.id]).map(ctx.getSets));
    return purgeMember(client, member, sets, guardSets, opts, runId, counters);
  };

  if (opts.mode === "full") return runFull();
  if (opts.mode === "targeted") return targetedPurgeMember(client, member, opts, runId, counters, ctx);

  // auto
  if (needsFullScan(member)) return runFull();
  const targeted = await targetedPurgeMember(client, member, opts, runId, counters, ctx);
  if (targeted.status === "skipped_no_index") {
    // Targeted mode has nothing to work with yet — fall back to a full scan
    // for this member so it isn't stuck without an index forever.
    return runFull();
  }
  return targeted;
}

/** Purge every active member of one client. */
export async function purgeClient(
  client: Client,
  opts: PurgeOptions,
  runId: string | null,
  counters: RunCounters,
  ctx: PurgeContext
): Promise<ClientPurgeResult> {
  const members = await prisma.phoneburnerMember.findMany({
    where: { client_id: client.id, active: true },
  });
  if (members.length === 0) return { client_external_id: client.external_id, client_name: client.name, members: [] };

  const sets = await ctx.getSets(client.id);
  // No DNC entries → nothing to collide; don't waste a full PB scan.
  if (sets.emails.size === 0 && sets.phones.size === 0 && sets.domains.size === 0) {
    return {
      client_external_id: client.external_id,
      client_name: client.name,
      members: members.map((m) => ({
        pb_member_id: m.pb_member_id,
        pb_username: m.pb_username,
        status: "skipped_no_dnc" as const,
        contacts_scanned: 0,
        collisions: 0,
        deleted: 0,
        failed: 0,
      })),
    };
  }

  // Members purged in parallel — per-member throttle (keyed above) keeps each
  // account's own rate limit, and a per-member try/catch keeps one member's
  // failure from taking down the others' results.
  const results = await mapWithConcurrency(members, purgeConcurrency(), async (member) => {
    try {
      return await purgeMemberDispatch(client, member, sets, opts, runId, counters, ctx);
    } catch (err: any) {
      return {
        pb_member_id: member.pb_member_id,
        pb_username: member.pb_username,
        status: "error" as const,
        contacts_scanned: 0,
        collisions: 0,
        deleted: 0,
        failed: 0,
        error: err?.message || String(err),
      };
    }
  });

  return { client_external_id: client.external_id, client_name: client.name, members: results };
}

export interface PurgeRunSummary {
  run_id: string;
  dry_run: boolean;
  clients: ClientPurgeResult[];
  totals: {
    clients_processed: number;
    members_processed: number;
    members_skipped: number;
    contacts_scanned: number;
    collisions_found: number;
    deleted: number;
    failed: number;
    /** Contacts on a client's DNC kept because another client the member serves still wants them. */
    protected_other_client: number;
    /** In-memory only — not persisted as PhoneburnerPurgeRun columns, see `notes`. */
    targeted_members: number;
    full_scan_members: number;
  };
  status: "ok" | "partial" | "error";
}

const SKIPPED: MemberStatus[] = [
  "skipped_no_token",
  "skipped_no_access",
  "skipped_no_dnc",
  "skipped_no_new_dnc",
  "skipped_no_index",
  "aborted_ratio",
];

/**
 * Log a one-line per-client rollup as each client finishes — the "how many
 * removed on <client>" view that makes each run easy to debug. Logged from
 * runPurge so it shows for EVERY trigger (CLI, HTTP endpoint, cron) in the
 * service logs.
 */
function logClientResult(c: ClientPurgeResult, dryRun: boolean): void {
  const removed = c.members.reduce((n, m) => n + m.deleted, 0);
  const failed = c.members.reduce((n, m) => n + m.failed, 0);
  const scanned = c.members.reduce((n, m) => n + m.contacts_scanned, 0);
  const skipped = c.members.filter((m) => SKIPPED.includes(m.status)).length;
  const extra = [
    `scanned ${scanned}`,
    failed ? `${failed} failed` : "",
    skipped ? `${skipped} member(s) skipped` : "",
  ]
    .filter(Boolean)
    .join(", ");
  console.log(
    `[purge] ${c.client_name} (${c.client_external_id}): ` +
      `${removed} ${dryRun ? "would remove" : "removed"} — ${extra}`
  );
}

/** Run the purge for one client (by external_id) or all eligible clients. */
export async function runPurge(
  opts: PurgeOptions,
  onlySlug?: string
): Promise<PurgeRunSummary> {
  const run = await prisma.phoneburnerPurgeRun.create({
    data: { dry_run: opts.dryRun, status: "running" },
  });
  const counters: RunCounters = { deletedThisRun: 0 };

  const clients = await prisma.client.findMany({
    where: {
      active: true,
      ...(onlySlug ? { external_id: onlySlug } : {}),
      phoneburner_members: { some: { active: true } },
    },
  });

  // Cross-client serving map for the shared-book guard. Built from EVERY member
  // row of an active client (NOT filtered by member.active) so a stale/deactivated
  // mapping can't shrink a member's serving set and let the guard collapse to a
  // single client — which would re-open the cross-tenant deletion it prevents.
  // (Over-including is safe: it only makes the guard MORE conservative.)
  const allMemberRows = await prisma.phoneburnerMember.findMany({
    where: { client: { active: true } },
    select: { pb_member_id: true, client_id: true },
  });
  const servingMap = new Map<string, string[]>();
  for (const m of allMemberRows) {
    const arr = servingMap.get(m.pb_member_id) ?? [];
    if (!arr.includes(m.client_id)) arr.push(m.client_id);
    servingMap.set(m.pb_member_id, arr);
  }
  const setsCache = new Map<string, DncSets>();
  const ctx: PurgeContext = {
    getSets: async (cid) => {
      if (!setsCache.has(cid)) setsCache.set(cid, await loadDncSets(cid));
      return setsCache.get(cid)!;
    },
    servingClientIds: (pid) => servingMap.get(pid) ?? [],
  };

  // Dry-run rows are informational; clear the prior dry-run's rows for the
  // targeted clients so repeated dry-runs don't accumulate duplicates.
  if (opts.dryRun && clients.length) {
    await prisma.phoneburnerDeletion.deleteMany({
      where: { status: "dry_run", client_id: { in: clients.map((c) => c.id) } },
    });
  }

  const clientResults: ClientPurgeResult[] = [];
  let hadError = false;
  for (const client of clients) {
    try {
      const cr = await purgeClient(client, opts, run.id, counters, ctx);
      clientResults.push(cr);
      logClientResult(cr, opts.dryRun);
    } catch (err: any) {
      hadError = true;
      const cr: ClientPurgeResult = {
        client_external_id: client.external_id,
        client_name: client.name,
        members: [
          {
            pb_member_id: "-",
            pb_username: null,
            status: "error",
            contacts_scanned: 0,
            collisions: 0,
            deleted: 0,
            failed: 0,
            error: err?.message || String(err),
          },
        ],
      };
      clientResults.push(cr);
      logClientResult(cr, opts.dryRun);
    }
  }

  const allMembers = clientResults.flatMap((c) => c.members);
  const totals = {
    clients_processed: clientResults.length,
    members_processed: allMembers.filter((m) => m.status === "ok" || m.status === "capped").length,
    members_skipped: allMembers.filter((m) => SKIPPED.includes(m.status)).length,
    contacts_scanned: allMembers.reduce((n, m) => n + m.contacts_scanned, 0),
    collisions_found: allMembers.reduce((n, m) => n + m.collisions, 0),
    deleted: allMembers.reduce((n, m) => n + m.deleted, 0),
    failed: allMembers.reduce((n, m) => n + m.failed, 0),
    protected_other_client: allMembers.reduce((n, m) => n + (m.protected_other_client ?? 0), 0),
    targeted_members: allMembers.filter((m) => m.mode === "targeted").length,
    full_scan_members: allMembers.filter((m) => m.mode === "full").length,
  };

  if (allMembers.some((m) => m.status === "error")) hadError = true;
  const status: PurgeRunSummary["status"] = hadError ? "partial" : "ok";

  await prisma.phoneburnerPurgeRun.update({
    where: { id: run.id },
    data: {
      finished_at: new Date(),
      clients_processed: totals.clients_processed,
      members_processed: totals.members_processed,
      members_skipped: totals.members_skipped,
      contacts_scanned: totals.contacts_scanned,
      collisions_found: totals.collisions_found,
      deleted: totals.deleted,
      failed: totals.failed,
      status,
      notes:
        [
          totals.protected_other_client
            ? `${totals.protected_other_client} contact(s) kept (shared-book, wanted by another client)`
            : null,
          `${totals.full_scan_members} full-scan, ${totals.targeted_members} targeted member run(s)`,
        ]
          .filter(Boolean)
          .join("; ") || null,
    },
  });

  return { run_id: run.id, dry_run: opts.dryRun, clients: clientResults, totals, status };
}
