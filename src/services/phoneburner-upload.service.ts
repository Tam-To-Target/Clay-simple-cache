/**
 * Upload a list of leads into an SDR's PhoneBurner book (the programmatic
 * replacement for the manual "Clay → CSV import" flow), following the shared
 * dialing org's real convention (validated 2026-07-21, see SKILL-phoneburner-list.md):
 *
 *  - the org does NOT use per-client folders. A client is a TAG (its PascalCase
 *    client tag, e.g. "PlanIt"); a campaign is the tag "<ClientTag>: <Campaign>";
 *    the per-list identifier is a CUSTOM FIELD named "Lead Score" (e.g. "club8");
 *  - leads are created under the assigned SDR's own token (`owner_id` = their
 *    PhoneBurner member id);
 *  - PhoneBurner de-dupes on email/phone and MERGES on overlap. Setting Lead Score
 *    on a merged contact would OVERWRITE its prior list's — so we snapshot the
 *    seat's book first and stamp Lead Score on NET-NEW contacts only (existing
 *    contacts still get the new campaign tag, just not a new Lead Score);
 *  - numbers on the client's DNC are scrubbed BEFORE upload (PHONEBURNER_DNC_PURGE_PLAN.md
 *    §9); the response reports coverage + every collision so "clean" and
 *    "unchecked" are never confused.
 *
 * The Lead Score is minted by pb-lead-score.service (seeded once from GTMOS call
 * history by scripts/backfill-pb-convention.ts, then owned here). Custom fields
 * MUST be the `[{name,type,value}]` array shape — a plain dict returns 200 but
 * silently persists nothing.
 */

import prisma from "../db/prisma";
import type { Client } from "@prisma/client";
import { normalizeEmail, normalizePhone } from "./normalization";
import { normalizeCheckIdentifiers, dncService } from "./dnc.service";
import { getMemberToken } from "./phoneburner-token.service";
import { phoneburnerApiBase } from "./phoneburner-token.service";
import { fetchMemberContacts, PhoneburnerAccessError } from "./phoneburner.service";
import { withRetry, createThrottle, mapWithConcurrency } from "./http-retry";
import { loadRegistry, slugify } from "../config/registry";
import { issueLeadScore, peekNextLeadScore, recordLeadScore, type LeadScore } from "./pb-lead-score.service";

const USER_AGENT = process.env.PHONEBURNER_USER_AGENT || "TAM-DNC-Cache/1.0";
const MAX_RETRIES = 5;
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_SPACING_MS = 150;
const DETAIL_CAP = 100;

// PhoneBurner custom-field name for the per-list identifier and the job title.
const LEAD_SCORE_FIELD = "Lead Score";
const JOB_TITLE_FIELD = "Job Title";
const CF_TYPE_TEXT = 1;

/** A resolvable SDR (PhoneBurner member) assigned to a client. */
export interface SdrOption {
  pbMemberId: string;
  name: string;
  username: string | null;
  slug: string;
}

/** One inbound lead row (rich form). A bare phone string is also accepted. */
export interface UploadContactInput {
  phone?: string;
  first_name?: string;
  last_name?: string;
  name?: string;
  company?: string;
  email?: string;
  title?: string;
  notes?: string;
}

export interface UploadOptions {
  campaign?: string;
  /** Explicit Lead Score override. Omit to auto-mint the next one for the client. */
  leadScore?: string;
  attempt?: string;
  tags?: string[];
  dncScrub?: boolean; // default true
  onDuplicate?: "skip" | "update"; // default "update" (so existing contacts gain the new tag)
  dryRun?: boolean;
}

export interface UploadResult {
  dryRun: boolean;
  clientId: string;
  clientName: string;
  sdr: SdrOption;
  clientTag: string;
  leadScore: { value: string; prefix: string; seq: number; issued: boolean } | null;
  tags: string[];
  dnc: { scrubbed: boolean; entries_present: boolean; skipped: number };
  totals: {
    received: number;
    invalid: number;
    dnc_skipped: number;
    attempted: number;
    net_new: number | null;
    overlap: number | null;
    uploaded: number;
    failed: number;
  };
  dnc_skipped: Array<{ phone: string | null; email: string | null; matched_on: string; matched_value: string }>;
  invalid: Array<{ input: unknown; reason: string }>;
  failed: Array<{ phone: string | null; status: number; error: string }>;
}

/** Raised for a caller error that maps to a 4xx (unknown SDR, no token, etc.). */
export class UploadInputError extends Error {
  constructor(message: string, public status: number, public payload?: Record<string, unknown>) {
    super(message);
    this.name = "UploadInputError";
  }
}

// ── SDR resolution ───────────────────────────────────────────────────────────

function registryNameIndex(): Map<string, { name: string | null; username: string | null }> {
  const index = new Map<string, { name: string | null; username: string | null }>();
  try {
    const reg = loadRegistry();
    for (const c of reg.clients) {
      for (const m of c.phoneburner_members ?? []) {
        if (m.pb_member_id) index.set(String(m.pb_member_id), { name: m.name, username: m.username });
      }
    }
  } catch {
    // Registry file absent/unreadable → fall back to DB email-derived names.
  }
  return index;
}

export async function resolveClientSdrs(client: Client): Promise<SdrOption[]> {
  const members = await prisma.phoneburnerMember.findMany({
    where: { client_id: client.id, active: true },
    select: { pb_member_id: true, pb_username: true },
    orderBy: { pb_member_id: "asc" },
  });

  const nameIndex = registryNameIndex();
  const usedSlugs = new Set<string>();

  return members.map((m) => {
    const reg = nameIndex.get(m.pb_member_id);
    const username = reg?.username ?? m.pb_username ?? null;
    const name =
      reg?.name?.trim() || (username ? username.split("@")[0] : null) || `SDR ${m.pb_member_id}`;

    let slug = slugify(name) || `sdr-${m.pb_member_id}`;
    if (usedSlugs.has(slug)) slug = `${slug}-${m.pb_member_id.slice(-4)}`;
    usedSlugs.add(slug);

    return { pbMemberId: m.pb_member_id, name, username, slug };
  });
}

export function selectSdr(sdrs: SdrOption[], query?: string): SdrOption {
  if (sdrs.length === 0) {
    throw new UploadInputError("No active PhoneBurner SDRs are assigned to this client", 400);
  }
  const q = (query ?? "").trim();
  if (!q) {
    if (sdrs.length === 1) return sdrs[0];
    throw new UploadInputError("Multiple SDRs are assigned to this client — specify `sdr`", 409, {
      needs_sdr: true,
      sdrs,
    });
  }
  const ql = q.toLowerCase();
  const qslug = slugify(q);
  const match = sdrs.find(
    (s) =>
      s.pbMemberId === q ||
      s.slug === ql ||
      s.slug === qslug ||
      s.name.toLowerCase() === ql ||
      (s.username ?? "").toLowerCase() === ql
  );
  if (!match) throw new UploadInputError(`No assigned SDR matches "${q}"`, 400, { needs_sdr: true, sdrs });
  return match;
}

// ── Client tag ────────────────────────────────────────────────────────────────

/** PascalCase fallback client tag from the client name (used only until the
 *  backfill sets `pb_client_tag` from real call history). "Club Hub" → "ClubHub". */
export function deriveClientTag(name: string): string {
  const tag = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return tag || name.trim();
}

// ── PhoneBurner REST helpers (create-side) ─────────────────────────────────────

type TokenGetter = (force?: boolean) => Promise<string>;

async function pbUploadFetch(
  path: string,
  getToken: TokenGetter,
  init: RequestInit,
  throttle: () => Promise<void>
): Promise<Response> {
  const base = phoneburnerApiBase();
  return withRetry(
    (token) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          ...(init.headers || {}),
        },
      }),
    getToken,
    { throttle, maxRetries: MAX_RETRIES, maxTokenRefreshes: 2 }
  );
}

interface NormalizedContact {
  phoneE164: string;
  firstName: string;
  lastName: string;
  email: string | null;
  company: string | null;
  title: string | null;
  notes: string | null;
}

interface CreateContactResult {
  ok: boolean;
  status: number;
  id: string | null;
  error: string | null;
}

async function createPbContact(
  getToken: TokenGetter,
  ownerId: string,
  c: NormalizedContact,
  opts: { tags: string[]; leadScore: string | null; onDuplicate: "skip" | "update" },
  throttle: () => Promise<void>
): Promise<CreateContactResult> {
  // Custom fields MUST be the array shape; a dict silently persists nothing.
  const customFields: Array<{ name: string; type: number; value: string }> = [];
  if (c.title) customFields.push({ name: JOB_TITLE_FIELD, type: CF_TYPE_TEXT, value: c.title });
  // Lead Score is set ONLY for net-new contacts (caller passes null for merges)
  // so an overlapping contact keeps its prior list's Lead Score.
  if (opts.leadScore) customFields.push({ name: LEAD_SCORE_FIELD, type: CF_TYPE_TEXT, value: opts.leadScore });

  const body: Record<string, unknown> = {
    owner_id: ownerId,
    first_name: c.firstName,
    last_name: c.lastName,
    phone: c.phoneE164,
    phone_type: 1, // Home — mirrors the manual import's dial number
    on_duplicate: opts.onDuplicate,
    tags: opts.tags,
  };
  if (c.email) body.email = c.email;
  if (c.company) body.company = c.company;
  if (c.notes) body.notes = c.notes;
  if (customFields.length) body.custom_fields = customFields;

  const res = await pbUploadFetch(
    `/contacts`,
    getToken,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    throttle
  );

  if (res.ok || res.status === 201) {
    const json: any = await res.json().catch(() => ({}));
    const env = json?.contact ?? json?.contacts ?? json;
    const id = env?.contact_user_id ?? env?.user_id ?? env?.id ?? null;
    return { ok: true, status: res.status, id: id != null ? String(id) : null, error: null };
  }
  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, id: null, error: text.slice(0, 300) || `HTTP ${res.status}` };
}

// ── Normalization + net-new detection ─────────────────────────────────────────

function normalizeContact(raw: UploadContactInput | string): NormalizedContact | { error: string } {
  const row: UploadContactInput = typeof raw === "string" ? { phone: raw } : raw ?? {};

  const rawPhone = (row.phone ?? "").toString().trim();
  if (!rawPhone) return { error: "missing phone" };
  const parsed = normalizePhone(rawPhone);
  if (!parsed) return { error: `unparseable phone: ${rawPhone}` };

  let firstName = (row.first_name ?? "").toString().trim();
  let lastName = (row.last_name ?? "").toString().trim();
  if (!firstName && !lastName && row.name) {
    const parts = row.name.toString().trim().split(/\s+/);
    firstName = parts.shift() ?? "";
    lastName = parts.join(" ");
  }
  if (!firstName) firstName = "Lead";
  if (!lastName) lastName = `#${parsed.national.slice(-4)}`;

  const email = row.email ? normalizeEmail(row.email.toString()) : null;

  return {
    phoneE164: parsed.e164,
    firstName,
    lastName,
    email: email || null,
    company: row.company?.toString().trim() || null,
    title: row.title?.toString().trim() || null,
    notes: row.notes?.toString().trim() || null,
  };
}

/** Normalized email+phone keys already present in the seat's book, for net-new
 *  detection. Returns null if the book couldn't be read (token/API-access), in
 *  which case we can't distinguish net-new from overlap. */
async function snapshotBookKeys(
  memberId: string,
  getToken: TokenGetter,
  throttle: () => Promise<void>
): Promise<Set<string> | null> {
  try {
    const contacts = await fetchMemberContacts(memberId, getToken, undefined, { throttle });
    const keys = new Set<string>();
    for (const c of contacts) {
      for (const e of c.emails) {
        const n = normalizeEmail(e);
        if (n) keys.add(`e:${n}`);
      }
      for (const p of c.phones) {
        const n = normalizePhone(p)?.e164;
        if (n) keys.add(`p:${n}`);
      }
    }
    return keys;
  } catch (e) {
    if (e instanceof PhoneburnerAccessError) return null;
    throw e;
  }
}

function contactKeys(c: NormalizedContact): string[] {
  const keys = [`p:${c.phoneE164}`];
  if (c.email) keys.push(`e:${c.email}`);
  return keys;
}

// ── Orchestration ────────────────────────────────────────────────────────────

export async function uploadContacts(
  client: Client,
  sdr: SdrOption,
  contacts: Array<UploadContactInput | string>,
  options: UploadOptions
): Promise<UploadResult> {
  const dncScrub = options.dncScrub !== false; // default ON
  const onDuplicate = options.onDuplicate === "skip" ? "skip" : "update";
  const dryRun = options.dryRun === true;

  const clientTag = client.pb_client_tag?.trim() || deriveClientTag(client.name);
  const campaign = options.campaign?.toString().trim() || null;

  // Tags: bare client tag + "<ClientTag>: <Campaign>" + attempt + extras.
  const tags = Array.from(
    new Set(
      [
        clientTag,
        campaign ? `${clientTag}: ${campaign}` : null,
        options.attempt,
        ...(options.tags ?? []),
      ]
        .map((t) => (t ?? "").toString().trim())
        .filter(Boolean)
    )
  );

  // Normalize rows.
  const invalid: UploadResult["invalid"] = [];
  const normalized: NormalizedContact[] = [];
  for (const raw of contacts) {
    const n = normalizeContact(raw);
    if ("error" in n) invalid.push({ input: raw, reason: n.error });
    else normalized.push(n);
  }

  // DNC scrub.
  const dncEntriesPresent = (await prisma.dncEntry.count({ where: { client_id: client.id } })) > 0;
  const dncSkipped: UploadResult["dnc_skipped"] = [];
  let survivors = normalized;
  if (dncScrub && normalized.length > 0) {
    const kept: NormalizedContact[] = [];
    for (const c of normalized) {
      const ids = normalizeCheckIdentifiers({ email: c.email ?? undefined, phone: c.phoneE164 });
      const match = await dncService.findMatch(client.id, ids);
      if (match) {
        dncSkipped.push({ phone: c.phoneE164, email: c.email, matched_on: match.matchedOn, matched_value: match.matchedValue });
      } else {
        kept.push(c);
      }
    }
    survivors = kept;
  }

  const token0 = await getMemberToken(sdr.pbMemberId);
  if (!token0 && !dryRun) {
    throw new UploadInputError(
      `GTMOS has no PhoneBurner token for SDR ${sdr.name} (member ${sdr.pbMemberId}) — they may not have connected PhoneBurner`,
      400
    );
  }
  const throttle = createThrottle(UPLOAD_SPACING_MS);
  const getToken: TokenGetter = async (force) => (await getMemberToken(sdr.pbMemberId, { force })) ?? "";

  // Resolve the Lead Score: explicit override (recorded), else auto-mint. In a
  // dry run we only peek (record nothing).
  let leadScore: UploadResult["leadScore"] = null;
  if (options.leadScore && options.leadScore.trim()) {
    const value = options.leadScore.trim();
    const parsed = value.match(/^(.*?)(\d+)$/);
    if (!dryRun) await recordLeadScore(client, value, { campaign });
    leadScore = { value, prefix: parsed?.[1] ?? value, seq: parsed ? Number(parsed[2]) : 0, issued: false };
  } else {
    const minted: LeadScore = dryRun
      ? await peekNextLeadScore(client)
      : await issueLeadScore(client, { campaign });
    leadScore = { ...minted, issued: !dryRun };
  }

  // Snapshot the book for net-new detection (skip if no token available).
  const bookKeys = token0 ? await snapshotBookKeys(sdr.pbMemberId, getToken, throttle) : null;
  const isNetNew = (c: NormalizedContact): boolean =>
    bookKeys ? !contactKeys(c).some((k) => bookKeys.has(k)) : true;

  let netNew: number | null = bookKeys ? 0 : null;
  let overlap: number | null = bookKeys ? 0 : null;
  for (const c of survivors) {
    if (!bookKeys) break;
    if (isNetNew(c)) netNew!++;
    else overlap!++;
  }

  const failed: UploadResult["failed"] = [];
  let uploaded = 0;

  if (!dryRun && survivors.length > 0) {
    const results = await mapWithConcurrency(survivors, UPLOAD_CONCURRENCY, (c) =>
      createPbContact(
        getToken,
        sdr.pbMemberId,
        c,
        {
          tags,
          // Lead Score only on net-new (or when we couldn't read the book, in
          // which case we fall back to stamping all — matches prior behavior).
          leadScore: isNetNew(c) ? leadScore!.value : null,
          onDuplicate,
        },
        throttle
      ).then((r) => ({ c, r }))
    );
    for (const { c, r } of results) {
      if (r.ok) uploaded++;
      else failed.push({ phone: c.phoneE164, status: r.status, error: r.error ?? "unknown error" });
    }
  }

  return {
    dryRun,
    clientId: client.external_id,
    clientName: client.name,
    sdr,
    clientTag,
    leadScore,
    tags,
    dnc: { scrubbed: dncScrub, entries_present: dncEntriesPresent, skipped: dncSkipped.length },
    totals: {
      received: contacts.length,
      invalid: invalid.length,
      dnc_skipped: dncSkipped.length,
      attempted: survivors.length,
      net_new: netNew,
      overlap,
      uploaded,
      failed: failed.length,
    },
    dnc_skipped: dncSkipped.slice(0, DETAIL_CAP),
    invalid: invalid.slice(0, DETAIL_CAP),
    failed: failed.slice(0, DETAIL_CAP),
  };
}
