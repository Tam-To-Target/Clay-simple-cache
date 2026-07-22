/**
 * Meeting-protection gate for the PhoneBurner DNC purge (Option B).
 *
 * See MEETING_PROTECTION_PLAN.md. When a purge candidate's HubSpot contact has
 * a meeting date in the future or within the last `windowDays`, we protect it
 * (skip the PhoneBurner delete) rather than purging it immediately. This keeps
 * the contact suppressed everywhere else (dnc_entries / /dnc-check) — we only
 * delay the physical PhoneBurner deletion.
 *
 * Fail-closed: if the HubSpot read fails, every candidate that had a
 * resolvable HubSpot contact id is protected (never deleted on a failed read).
 */

import type { Client } from "@prisma/client";
import prisma from "../db/prisma";
import { getValidToken } from "./hubspot-token.service";
import { batchReadContactProperties, type TokenProvider } from "./hubspot-lists.service";

export interface MeetingProtectionConfig {
  enabled: boolean;
  property: string;
  windowDays: number;
}

/** Reads env at call time (not module load) so tests/config changes take effect immediately. */
export function meetingProtectionConfigFromEnv(
  overrides?: Partial<MeetingProtectionConfig>
): MeetingProtectionConfig {
  const enabled = process.env.MEETING_PROTECTION_ENABLED === "true";
  const property = process.env.MEETING_PROTECTION_PROPERTY || "meeting_scheduled_date";
  const parsedWindow = Number(process.env.MEETING_PROTECTION_WINDOW_DAYS);
  const windowDays = Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : 7;

  return {
    enabled,
    property,
    windowDays,
    ...overrides,
  };
}

/** A purge candidate, with identifiers already normalized by the caller. */
export interface ProtectCandidate {
  pbContactId: string;
  emails: string[];
  phones: string[];
}

export type ProtectContactsFn = (
  client: Client,
  candidates: ProtectCandidate[]
) => Promise<{ protectedIds: Set<string>; readErrors: number }>;

const DAY_MS = 86_400_000;

/**
 * Resolves each candidate's HubSpot contact id (via dnc_entries), batch-reads
 * the meeting-date property, and returns the set of candidate pbContactIds
 * that should be protected (not deleted) this run.
 *
 * Fail-closed: if the HubSpot batch-read throws, every candidate with a
 * resolvable contact id is protected and `readErrors` counts the unique
 * contact ids we failed to read.
 */
export async function loadMeetingProtectedContactIds(
  client: Client,
  candidates: ProtectCandidate[],
  cfg: MeetingProtectionConfig,
  deps?: {
    now?: Date;
    tokenProvider?: TokenProvider;
    batchRead?: typeof batchReadContactProperties;
  }
): Promise<{ protectedIds: Set<string>; readErrors: number }> {
  if (!cfg.enabled || candidates.length === 0 || !client.hubspot_portal_id) {
    return { protectedIds: new Set(), readErrors: 0 };
  }

  // Step 2: collect all candidate identifiers and look up hubspot_contact_id
  // via dnc_entries.data.
  const emailSet = new Set<string>();
  const phoneSet = new Set<string>();
  for (const c of candidates) {
    for (const e of c.emails) if (e) emailSet.add(e);
    for (const p of c.phones) if (p) phoneSet.add(p);
  }
  const emails = [...emailSet];
  const phones = [...phoneSet];

  const emailToContactId = new Map<string, string>();
  const phoneToContactId = new Map<string, string>();

  if (emails.length > 0 || phones.length > 0) {
    const or: any[] = [];
    if (emails.length > 0) or.push({ email: { in: emails } });
    if (phones.length > 0) or.push({ phone_e164: { in: phones } });

    const rows = await prisma.dncEntry.findMany({
      where: { client_id: client.id, OR: or },
      select: { email: true, phone_e164: true, data: true },
    });

    for (const row of rows) {
      const contactId = (row.data as any)?.hubspot_contact_id;
      if (typeof contactId !== "string" || contactId.length === 0) continue;
      if (row.email) emailToContactId.set(row.email, contactId);
      if (row.phone_e164) phoneToContactId.set(row.phone_e164, contactId);
    }
  }

  // Step 3: resolve each candidate to a contactId; group candidates by contactId.
  const candidateToContactId = new Map<string, string>();
  const contactIdToCandidates = new Map<string, Set<string>>();

  for (const c of candidates) {
    let contactId: string | undefined;
    for (const e of c.emails) {
      const id = emailToContactId.get(e);
      if (id) {
        contactId = id;
        break;
      }
    }
    if (!contactId) {
      for (const p of c.phones) {
        const id = phoneToContactId.get(p);
        if (id) {
          contactId = id;
          break;
        }
      }
    }
    if (!contactId) continue;

    candidateToContactId.set(c.pbContactId, contactId);
    let set = contactIdToCandidates.get(contactId);
    if (!set) {
      set = new Set();
      contactIdToCandidates.set(contactId, set);
    }
    set.add(c.pbContactId);
  }

  const uniqueContactIds = [...contactIdToCandidates.keys()];
  if (uniqueContactIds.length === 0) {
    return { protectedIds: new Set(), readErrors: 0 };
  }

  const tokenProvider: TokenProvider =
    deps?.tokenProvider ?? ((force?: boolean) => getValidToken(client.hubspot_portal_id!, { force }));
  const batchRead = deps?.batchRead ?? batchReadContactProperties;

  let propsByContactId: Map<string, Record<string, string | null>>;
  try {
    propsByContactId = await batchRead(tokenProvider, uniqueContactIds, [cfg.property]);
  } catch (err) {
    console.error(
      `[meeting-protection] HubSpot batch read failed for client ${client.id} (portal ${client.hubspot_portal_id}); fail-closed protecting ${uniqueContactIds.length} contact(s):`,
      err
    );
    const protectedIds = new Set<string>();
    for (const contactId of uniqueContactIds) {
      for (const pbContactId of contactIdToCandidates.get(contactId) ?? []) {
        protectedIds.add(pbContactId);
      }
    }
    return { protectedIds, readErrors: uniqueContactIds.length };
  }

  const now = deps?.now?.getTime() ?? Date.now();
  const protectedIds = new Set<string>();

  for (const [contactId, pbContactIds] of contactIdToCandidates) {
    const props = propsByContactId.get(contactId);
    const v = props?.[cfg.property];
    if (!v) continue;

    const ms = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
    if (Number.isNaN(ms)) continue;

    const inWindow = ms > now - cfg.windowDays * DAY_MS;
    if (!inWindow) continue;

    for (const pbContactId of pbContactIds) protectedIds.add(pbContactId);
  }

  return { protectedIds, readErrors: 0 };
}
