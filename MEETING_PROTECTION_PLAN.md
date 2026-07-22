# Meeting-Protection for the PhoneBurner DNC Purge (Option B)

## Problem

When an SDR books a meeting, GTMOS syncs it to the customer's HubSpot portal and
stamps meeting props on the contact. The portal's dynamic "TAM - Do Not Contact"
list includes a "has a booked meeting" criterion, so the contact enters the DNC
list immediately. The Contact Platform's hourly detector then inserts a
`dnc_entries` row and the **targeted purge deletes the contact from the SDR's
PhoneBurner book within ~1 hour** — before the SDR can confirm the meeting or
reschedule a no-show.

We want to **delay the PhoneBurner deletion** until the meeting is resolved
(held, or a no-show with no reschedule), while leaving everything else about DNC
suppression intact.

## Key design decision: protect at the PURGE layer, not the DNC-entry layer

DNC entries feed BOTH the PhoneBurner purge AND `/dnc-check` (used by Clay
enrichment and other consumers). We must keep the contact *suppressed* for those
consumers — we only want to delay the physical PB deletion. Therefore protection
lives in `phoneburner-purge.service.ts`, NOT in `dnc-sync` / `dnc_entries`.

Consequence: **no Prisma migration.** Protection is computed live per run; it is
not persisted.

## Behavior

A purge candidate (a PhoneBurner contact about to be deleted for colliding with
the client's DNC) is **protected (skipped, not deleted)** when its HubSpot
contact has a meeting date that is in the future OR ended less than
`WINDOW_DAYS` ago. Formally, protect iff:

```
meetingDate.getTime() > now - WINDOW_DAYS * 86_400_000
```

- A reschedule pushes the meeting date forward → the contact stays protected.
- Once the window passes with no reschedule, the contact is deleted on the next
  purge that sees it.

### Which purge deletes a protected contact once its window expires?

The **targeted path** (hourly) advances its watermark normally even when it
protects a candidate, so it will NOT re-check a protected contact on later ticks.
The **full-scan path** (weekly, `PB_FULL_SCAN_MAX_AGE_HOURS`) re-collides the
entire book every run and re-applies the meeting check, so it is the authoritative
backstop that eventually deletes a contact once its window has expired. Removal
latency after window-expiry is therefore ≤ the full-scan interval (~7 days). This
is acceptable and intentional: over-retention is the safe direction for this feature.

### Failure mode: HubSpot read fails

**Fail-closed.** If the meeting-date read fails (transport error, exhausted
retries, bad property name, revoked access), the affected candidates are
**protected (not deleted)** and counted in `protected_read_errors`. Rationale:
the user's explicit priority is to avoid premature deletion; a failed read must
never cause a delete. A persistent config error (e.g. wrong property name) is
highly visible — deletions drop toward zero and `protected_read_errors` spikes.
**Verify the property name against a real portal before enabling widely.**

### Opt-out caveat

The check is purely "does this contact have a recent/future meeting date." A
contact that hard-opted-out AND happens to have a recent meeting date gets
`WINDOW_DAYS` of grace before removal. This is low-risk and documented; if
stricter handling is ever needed, add a do-not-call property check to the gate.

## Config (env, read at call time; feature default OFF)

- `MEETING_PROTECTION_ENABLED` — `"true"` to enable. Default: disabled.
- `MEETING_PROTECTION_PROPERTY` — HubSpot date property to read. Default:
  `meeting_scheduled_date`.
- `MEETING_PROTECTION_WINDOW_DAYS` — grace window N. Default: `7`.

## Pieces

### Piece 1 — generic HubSpot batch-read (`src/services/hubspot-lists.service.ts`)

Generalize the existing private `fetchContactProps` into an exported helper and
keep `fetchContactProps` using it (no behavior change to existing callers):

```ts
export async function batchReadContactProperties(
  tokenProvider: TokenProvider,
  ids: string[],
  properties: string[],
  opts?: HsCallOpts
): Promise<Map<string, Record<string, string | null>>>;
```

Reuse `hsFetch`, `BATCH_READ_SIZE` (100) chunking. Returns id → props map. On a
non-OK response throw an Error whose message includes the HTTP status (existing
`withRetry` already handles 401-refresh and 429/5xx retry).

### Piece 2 — `src/services/meeting-protection.service.ts` (new)

```ts
export interface MeetingProtectionConfig { enabled: boolean; property: string; windowDays: number; }
export function meetingProtectionConfigFromEnv(overrides?: Partial<MeetingProtectionConfig>): MeetingProtectionConfig;

export interface ProtectCandidate { pbContactId: string; emails: string[]; phones: string[]; } // identifiers NORMALIZED by caller
export type ProtectContactsFn = (client: Client, candidates: ProtectCandidate[]) => Promise<{ protectedIds: Set<string>; readErrors: number }>;

export async function loadMeetingProtectedContactIds(
  client: Client,
  candidates: ProtectCandidate[],
  cfg: MeetingProtectionConfig,
  deps?: { now?: Date; tokenProvider?: TokenProvider; batchRead?: typeof batchReadContactProperties }
): Promise<{ protectedIds: Set<string>; readErrors: number }>;
```

Algorithm:
1. If `!cfg.enabled` or `candidates.length === 0` or `!client.hubspot_portal_id`
   → return `{ protectedIds: new Set(), readErrors: 0 }`.
2. Collect all candidate emails + phones. `prisma.dncEntry.findMany({ where: { client_id: client.id, OR: [{ email: { in: emails } }, { phone_e164: { in: phones } }] }, select: { email: true, phone_e164: true, data: true } })`.
   Build `email→hubspot_contact_id` and `phone→hubspot_contact_id` from `data.hubspot_contact_id`.
3. For each candidate resolve a `hubspot_contact_id` via any of its identifiers.
   Candidates with no resolvable id are NOT protected (not meeting-driven, e.g.
   CSV/domain entries). Build `candidate→contactId` and the unique contactId set.
4. `tokenProvider = deps.tokenProvider ?? ((force) => getValidToken(client.hubspot_portal_id!, { force }))`.
5. Batch-read `cfg.property` for the unique contactIds (via `deps.batchRead ?? batchReadContactProperties`).
   - On throw → **fail-closed**: protect every candidate that had a resolvable
     contactId; `readErrors = <count of unread contactIds>`; log the error; return.
6. Parse each contact's property value: if `/^\d+$/` → `Number(value)` (epoch ms),
   else `Date.parse(value)`. Skip `NaN`/empty (→ not protected).
7. A contactId is in-window iff `ms > now - cfg.windowDays * 86_400_000`
   (`now = deps.now?.getTime() ?? Date.now()`).
8. Map in-window contactIds back to candidate `pbContactId`s → `protectedIds`.

### Piece 3 — integrate into `src/services/phoneburner-purge.service.ts`

- Import `ProtectCandidate`, `ProtectContactsFn`, `loadMeetingProtectedContactIds`,
  `meetingProtectionConfigFromEnv` from `./meeting-protection.service`.
- Add to `MemberPurgeResult`: `protected_recent_meeting?: number;` and
  `protected_read_errors?: number;`.
- Add to `PurgeContext`: `protectContacts?: ProtectContactsFn;` (OPTIONAL — a
  missing value or the disabled feature both mean "no protection").
- Define a module-level no-op: `const NOOP_PROTECT: ProtectContactsFn = async () => ({ protectedIds: new Set(), readErrors: 0 });`
- `purgeMember` (full scan): add an optional last param `protect: ProtectContactsFn = NOOP_PROTECT`.
  AFTER the ratio-gate abort check, BEFORE the delete loop: build candidates from
  `collisions` (`pbContactId: contact.id`, emails/phones normalized via
  `normalizeEmail` / `normalizePhone(...)?.e164` — same normalization as `collide`),
  call `protect(client, candidates)`, drop protected from the delete list, set
  `base.protected_recent_meeting` / `base.protected_read_errors` (undefined when 0).
  Keep the ratio gate on raw `collisions.length` (pre-protection).
- `targetedPurgeMember`: `const protect = ctx.protectContacts ?? NOOP_PROTECT;`
  AFTER `candidatesAfterGuard` is built, BEFORE the live-fetch/delete loop: build
  candidates from `profiles` (emails/phones are ALREADY normalized in the index —
  do not re-normalize), call `protect`, iterate only survivors, set the counters.
  Watermark advances normally (full-scan backstop — see above).
- `purgeMemberDispatch.runFull`: pass `ctx.protectContacts ?? NOOP_PROTECT` to `purgeMember`.
- `runPurge`: build the config once (`meetingProtectionConfigFromEnv()`), set
  `ctx.protectContacts = (client, candidates) => loadMeetingProtectedContactIds(client, candidates, cfg)`.
- Rollups: add `protected_recent_meeting` + `protected_read_errors` to
  `PurgeRunSummary.totals`, include them in `logClientResult` (when > 0) and in the
  `PhoneburnerPurgeRun.notes` string. No new DB columns.

## Tests (vitest, mirror `tests/unit/phoneburner-purge.test.ts` mocking style)

- Piece 1: `batchReadContactProperties` chunks >100 ids, maps id→props, throws w/ status on non-OK.
- Piece 2: enabled/disabled gating; future date protected; date older than window NOT
  protected; date within window protected; unresolvable contactId not protected;
  read-throw → fail-closed protects resolvable candidates + counts readErrors; epoch-ms
  and ISO parsing; `deps.now` + `deps.batchRead` injected (no real HubSpot).
- Piece 3: full-scan path protects a colliding contact (delete count drops, counter set);
  targeted path protects a candidate (survivor excluded); disabled/absent `protectContacts`
  → unchanged behavior (existing tests still pass); ratio gate still computed on raw collisions.

## Verification (owner, after subagents)

1. `npx tsc --noEmit` clean.
2. `npm test` green.
3. Manual: with the feature enabled against one portal + a dry run, confirm a
   just-booked meeting contact reports as `protected_recent_meeting` and is NOT
   in the would-delete set.
