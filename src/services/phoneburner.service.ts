/**
 * Thin PhoneBurner REST client (https://www.phoneburner.com/rest/1).
 *
 * Constraints verified live (see PHONEBURNER_DNC_PURGE_PLAN.md §3):
 *  - A non-empty User-Agent is REQUIRED (else 403).
 *  - Contacts are paged via GET /contacts?page_size=300&page=N. There is NO
 *    incremental fetch — every run must full-scan each member's book.
 *  - Delete via DELETE /contacts/{id}; success is HTTP 200/202/204.
 *  - A member whose account lacks "API Access" 403s on every endpoint.
 */

import { createThrottle, withRetry } from "./http-retry";
import { phoneburnerApiBase, flattenPbCollection } from "./phoneburner-token.service";

const USER_AGENT = process.env.PHONEBURNER_USER_AGENT || "TAM-DNC-Cache/1.0";
const CONTACTS_PAGE_SIZE = 300;
const MAX_RETRIES = 5;
// Safety bound on a single member's book scan (300k contacts) — guards against a
// pathological/looping pagination response.
const MAX_CONTACT_PAGES = 1000;
const throttle = createThrottle(150); // ~6-7 req/s per process, well under PB limits

/** Raised when a member's PhoneBurner account does not have API Access enabled. */
export class PhoneburnerAccessError extends Error {
  constructor(public memberId: string, message: string) {
    super(message);
    this.name = "PhoneburnerAccessError";
  }
}

export interface PbContact {
  /** PhoneBurner contact id (the record's `user_id`). */
  id: string;
  emails: string[];
  phones: string[]; // raw, un-normalized
  category: string | null;
  do_not_call: unknown;
  /** Full original record, stored verbatim in the deletion audit snapshot. */
  raw: Record<string, unknown>;
}

/**
 * A token-authenticated PhoneBurner fetch with throttle + retry. `getToken`
 * resolves/refreshes the member token (force=true bypasses cache on a 401).
 */
async function pbFetch(
  path: string,
  getToken: (force?: boolean) => Promise<string>,
  init?: RequestInit
): Promise<Response> {
  const base = phoneburnerApiBase();
  return withRetry(
    (token) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": USER_AGENT,
          ...(init?.headers || {}),
        },
      }),
    getToken,
    { throttle, maxRetries: MAX_RETRIES, maxTokenRefreshes: 2 }
  );
}

/** Normalize one PhoneBurner contact record into the fields we collide on. */
export function normalizePbContact(rec: any): PbContact {
  const emails = new Set<string>();
  if (rec?.primary_email) emails.add(String(rec.primary_email));
  for (const e of rec?.emails ?? []) {
    const v = typeof e === "string" ? e : e?.email_address ?? e?.email;
    if (v) emails.add(String(v));
  }

  const phones = new Set<string>();
  if (rec?.primary_phone) phones.add(String(rec.primary_phone));
  for (const p of rec?.phones ?? []) {
    const v = typeof p === "string" ? p : p?.raw_phone ?? p?.phone_number ?? p?.phone;
    if (v) phones.add(String(v));
  }

  return {
    id: String(rec?.user_id ?? rec?.id ?? ""),
    emails: [...emails],
    phones: [...phones],
    category: rec?.category ?? null,
    do_not_call: rec?.do_not_call,
    raw: rec ?? {},
  };
}

/**
 * Full snapshot of a member's PhoneBurner book (all pages). Throws
 * PhoneburnerAccessError if the member's API Access is off (403).
 */
export async function fetchMemberContacts(
  memberId: string,
  getToken: (force?: boolean) => Promise<string>,
  onProgress?: (fetched: number) => void
): Promise<PbContact[]> {
  const out: PbContact[] = [];
  let page = 1;
  let totalPages: number | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await pbFetch(`/contacts?page_size=${CONTACTS_PAGE_SIZE}&page=${page}`, getToken);

    if (res.status === 403) {
      // The admin-resolved token is valid, so a 403 means this member's account
      // doesn't have API Access enabled — skip the member, never a hard error.
      throw new PhoneburnerAccessError(memberId, `PhoneBurner API access disabled for member ${memberId}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PhoneBurner /contacts failed (member ${memberId}): HTTP ${res.status} ${body.slice(0, 300)}`);
    }

    const json: any = await res.json();
    const env = json?.contacts ?? json;
    // PhoneBurner nests collections as an array of index-keyed maps (see
    // flattenPbCollection) — a contact leaf has user_id / a primary_email / phones.
    const list = flattenPbCollection(
      env?.contacts ?? env?.data ?? env,
      (o) =>
        o.user_id !== undefined ||
        o.primary_email !== undefined ||
        o.emails !== undefined ||
        o.primary_phone !== undefined ||
        o.phones !== undefined
    );
    for (const rec of list) {
      const c = normalizePbContact(rec);
      if (c.id) out.push(c);
    }
    if (onProgress) onProgress(out.length);

    const tp = Number(env?.total_pages ?? env?.totalPages);
    if (Number.isFinite(tp) && tp > 0) totalPages = tp;

    // Pagination stop:
    //  - total_pages known → loop exactly that many pages (an empty/odd MIDDLE
    //    page no longer truncates the scan);
    //  - total_pages absent → stop on the first short/empty page;
    //  - hard safety bound either way.
    if (totalPages !== undefined ? page >= totalPages : list.length < CONTACTS_PAGE_SIZE) break;
    if (page >= MAX_CONTACT_PAGES) {
      // Surface the truncation instead of silently under-scanning a huge book.
      console.warn(
        `[phoneburner] member ${memberId}: hit MAX_CONTACT_PAGES (${MAX_CONTACT_PAGES}); ` +
          `scan truncated at ${out.length} contacts${totalPages ? ` of ${totalPages} pages` : ""}.`
      );
      break;
    }
    page++;
  }

  return out;
}

export interface DeleteResult {
  ok: boolean;
  status: number;
  /** true when the contact was already gone (404) — treated as success. */
  alreadyGone: boolean;
}

/** Delete one PhoneBurner contact. Idempotent: a 404 counts as success. */
export async function deletePbContact(
  contactId: string,
  getToken: (force?: boolean) => Promise<string>
): Promise<DeleteResult> {
  const res = await pbFetch(`/contacts/${encodeURIComponent(contactId)}`, getToken, { method: "DELETE" });
  if (res.status === 404) return { ok: true, status: 404, alreadyGone: true };
  const ok = res.status === 200 || res.status === 202 || res.status === 204;
  return { ok, status: res.status, alreadyGone: false };
}
