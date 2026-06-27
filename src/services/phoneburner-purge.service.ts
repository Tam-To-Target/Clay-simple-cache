/**
 * PhoneBurner DNC purge — Option B (live-fetch PB, compare to cached DNC, delete).
 * See PHONEBURNER_DNC_PURGE_PLAN.md.
 *
 * For each active client with mapped PhoneBurner members:
 *   1. Load the client's DNC identifier sets from `dnc_entries` (emails / phones
 *      / domains) — the already-cached, authoritative suppression reference.
 *   2. For each dialing member: resolve its token, full-scan its PB book, and
 *      collide each contact in memory (email/phone/domain) with the DNC sets,
 *      using the SAME normalization that built `dnc_entries` (match parity).
 *   3. Safety gate: abort a member's deletes if collisions exceed PB_PURGE_MAX_RATIO
 *      of its book (guards against a corrupt DNC sync nuking a whole book).
 *   4. Back up each collision (full snapshot) to `phoneburner_deletions`, then
 *      DELETE it from PhoneBurner (unless dry-run). Record per-member + per-run.
 *
 * Safety: dry-run by default, full pre-delete snapshot, ratio gate, optional
 * per-run delete cap, idempotent deletes, never throws past a single member.
 */

import prisma from "../db/prisma";
import type { Client, PhoneburnerMember } from "@prisma/client";
import { normalizeEmail, normalizePhone, normalizeDomain } from "./normalization";
import { checkDisposable, checkFreeProvider } from "../email-finder/static-lists";
import { getMemberToken, getMemberUsername } from "./phoneburner-token.service";
import {
  fetchMemberContacts,
  deletePbContact,
  PhoneburnerAccessError,
  PbContact,
} from "./phoneburner.service";

export interface PurgeOptions {
  dryRun: boolean;
  maxRatio: number;
  includeDomains: boolean;
  maxDeletesPerRun: number | null;
}

export type MemberStatus =
  | "ok"
  | "skipped_no_token"
  | "skipped_no_access"
  | "skipped_no_dnc"
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
  error?: string;
}

export interface ClientPurgeResult {
  client_external_id: string;
  members: MemberPurgeResult[];
}

export interface DncSets {
  emails: Set<string>;
  phones: Set<string>;
  domains: Set<string>;
}

export function purgeOptionsFromEnv(overrides?: Partial<PurgeOptions>): PurgeOptions {
  const ratio = Number(process.env.PB_PURGE_MAX_RATIO);
  const cap = Number(process.env.PB_PURGE_MAX_DELETES_PER_RUN);
  return {
    // Dry-run unless EXPLICITLY disabled — deletes are destructive.
    dryRun: overrides?.dryRun ?? process.env.PB_PURGE_DRY_RUN !== "false",
    maxRatio: overrides?.maxRatio ?? (Number.isFinite(ratio) && ratio > 0 ? ratio : 0.4),
    includeDomains: overrides?.includeDomains ?? process.env.PB_PURGE_INCLUDE_DOMAINS !== "false",
    maxDeletesPerRun: overrides?.maxDeletesPerRun ?? (Number.isFinite(cap) && cap > 0 ? cap : null),
  };
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

interface RunCounters {
  deletedThisRun: number;
}

/** Purge a single member's PhoneBurner book against a client's DNC sets.
 *
 * `guardSets` are the DNC sets of EVERY client this member dials for (including
 * the current one). A PhoneBurner member has ONE shared book, so a contact is
 * deleted only when it is suppressed by ALL of those clients — never when it is
 * still a live lead for another client the same member serves (no cross-tenant
 * data loss). For the common single-client member, guardSets === [sets]. */
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

  let contacts: PbContact[];
  try {
    contacts = await fetchMemberContacts(member.pb_member_id, getToken);
  } catch (err: any) {
    if (err instanceof PhoneburnerAccessError) {
      await touchMember(member.id, { api_access_ok: false });
      return { ...base, status: "skipped_no_access", error: err.message };
    }
    return { ...base, status: "error", error: err?.message || String(err) };
  }

  base.contacts_scanned = contacts.length;
  base.pb_username = base.pb_username ?? getMemberUsername(member.pb_member_id);

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

  // Safety gate — a collision ratio this high signals a corrupt DNC sync, not a
  // legitimately dirty book. Abort this member's deletes; surface for review.
  if (contacts.length > 0 && collisions.length / contacts.length > opts.maxRatio) {
    await touchMember(member.id, { api_access_ok: true });
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
      const result = await deletePbContact(contact.id, getToken);
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

  await touchMember(member.id, { api_access_ok: true });
  return base;
}

async function touchMember(id: string, data: { api_access_ok: boolean }): Promise<void> {
  try {
    await prisma.phoneburnerMember.update({ where: { id }, data: { ...data, last_run_at: new Date() } });
  } catch {
    /* member row vanished mid-run — non-fatal */
  }
}

/** Shared per-run context: a memoized DNC-set loader + the cross-client serving map. */
export interface PurgeContext {
  getSets: (clientId: string) => Promise<DncSets>;
  /** Every client id a PhoneBurner member dials for (across ALL active clients). */
  servingClientIds: (pbMemberId: string) => string[];
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
  if (members.length === 0) return { client_external_id: client.external_id, members: [] };

  const sets = await ctx.getSets(client.id);
  // No DNC entries → nothing to collide; don't waste a full PB scan.
  if (sets.emails.size === 0 && sets.phones.size === 0 && sets.domains.size === 0) {
    return {
      client_external_id: client.external_id,
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

  const results: MemberPurgeResult[] = [];
  for (const member of members) {
    // All clients this member dials for → only delete contacts suppressed by all.
    const servingIds = ctx.servingClientIds(member.pb_member_id);
    const guardSets = await Promise.all((servingIds.length ? servingIds : [client.id]).map(ctx.getSets));
    results.push(await purgeMember(client, member, sets, guardSets, opts, runId, counters));
  }
  return { client_external_id: client.external_id, members: results };
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
  };
  status: "ok" | "partial" | "error";
}

const SKIPPED: MemberStatus[] = ["skipped_no_token", "skipped_no_access", "skipped_no_dnc", "aborted_ratio"];

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

  // Cross-client serving map (ALL active clients, not just targets) so the
  // shared-book guard knows every client a member dials for even under a filter.
  const allActiveMembers = await prisma.phoneburnerMember.findMany({
    where: { active: true, client: { active: true } },
    select: { pb_member_id: true, client_id: true },
  });
  const servingMap = new Map<string, string[]>();
  for (const m of allActiveMembers) {
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
      clientResults.push(await purgeClient(client, opts, run.id, counters, ctx));
    } catch (err: any) {
      hadError = true;
      clientResults.push({
        client_external_id: client.external_id,
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
      });
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
    },
  });

  return { run_id: run.id, dry_run: opts.dryRun, clients: clientResults, totals, status };
}
