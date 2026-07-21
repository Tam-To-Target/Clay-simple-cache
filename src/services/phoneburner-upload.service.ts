/**
 * Upload a list of leads into an SDR's PhoneBurner book (the programmatic
 * replacement for the manual "create saved-search folder → Clay → CSV import"
 * flow).
 *
 * The end result mirrors the manual process:
 *  - the leads land in the assigned SDR's own book (created with that SDR's
 *    personal access token, `owner_id` = their PhoneBurner member id);
 *  - each lead is stamped with the client tag + campaign name (searchable tags)
 *    and dropped into a folder named after the lead-group identifier
 *    (e.g. "club8"), which is what the SDR builds their saved search on;
 *  - numbers already on the client's Do-Not-Contact list are scrubbed BEFORE
 *    they ever enter PhoneBurner (see PHONEBURNER_DNC_PURGE_PLAN.md §9) so the
 *    import doesn't feed the very numbers the daily purge then deletes.
 *
 * Identity comes from the same sources the purge uses: the client → PhoneBurner
 * member mapping is the local `phoneburner_members` table (bootstrapped from
 * data/clients.json), and each member's dialing token is resolved from GTMOS via
 * phoneburner-token.service. Display names/slugs for SDR selection are enriched
 * from the committed registry (the DB row only stores the member id + email).
 */

import prisma from "../db/prisma";
import type { Client } from "@prisma/client";
import { normalizeEmail, normalizePhone } from "./normalization";
import { normalizeCheckIdentifiers, dncService } from "./dnc.service";
import { getMemberToken, phoneburnerApiBase, flattenPbCollection } from "./phoneburner-token.service";
import { withRetry, createThrottle, mapWithConcurrency } from "./http-retry";
import { loadRegistry, slugify } from "../config/registry";

const USER_AGENT = process.env.PHONEBURNER_USER_AGENT || "TAM-DNC-Cache/1.0";
const MAX_RETRIES = 5;
// PhoneBurner rate-limits per member account; a single upload run targets one
// member, so a per-run spacer + small concurrency keeps us comfortably under it.
const UPLOAD_CONCURRENCY = 4;
const UPLOAD_SPACING_MS = 150;
// Cap how many per-row detail entries we echo back so a 10k-row upload doesn't
// return a 10k-element error array. Counts are always exact.
const DETAIL_CAP = 100;

/** A resolvable SDR (PhoneBurner member) assigned to a client. */
export interface SdrOption {
  pbMemberId: string;
  name: string;
  username: string | null;
  /** Stable, URL-safe id derived from the name (unique within the client). */
  slug: string;
}

/** One inbound lead row (rich form). A bare phone string is also accepted. */
export interface UploadContactInput {
  phone?: string;
  first_name?: string;
  last_name?: string;
  /** Full name, split into first/last when first_name/last_name are absent. */
  name?: string;
  company?: string;
  email?: string;
  title?: string;
  notes?: string;
}

export interface UploadOptions {
  /** Client tag + campaign go into PhoneBurner tags[]. */
  campaign?: string;
  /** Lead-group identifier (e.g. "club8") → the PhoneBurner folder name. */
  leadGroup?: string;
  /** Optional extra searchable tags (e.g. "first attempt"). */
  attempt?: string;
  tags?: string[];
  /** Scrub against the client's DNC before uploading. Default true. */
  dncScrub?: boolean;
  /** PhoneBurner duplicate handling. Default "update". */
  onDuplicate?: "skip" | "update";
  /** Validate + scrub + resolve, but create nothing. Default false. */
  dryRun?: boolean;
}

export interface UploadResult {
  dryRun: boolean;
  clientId: string;
  clientName: string;
  sdr: SdrOption;
  folder: { id: string; name: string; created: boolean } | null;
  tags: string[];
  totals: {
    received: number;
    invalid: number;
    dnc_skipped: number;
    attempted: number;
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

/** pb_member_id → display name/username, from the committed registry. */
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

/**
 * The active PhoneBurner members assigned to a client, each with a stable slug
 * (unique within the client). Names come from the registry; the DB only holds
 * the member id + email.
 */
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
      reg?.name?.trim() ||
      (username ? username.split("@")[0] : null) ||
      `SDR ${m.pb_member_id}`;

    let slug = slugify(name) || `sdr-${m.pb_member_id}`;
    // Disambiguate collisions within the client (e.g. two "Sara Johnson"s).
    if (usedSlugs.has(slug)) slug = `${slug}-${m.pb_member_id.slice(-4)}`;
    usedSlugs.add(slug);

    return { pbMemberId: m.pb_member_id, name, username, slug };
  });
}

/**
 * Pick the SDR to upload to. With one assigned SDR, `query` is optional. With
 * more than one, `query` must match a slug / name / email / member id — else an
 * UploadInputError(400) carrying the full option list is thrown so the caller
 * can prompt for a choice.
 */
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
  if (!match) {
    throw new UploadInputError(`No assigned SDR matches "${q}"`, 400, { needs_sdr: true, sdrs });
  }
  return match;
}

// ── PhoneBurner REST helpers (create-side; reads/deletes live in phoneburner.service) ─

type TokenGetter = (force?: boolean) => Promise<string>;

function makeThrottle(): () => Promise<void> {
  return createThrottle(UPLOAD_SPACING_MS);
}

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

interface PbFolder {
  id: string;
  name: string;
}

/** A PhoneBurner folder leaf: has a folder_id (or duplicated `id`) + folder_name. */
function isFolderLeaf(o: any): boolean {
  return !!o && typeof o === "object" && (o.folder_id !== undefined || o.folder_name !== undefined);
}
function folderOf(o: any): PbFolder | null {
  const id = o?.folder_id ?? o?.id;
  const name = o?.folder_name ?? o?.name;
  if (id === undefined || name === undefined) return null;
  return { id: String(id), name: String(name) };
}

/**
 * Find a folder by name (case-insensitive) in the member's book, creating it if
 * absent. `category_id` on a contact == a `folder_id` from here.
 */
export async function resolveOrCreateFolder(
  getToken: TokenGetter,
  name: string,
  throttle: () => Promise<void>
): Promise<{ id: string; name: string; created: boolean }> {
  const listed = await pbUploadFetch(`/folders?page_size=300`, getToken, { method: "GET" }, throttle);
  if (listed.ok) {
    const json: any = await listed.json().catch(() => ({}));
    const env = json?.folders ?? json;
    const folders = flattenPbCollection(env?.folders ?? env?.data ?? env, isFolderLeaf)
      .map(folderOf)
      .filter((f): f is PbFolder => !!f);
    const hit = folders.find((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (hit) return { ...hit, created: false };
  }

  const created = await pbUploadFetch(
    `/folders`,
    getToken,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) },
    throttle
  );
  if (!created.ok) {
    const body = await created.text().catch(() => "");
    throw new Error(`PhoneBurner POST /folders failed: HTTP ${created.status} ${body.slice(0, 300)}`);
  }
  const json: any = await created.json().catch(() => ({}));
  const [leaf] = flattenPbCollection(json?.folder ?? json?.folders ?? json, isFolderLeaf);
  const folder = folderOf(leaf);
  if (!folder) throw new Error(`PhoneBurner POST /folders returned no folder id (name "${name}")`);
  return { ...folder, created: true };
}

/** A single normalized lead ready to POST. */
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
  opts: { tags: string[]; categoryId: string | null; onDuplicate: "skip" | "update" },
  throttle: () => Promise<void>
): Promise<CreateContactResult> {
  const body: Record<string, unknown> = {
    owner_id: ownerId,
    first_name: c.firstName,
    last_name: c.lastName,
    phone: c.phoneE164,
    phone_type: 1, // Home — mirrors the manual import's "home" dial number
    on_duplicate: opts.onDuplicate,
    tags: opts.tags,
  };
  if (c.email) body.email = c.email;
  if (c.company) body.company = c.company;
  if (c.notes) body.notes = c.notes;
  if (opts.categoryId) body.category_id = opts.categoryId;
  // Job title has no dedicated create field — carry it as a text custom field.
  if (c.title) body.custom_fields = [{ name: "Title", type: 1, value: c.title }];

  const res = await pbUploadFetch(
    `/contacts`,
    getToken,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    throttle
  );

  if (res.ok || res.status === 201) {
    const json: any = await res.json().catch(() => ({}));
    const env = json?.contact ?? json?.contacts ?? json;
    const id =
      env?.contact_user_id ?? env?.user_id ?? env?.id ?? null;
    return { ok: true, status: res.status, id: id != null ? String(id) : null, error: null };
  }

  const text = await res.text().catch(() => "");
  return { ok: false, status: res.status, id: null, error: text.slice(0, 300) || `HTTP ${res.status}` };
}

// ── Normalization ──────────────────────────────────────────────────────────

/** Coerce a raw row (string or object) into a normalized contact, or an error. */
function normalizeContact(raw: UploadContactInput | string): NormalizedContact | { error: string } {
  const row: UploadContactInput = typeof raw === "string" ? { phone: raw } : raw ?? {};

  const rawPhone = (row.phone ?? "").toString().trim();
  if (!rawPhone) return { error: "missing phone" };
  const parsed = normalizePhone(rawPhone);
  if (!parsed) return { error: `unparseable phone: ${rawPhone}` };

  // Derive first/last from a combined `name` when explicit fields are absent.
  let firstName = (row.first_name ?? "").toString().trim();
  let lastName = (row.last_name ?? "").toString().trim();
  if (!firstName && !lastName && row.name) {
    const parts = row.name.toString().trim().split(/\s+/);
    firstName = parts.shift() ?? "";
    lastName = parts.join(" ");
  }
  // PhoneBurner wants a name on the record — fall back so a phone-only row still
  // imports (identifiable by the last 4 digits) instead of 400-ing.
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

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Upload `contacts` into `sdr`'s PhoneBurner book for `client`. Assumes the SDR
 * has already been resolved/selected. Scrubs DNC (unless disabled), resolves the
 * folder, then creates the surviving contacts with bounded concurrency.
 */
export async function uploadContacts(
  client: Client,
  sdr: SdrOption,
  contacts: Array<UploadContactInput | string>,
  options: UploadOptions
): Promise<UploadResult> {
  const dncScrub = options.dncScrub !== false; // default ON
  const onDuplicate = options.onDuplicate === "skip" ? "skip" : "update";
  const dryRun = options.dryRun === true;

  // Tags: client tag + campaign + attempt + any extras (client + campaign was
  // the chosen split; the lead-group id becomes the folder below).
  const tags = Array.from(
    new Set(
      [client.name, options.campaign, options.attempt, ...(options.tags ?? [])]
        .map((t) => (t ?? "").toString().trim())
        .filter(Boolean)
    )
  );

  const invalid: UploadResult["invalid"] = [];
  const normalized: NormalizedContact[] = [];
  for (const raw of contacts) {
    const n = normalizeContact(raw);
    if ("error" in n) invalid.push({ input: raw, reason: n.error });
    else normalized.push(n);
  }

  // DNC scrub — drop anything already suppressed for this client.
  const dncSkipped: UploadResult["dnc_skipped"] = [];
  let survivors = normalized;
  if (dncScrub && normalized.length > 0) {
    const kept: NormalizedContact[] = [];
    for (const c of normalized) {
      const ids = normalizeCheckIdentifiers({
        email: c.email ?? undefined,
        phone: c.phoneE164,
      });
      const match = await dncService.findMatch(client.id, ids);
      if (match) {
        dncSkipped.push({
          phone: c.phoneE164,
          email: c.email,
          matched_on: match.matchedOn,
          matched_value: match.matchedValue,
        });
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
  const throttle = makeThrottle();
  const getToken: TokenGetter = async (force) =>
    (await getMemberToken(sdr.pbMemberId, { force })) ?? "";

  // Resolve the folder (lead-group identifier) unless dry-running.
  let folder: UploadResult["folder"] = null;
  if (options.leadGroup && options.leadGroup.trim()) {
    if (dryRun) {
      folder = { id: "", name: options.leadGroup.trim(), created: false };
    } else {
      folder = await resolveOrCreateFolder(getToken, options.leadGroup.trim(), throttle);
    }
  }

  const failed: UploadResult["failed"] = [];
  let uploaded = 0;

  if (!dryRun && survivors.length > 0) {
    const results = await mapWithConcurrency(survivors, UPLOAD_CONCURRENCY, (c) =>
      createPbContact(
        getToken,
        sdr.pbMemberId,
        c,
        { tags, categoryId: folder?.id || null, onDuplicate },
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
    folder,
    tags,
    totals: {
      received: contacts.length,
      invalid: invalid.length,
      dnc_skipped: dncSkipped.length,
      attempted: survivors.length,
      uploaded,
      failed: failed.length,
    },
    dnc_skipped: dncSkipped.slice(0, DETAIL_CAP),
    invalid: invalid.slice(0, DETAIL_CAP),
    failed: failed.slice(0, DETAIL_CAP),
  };
}
