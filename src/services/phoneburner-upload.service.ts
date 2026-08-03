/**
 * Upload a list of leads into an SDR's PhoneBurner book (the programmatic
 * replacement for the manual "Clay → CSV import" flow).
 *
 * CONVENTION — corrected 2026-07-30 against the GTME team's own Loom walkthrough
 * of the manual process (see SKILL-phoneburner-list.md "The manual process"):
 *
 *  - the org does NOT use folders/categories. Three things live on a contact:
 *      * TAGS: `fresh leads` + the client tag (e.g. "Club Hub") + the BARE
 *        campaign name (e.g. "ISTE 2026 TAM"). All three are typed into the
 *        import's tag box at 4:17 in the Loom.
 *      * CUSTOM FIELD "Lead Score": the per-list identifier (e.g. "CLUB8").
 *      * CUSTOM FIELD "Job Title": the row's title.
 *  - ⚠️ `"<ClientTag>: <Campaign>"` is NOT a tag. It is the NAME of the SDR's
 *    saved search (e.g. "ClubHub: Public School Signal-Based Targeting - 1st
 *    Attempt"). An earlier reading of the process mis-transplanted that string
 *    into `tags[]`, which meant our uploads did not match the tag filters the
 *    SDRs' existing saved searches use. Fixed here.
 *  - ⚠️ `attempt` is NOT a tag either. In the Loom (0:14–0:41) the attempt is a
 *    DIAL-COUNT criterion inside the saved search — 0 dials = 1st attempt, 1 =
 *    2nd, and so on — plus a suffix on the saved search's name. We keep the
 *    `attempt` option, but it now feeds the `savedSearch` hint block instead of
 *    polluting the contact's tags.
 *  - leads are created under the assigned SDR's own token (`owner_id` = their
 *    PhoneBurner member id);
 *  - PhoneBurner de-dupes on email/phone and MERGES on overlap. Setting Lead Score
 *    on a merged contact would OVERWRITE its prior list's — so we snapshot the
 *    seat's book first and stamp Lead Score on NET-NEW contacts only (existing
 *    contacts still get the new tags, just not a new Lead Score);
 *  - numbers on the client's DNC are scrubbed BEFORE upload (PHONEBURNER_DNC_PURGE_PLAN.md
 *    §9); the response reports coverage + every collision so "clean" and
 *    "unchecked" are never confused.
 *
 * SAVED SEARCH — there is no saved-search/smart-folder API, so that one step stays
 * in the UI. But it only had to be redone per list because the SDR filtered on the
 * per-list Lead Score. `tag = <client>` + `dials = 0` already isolates exactly
 * "this client's never-dialed leads", so a STANDING saved search built once per
 * client absorbs every later upload automatically. `savedSearch` in the response
 * spells out both variants.
 *
 * FOLDERS — this is what makes the flow end-to-end (added 2026-07-31, see
 * PB-list-manager/FINDINGS.md). A Contact Folder IS a first-class dial source:
 * PhoneBurner's own flow is Contacts -> a folder OR a saved search -> tick -> Begin
 * Dial Session. A folder just isn't a *dynamic* filter, which is the only reason the
 * team reached for a saved search. So we create a folder per list
 * (`resolveOrCreateFolder`) and file the contacts into it via `category_id` — the SDR
 * picks the folder and dials, with nothing to build. `savedSearch.needed` reports
 * whether any UI work remains.
 *
 * ⚠️ A contact has exactly ONE `category_id`. Filing an OVERLAPPING contact would
 * move it out of the folder it currently sits in — possibly one the SDR is mid-way
 * through dialing. So `folderAssign` defaults to `net_new`, the same safety rule
 * Lead Score uses. `all` overrides it; `none` restores the pre-2026-07-31 behaviour.
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
import { phoneburnerApiBase, flattenPbCollection } from "./phoneburner-token.service";
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

/** Tag every freshly-imported lead carries (Loom 4:17). The SDRs' saved searches
 *  filter on it, so omitting it hides the upload from their dial queue. */
const FRESH_LEADS_TAG = "fresh leads";

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
  /** Which dial pass this list is for ("first attempt" / "2nd" / 3 …). Drives the
   *  `savedSearch` hint (name suffix + dial-count criterion) — NOT a contact tag. */
  attempt?: string | number;
  tags?: string[];
  /** Include the standard `fresh leads` tag. Default true — only turn this off for
   *  a re-tag of leads that are already in the book. */
  freshLeadsTag?: boolean;
  /** Override the dial folder's name. Default = the org's per-list convention,
   *  `"<PascalClient>: <Campaign> - <Nth> Attempt"`. */
  folder?: string;
  /**
   * Which contacts get assigned to the dial folder.
   *  - `net_new` (default): net-new contacts only. A contact has exactly ONE
   *    `category_id`, so assigning an overlapping contact would MOVE it out of the
   *    folder it currently sits in — possibly one the SDR is mid-way through
   *    dialing. Same safety rule as Lead Score.
   *  - `all`: assign every uploaded contact, moving overlaps into this folder.
   *  - `none`: don't touch folders at all (pre-2026-07-31 behaviour).
   */
  folderAssign?: "net_new" | "all" | "none";
  dncScrub?: boolean; // default true
  onDuplicate?: "skip" | "update"; // default "update" (so existing contacts gain the new tag)
  dryRun?: boolean;
}

/** The dial folder this upload targets. A folder is a first-class dial source in
 *  PhoneBurner (Contacts → folder → Begin Dial Session), so when we create one the
 *  SDR has nothing to build in the UI. */
export interface FolderResult {
  id: string | null; // null in a dry run when the folder doesn't exist yet
  name: string;
  created: boolean;
  /** True in a dry run when the folder is absent and WOULD be created on apply. */
  would_create: boolean;
  /** How many uploaded contacts were filed into it. */
  assigned: number;
  /** Overlapping contacts deliberately left in their existing folder
   *  (`folderAssign:"net_new"`). Non-zero means the folder is not the full list. */
  left_in_place: number;
}

/** What the SDR still needs in the PhoneBurner UI. No API exists for saved searches,
 *  but a folder is an equally valid dial source — so when this upload filed every
 *  contact into a folder, `needed` is false and there is nothing to build. */
export interface SavedSearchPlan {
  /** Always false: PhoneBurner exposes no saved-search/smart-folder endpoint. */
  api_available: false;
  /** Whether the SDR has to build anything at all. False = dial the folder. */
  needed: boolean;
  /** Plain-English why, safe to show the user verbatim. */
  reason: string;
  /** Build once per client; absorbs all future uploads. */
  standing: { name: string; criteria: string[]; build_once: true };
  /** The legacy per-list search — only needed to dial ONE list while another
   *  un-dialed list is still pending for the same client. */
  per_list: { name: string; criteria: string[] };
}

export interface UploadResult {
  dryRun: boolean;
  clientId: string;
  clientName: string;
  sdr: SdrOption;
  clientTag: string;
  leadScore: { value: string; prefix: string; seq: number; issued: boolean } | null;
  tags: string[];
  folder: FolderResult | null; // null only when folderAssign:"none"
  savedSearch: SavedSearchPlan;
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

/** PascalCase form of the client name. Two uses: the fallback contact tag when
 *  `pb_client_tag` hasn't been backfilled yet, and the prefix of the saved
 *  search's NAME (which the org writes closed-up: "ClubHub: …"). */
export function deriveClientTag(name: string): string {
  const tag = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return tag || name.trim();
}

// ── Saved-search plan (the one manual step) ───────────────────────────────────

const ATTEMPT_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
};

/** Does the SDR still have to build something in the UI? A folder is a valid dial
 *  source, so a folder holding the whole list means "no". */
export function savedSearchNeed(folder: FolderResult | null): { needed: boolean; reason: string } {
  if (!folder) {
    return {
      needed: true,
      reason: "No dial folder was created (folderAssign:\"none\") — the SDR must select the contacts themselves.",
    };
  }
  if (folder.left_in_place > 0) {
    return {
      needed: true,
      reason:
        `Folder "${folder.name}" holds the ${folder.assigned} net-new contacts, but ` +
        `${folder.left_in_place} overlapping contact(s) stayed in their existing folder. ` +
        `Dial the folder for the new leads, or build the search / re-run with folderAssign:"all" ` +
        `to pull the overlaps in too.`,
    };
  }
  if (folder.assigned === 0) {
    return {
      needed: false,
      reason: `Nothing was uploaded, so there is nothing to dial. Folder "${folder.name}" is ready for the next run.`,
    };
  }
  return {
    needed: false,
    reason: `Nothing to build — all ${folder.assigned} contacts are in folder "${folder.name}". The SDR opens Contacts, picks that folder, and hits Begin Dial Session.`,
  };
}

/** "first attempt" | "2nd" | 3 → the 1-based dial pass. Defaults to 1. */
export function parseAttempt(attempt?: string | number): number {
  if (typeof attempt === "number" && Number.isFinite(attempt)) return Math.max(1, Math.trunc(attempt));
  const s = (attempt ?? "").toString().trim().toLowerCase();
  if (!s) return 1;
  const digits = s.match(/\d+/);
  if (digits) return Math.max(1, Number(digits[0]));
  for (const [word, n] of Object.entries(ATTEMPT_WORDS)) if (s.includes(word)) return n;
  return 1;
}

/** 1 → "1st Attempt", 2 → "2nd Attempt" … matching the org's folder names. */
export function attemptLabel(ordinal: number): string {
  const rem100 = ordinal % 100;
  const suffix =
    rem100 >= 11 && rem100 <= 13 ? "th" : ["th", "st", "nd", "rd"][ordinal % 10] ?? "th";
  return `${ordinal}${suffix} Attempt`;
}

/**
 * The saved search the SDR builds in the UI. Criteria come straight from the
 * Loom: tag + dial count + (per-list only) Lead Score.
 *
 * The dial-count criterion is why `standing` works: a list that has already been
 * worked has dials >= 1 and falls out of the 1st-attempt folder by itself, so the
 * per-list Lead Score filter is redundant for the normal "dial the new leads" path.
 */
export function planSavedSearch(args: {
  clientName: string;
  clientTag: string;
  campaign: string | null;
  leadScore: string | null;
  attemptOrdinal: number;
  /** The folder this upload filed contacts into, if any. */
  folder?: FolderResult | null;
}): SavedSearchPlan {
  const pascal = deriveClientTag(args.clientName);
  const label = attemptLabel(args.attemptOrdinal);
  const dials = args.attemptOrdinal - 1;
  const dialCriterion = `dial attempts = ${dials}`;

  const { needed, reason } = savedSearchNeed(args.folder ?? null);

  return {
    api_available: false,
    needed,
    reason,
    standing: {
      name: `${pascal}: ${label}`,
      criteria: [`tag = ${args.clientTag}`, dialCriterion],
      build_once: true,
    },
    per_list: {
      name: `${pascal}: ${args.campaign ?? "(campaign)"} - ${label}`,
      criteria: [
        `tag = ${args.clientTag}`,
        `${LEAD_SCORE_FIELD} = ${args.leadScore ?? "(lead score)"}`,
        dialCriterion,
      ],
    },
  };
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

// ── Folders (the dial target) ─────────────────────────────────────────────────

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

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Look a folder up by name (case-insensitive). Read-only — safe in a dry run.
 *  Returns null if the listing failed, so callers can't mistake "couldn't check"
 *  for "absent". */
/** PhoneBurner documents `page_size` as 1–100. An earlier version asked for 300 and
 *  read only the first response, which would silently MISS an existing folder in an
 *  account with more than a page of them — and then create a duplicate. */
const FOLDER_PAGE_SIZE = 100;
/** Runaway guard: 100 pages × 100 = 10k folders, far beyond any real account. */
const FOLDER_MAX_PAGES = 100;

/** Read `total_pages` out of whatever envelope PB wrapped the collection in. */
function totalPagesOf(env: any): number | null {
  for (const node of [env, env?.folders, env?.data]) {
    const n = Number(node?.total_pages);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Three-state result. "absent" and "unknown" MUST stay distinguishable: creating a
 * folder because we merely failed to read the list would duplicate one that already
 * exists, splitting a client's leads across two identically-named folders — and the
 * SDR would dial whichever they happened to open.
 */
export type FolderLookup =
  | { status: "found"; folder: PbFolder }
  | { status: "absent" }
  | { status: "unknown"; detail: string };

/**
 * Look a folder up by name (case-insensitive), paging until found or exhausted.
 * Read-only — safe in a dry run.
 *
 * ⚠️ Must page. PhoneBurner documents `page_size` as 1–100, so a single request
 * cannot be assumed to hold every folder.
 */
export async function findFolderByName(
  getToken: TokenGetter,
  name: string,
  throttle: () => Promise<void>
): Promise<FolderLookup> {
  let page = 1;
  let lastPage: number | null = null;

  while (page <= (lastPage ?? FOLDER_MAX_PAGES) && page <= FOLDER_MAX_PAGES) {
    const res = await pbUploadFetch(
      `/folders?page=${page}&page_size=${FOLDER_PAGE_SIZE}`,
      getToken,
      { method: "GET" },
      throttle
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { status: "unknown", detail: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }

    const json: any = await res.json().catch(() => ({}));
    const env = json?.folders ?? json;
    const folders = flattenPbCollection(env?.folders ?? env?.data ?? env, isFolderLeaf)
      .map(folderOf)
      .filter((f): f is PbFolder => !!f);

    const hit = folders.find((f) => sameName(f.name, name));
    if (hit) return { status: "found", folder: hit };

    lastPage ??= totalPagesOf(env);
    // No pagination metadata and a short page → that was everything.
    if (lastPage === null && folders.length < FOLDER_PAGE_SIZE) return { status: "absent" };
    if (folders.length === 0) return { status: "absent" };
    page++;
  }
  // Walked every page we were told about without a hit.
  return lastPage !== null ? { status: "absent" } : { status: "unknown", detail: `exceeded ${FOLDER_MAX_PAGES} pages` };
}

/**
 * Find a folder by name, creating it if absent. A contact's `category_id` IS a
 * folder id from here, and a folder is a first-class dial source — so this is what
 * removes the manual "build the saved search" step.
 */
export async function resolveOrCreateFolder(
  getToken: TokenGetter,
  name: string,
  throttle: () => Promise<void>
): Promise<{ id: string; name: string; created: boolean }> {
  const lookup = await findFolderByName(getToken, name, throttle);
  if (lookup.status === "found") return { ...lookup.folder, created: false };
  // Never create on "unknown" — that's how you end up with two folders of the
  // same name and a client's leads split between them.
  if (lookup.status === "unknown") {
    throw new UploadInputError(
      `Could not read PhoneBurner's folder list, so "${name}" was not created (creating blindly risks a duplicate): ${lookup.detail}`,
      502
    );
  }

  const res = await pbUploadFetch(
    `/folders`,
    getToken,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) },
    throttle
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UploadInputError(
      `PhoneBurner POST /folders failed for "${name}": HTTP ${res.status} ${body.slice(0, 200)}`,
      502
    );
  }
  const json: any = await res.json().catch(() => ({}));
  const [leaf] = flattenPbCollection(json?.folder ?? json?.folders ?? json, isFolderLeaf);
  const folder = folderOf(leaf);
  if (folder) return { ...folder, created: true };

  // Created but the id wasn't in the response body — re-read rather than fail, so a
  // shape change in PB's create response can't strand the upload.
  const reread = await findFolderByName(getToken, name, throttle);
  if (reread.status === "found") return { ...reread.folder, created: true };
  throw new UploadInputError(`PhoneBurner created folder "${name}" but returned no id`, 502);
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
  opts: { tags: string[]; leadScore: string | null; categoryId: string | null; onDuplicate: "skip" | "update" },
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
  // A contact lives in exactly ONE folder, so the caller decides who gets filed
  // (net-new only by default) — see UploadOptions.folderAssign.
  if (opts.categoryId) body.category_id = opts.categoryId;
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

  // Tags, exactly as the manual import types them (Loom 4:17): `fresh leads`,
  // the client tag, the BARE campaign name, then any caller extras.
  // NOT tags: "<ClientTag>: <Campaign>" (that's the saved search's name) and
  // `attempt` (that's a dial-count criterion inside the saved search).
  const tags = Array.from(
    new Set(
      [
        options.freshLeadsTag === false ? null : FRESH_LEADS_TAG,
        clientTag,
        campaign,
        ...(options.tags ?? []),
      ]
        .map((t) => (t ?? "").toString().trim())
        .filter(Boolean)
    )
  );

  const attemptOrdinal = parseAttempt(options.attempt);

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

  // ── Dial folder ────────────────────────────────────────────────────────────
  // A folder is a first-class dial source, so filing the list into one removes the
  // manual "build the saved search" step. Resolved AFTER the book snapshot (we need
  // net-new status to decide who gets filed) and BEFORE the create loop.
  const folderAssign = options.folderAssign ?? "net_new";
  const folderName =
    options.folder?.toString().trim() ||
    planSavedSearch({ clientName: client.name, clientTag, campaign, leadScore: leadScore.value, attemptOrdinal })
      .per_list.name;

  /** A contact lives in exactly one folder — only file the ones the caller allows. */
  const shouldFile = (c: NormalizedContact): boolean =>
    folderAssign === "all" || (folderAssign === "net_new" && isNetNew(c));

  let folder: FolderResult | null = null;
  if (folderAssign !== "none") {
    const plannedAssigned = survivors.filter(shouldFile).length;
    const plannedLeft = survivors.length - plannedAssigned;

    if (!token0) {
      // Can't reach PhoneBurner at all — report the intent, don't guess existence.
      folder = { id: null, name: folderName, created: false, would_create: false, assigned: 0, left_in_place: plannedLeft };
    } else if (dryRun) {
      const lookup = await findFolderByName(getToken, folderName, throttle);
      // On "unknown" a dry run still reports rather than throwing — it writes
      // nothing, so the honest answer is "couldn't check", not a guess either way.
      folder = {
        id: lookup.status === "found" ? lookup.folder.id : null,
        name: lookup.status === "found" ? lookup.folder.name : folderName,
        created: false,
        would_create: lookup.status === "absent",
        assigned: plannedAssigned,
        left_in_place: plannedLeft,
      };
    } else {
      const resolved = await resolveOrCreateFolder(getToken, folderName, throttle);
      folder = {
        id: resolved.id,
        name: resolved.name,
        created: resolved.created,
        would_create: false,
        assigned: 0, // filled in from the create loop below
        left_in_place: plannedLeft,
      };
    }
  }

  const failed: UploadResult["failed"] = [];
  let uploaded = 0;

  if (!dryRun && survivors.length > 0) {
    const results = await mapWithConcurrency(survivors, UPLOAD_CONCURRENCY, (c) => {
      const categoryId = folder?.id && shouldFile(c) ? folder.id : null;
      return createPbContact(
        getToken,
        sdr.pbMemberId,
        c,
        {
          tags,
          // Lead Score only on net-new (or when we couldn't read the book, in
          // which case we fall back to stamping all — matches prior behavior).
          leadScore: isNetNew(c) ? leadScore!.value : null,
          categoryId,
          onDuplicate,
        },
        throttle
      ).then((r) => ({ c, r, filed: categoryId !== null }));
    });
    for (const { c, r, filed } of results) {
      if (r.ok) {
        uploaded++;
        if (filed && folder) folder.assigned++;
      } else {
        failed.push({ phone: c.phoneE164, status: r.status, error: r.error ?? "unknown error" });
      }
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
    folder,
    savedSearch: planSavedSearch({
      clientName: client.name,
      clientTag,
      campaign,
      leadScore: leadScore?.value ?? null,
      attemptOrdinal,
      folder,
    }),
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
