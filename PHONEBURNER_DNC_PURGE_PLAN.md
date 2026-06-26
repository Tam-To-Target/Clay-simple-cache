# PhoneBurner DNC Purge — Daily Cron Plan (spec / RFC)

**Status:** proposal for team review — NOT implemented. No code shipped with this doc.
**Author:** ops (via Claude) · **Date:** 2026-06-26
**Scope:** add a daily job to this project that deletes, from each client's PhoneBurner
dialer, every contact that collides with that client's Do-Not-Contact list.

---

## 1. Problem & goal

We maintain per-client DNC lists in this project's DB (`dnc_entries`, synced daily from
each client's HubSpot `TAM - Do Not Contact (Individual)` / `(Domain)` lists). But the SDRs
dial out of **PhoneBurner**, which does **not** read our DNC list. So contacts a client has
marked Do-Not-Contact in HubSpot can still sit in an SDR's PhoneBurner book and get dialed.

**Goal:** once a day, for each active client, find every PhoneBurner contact that matches the
client's DNC list (by **phone**, **email**, or **domain**) and **delete it from PhoneBurner**.

### Why delete (not flag)
PhoneBurner's REST API **cannot set the DNC flag** — verified exhaustively 2026-06-26:
no `dnc`/suppression endpoint exists; `do_not_call` on contact/phone `PUT` is accepted but a
no-op; `is_global_dnc` is PhoneBurner-owned/read-only. The only way to set the real DNC flag
is replaying PhoneBurner's internal web endpoint from a logged-in **Chrome** session — which
is **unavailable in this headless cron environment**. Therefore the cron uses the **delete**
route (`DELETE /rest/1/contacts/{id}`), which is confirmed working.

### Known limitation of the delete approach (must be accepted explicitly)
Deleting a contact does **not** suppress its number — if the same lead re-imports (Clay /
list upload / HubSpot sync), it reappears and is dialable again. The **daily cadence is the
mitigation**: each run re-deletes anything that came back. Residual risk = a contact imported
**and dialed within the same day** before the next run. The durable fix is upstream
(scrub at import time) or the real DNC list (browser replay) — see §9.

---

## 2. What already exists (reuse, don't rebuild)

| Capability | Where | Reuse for this feature |
|---|---|---|
| DNC entries per client (email/phone_e164/domain, indexed) | `dnc_entries` table | The collision reference set — already cached, authoritative |
| Match logic (OR across email/phone/domain) | `dncService.findMatch(clientId, ids)` in `src/services/dnc.service.ts` | Per-contact collision check (or bulk-load into in-memory sets) |
| Normalization (email lower / phone→E.164 / domain) | `src/services/normalization.ts` (`libphonenumber-js`) | Normalize PhoneBurner fields identically to DNC entries |
| Free/disposable-provider filtering | `src/email-finder/static-lists.ts`, `data/free_providers.txt`, `data/disposable_domains.txt` | Domain extraction from PB email (don't block gmail.com) |
| Client registry (slug ↔ portal) | `data/clients.json`, `src/config/registry.ts` | Extend with PhoneBurner member mapping |
| Throttle + retry HTTP pattern | `hsFetch()` in `src/services/hubspot-lists.service.ts` | Mirror as `pbFetch()` for PhoneBurner |
| Token-resolution-via-service pattern | `getValidToken()` in `src/services/hubspot-token.service.ts` | Mirror for PhoneBurner admin-token → member-token resolution |
| Daily script + Railway cron | `npm run dnc:sync` (`src/scripts/sync-dnc.ts`) | New script runs **after** it |

**Implication:** the DNC (HubSpot) side is the stable, already-cached half. The only genuinely
new work is (a) the **client → PhoneBurner member** bridge + token resolution, (b) fetching PB
contacts, (c) the delete-with-audit pipeline.

---

## 3. PhoneBurner facts that constrain the design (verified live 2026-06-26)

- **Base / auth:** `https://www.phoneburner.com/rest/1`, `Authorization: Bearer <token>`,
  **non-empty `User-Agent` required** (else 403). Writes are form-encoded; JSON works for some.
- **Contacts list:** `GET /contacts?page_size=300&page=N` → full book, paged. Each record has
  `user_id` (contact id), `primary_email`+`emails[]`, `primary_phone`+`phones[]` (with
  `raw_phone`), `category` (dialing folder), `do_not_call`.
- **No incremental fetch.** `date_modified_after`, `modified_since`, `date_added_after`, sort
  params are all **silently ignored** (every variant returned the full count). ⇒ every run
  must full-scan each member's book. **A PB mirror table does NOT reduce fetch cost.**
- **Delete:** `DELETE /rest/1/contacts/{id}` → empty body, key on HTTP `200/202/204`. Confirmed
  working (752 contacts deleted cleanly in the CyberNut one-off).
- **One team account, many members.** Admin (BOBBY) token: `GET /rest/1/members?page_size=100`
  returns **all 61 members with a fresh `oauth.bearer_token` + `expires` inline** — this is the
  token-resolution mechanism (one durable admin secret → all member tokens on demand).
- **Per-SDR "API Access" toggle.** A member token only works if that account has API Access
  enabled in the PB UI; otherwise **every endpoint 403s** ("API Access not enabled"). The admin
  token only ever sees **its own** contacts (owner/member filters are ignored) — so we **must**
  use each SDR's own enabled token to fetch+delete that SDR's contacts.

---

## 4. Architecture options

The variable is the **PhoneBurner side** (DNC is already cached). Three shapes:

### Option A — Mirror PhoneBurner contacts in the DB, collide via SQL join, then delete
Add a `phoneburner_contacts` table. Daily: full-fetch each member's book → upsert into mirror →
`JOIN phoneburner_contacts × dnc_entries` (email/phone/domain) → delete matches on PB → mark rows.

- **Pros:** symmetric with the existing "snapshot into DB, match in DB" design; collision is
  set-based SQL on indexed columns; gives a queryable PB history (analytics / reconciliation);
  cleanly decouples fetch from compare/delete.
- **Cons:** new table + upsert/diff code + more PII at rest; **no fetch savings** (PB has no
  incremental API — §3), so the mirror is re-written wholesale each run; mirror is only as fresh
  as the last fetch; most of its benefit (audit) is also achievable with a small deletion log.

### Option B — Live-fetch PhoneBurner, compare to cached DNC in memory, delete (RECOMMENDED)
No PB persistence. Daily, per client: load the client's DNC identifier sets from `dnc_entries`
(3 sets: emails, phones, domains) → stream-fetch each member's PB book → match in memory →
back up + delete collisions → write **deletion-audit** rows only.

- **Pros:** leanest correct design; operates on **live** PB data so delete IDs are always
  current; minimal new schema (one audit table + a member-mapping table); least PII at rest;
  matches the "DNC = cached side, PB = volatile side fetched fresh" reality.
- **Cons:** collision is in-memory per client (trivial: even 8k DNC entries × thousands of
  contacts is small); no general PB history (only a deletion trail); fetch+compare+delete in one
  pass (mitigated by per-member checkpointing + the audit table for resumability).

### Option C — Fully direct: fetch BOTH HubSpot and PhoneBurner live every run, no caching
Ignore `dnc_entries`; re-pull each portal's DNC lists live, re-pull PB, compare, delete.

- **Pros:** no staleness window on the DNC side; conceptually simplest "one big compare."
- **Cons:** **throws away the existing DNC cache** and re-hammers HubSpot (16k+ list reads ×
  every client, every day) for no benefit — the daily `dnc:sync` already refreshes the cache;
  slowest, most rate-limit-exposed, least observable. Not recommended.

### Recommendation
**Option B**, plus a persistent **deletion-audit** table that stores a full pre-delete snapshot
of each removed contact (so deletes are re-importable). Rationale: because PB has no incremental
fetch, Option A's mirror buys no performance and adds PII + code; the only thing the mirror gives
that B doesn't is general-purpose PB analytics, which isn't the goal. Choose **A** only if the
team also wants a queryable PhoneBurner contact warehouse or PB later ships an incremental API.

| Dimension | A (mirror+SQL) | **B (live+cache)** | C (fully direct) |
|---|---|---|---|
| New schema | mirror + audit | **audit + mapping** | none |
| Fetch cost / run | full PB scan | **full PB scan** | full PB **+ full HubSpot** |
| Collision correctness | DB join | **in-memory sets** | in-memory sets |
| Freshness of delete IDs | mirror-stale | **live** | live |
| Auditability | high | **high (audit table)** | low |
| PII at rest | high | **low** | none |
| Code/complexity | high | **medium** | low-but-wasteful |
| Resumability | high | **medium** | low |

---

## 5. Daily job — data flow (Option B)

```
[Railway cron]  npm run dnc:sync          (existing — refresh DNC cache FIRST)
                       │
                       ▼
[Railway cron]  npm run pb:purge          (NEW — must run after dnc:sync)
                       │
   for each active client with mapped PhoneBurner members:
     1. Load DNC sets from dnc_entries:  emails:Set, phones:Set<E164>, domains:Set
        (domains only from domain-level sources — same rule as dncService)
     2. Resolve member tokens:  admin /members → {member_id → fresh bearer_token}
why?   (one call, cached for the run; re-pull if a token nears `expires`)
     3. for each member dialing for this client:
          a. GET /contacts paged (page_size=300) until exhausted
          b. for each contact → normalize {emails[], phones[]→E164, domains(free-filtered)}
             collide = any email∈emails OR any phone∈phones OR any domain∈domains
          c. collect collisions (contact id + which key matched + snapshot)
     4. SAFETY GATE: if collisions/contacts_in_book > THRESHOLD (e.g. 40%) → ABORT this
        member, log + alert (guards against a corrupt DNC sync nuking a whole book)
     5. for each collision:  write audit row (with full snapshot) → DELETE /contacts/{id}
        → update audit row status (deleted|failed)
     6. write a per-client run summary
```

**Match parity is mandatory:** PhoneBurner phones → E.164 via the same `normalization.ts`
used to build `phone_e164` in `dnc_entries`; domains free/disposable-filtered via the same
static lists. Mismatched normalization = missed or false collisions.

---

## 6. Schema additions (Option B)

```prisma
// Which PhoneBurner members dial for which client. Populated by an extended
// `clients:generate` (join SDR Launch SDRs → pb member id) or a bootstrap script.
// Tokens are NOT stored — resolved at runtime from the admin token (§7).
model PhoneburnerMember {
  id            String   @id @default(uuid()) @db.Uuid
  client_id     String   @db.Uuid
  client        Client   @relation(fields: [client_id], references: [id], onDelete: Cascade)
  pb_member_id  String                     // PhoneBurner user_id
  pb_username   String?                    // email, for logs
  active        Boolean  @default(true)    // false = stop scrubbing (left team / API off)
  api_access_ok Boolean  @default(false)   // last run saw a working token (else 403)
  last_run_at   DateTime? @db.Timestamptz(6)
  created_at    DateTime @default(now()) @db.Timestamptz(6)
  updated_at    DateTime @updatedAt @db.Timestamptz(6)
  @@unique([client_id, pb_member_id])
  @@index([client_id])
  @@map("phoneburner_members")
}

// Audit + backup of every deletion. `snapshot` holds the full PB contact JSON so a
// delete is re-importable. Doubles as idempotency + reporting.
model PhoneburnerDeletion {
  id             String   @id @default(uuid()) @db.Uuid
  client_id      String   @db.Uuid
  pb_member_id   String
  pb_contact_id  String
  matched_on     String                    // 'email' | 'phone' | 'domain' (+combos)
  matched_value  String?
  snapshot       Json     @default("{}")    // full contact record at delete time
  status         String                     // 'deleted' | 'failed' | 'dry_run'
  http_status    Int?
  error          String?
  run_id         String?  @db.Uuid
  deleted_at     DateTime @default(now()) @db.Timestamptz(6)
  @@index([client_id, pb_contact_id])
  @@index([run_id])
  @@map("phoneburner_deletions")
}

// One row per cron run (observability + alerting).
model PhoneburnerPurgeRun {
  id                 String   @id @default(uuid()) @db.Uuid
  started_at         DateTime @default(now()) @db.Timestamptz(6)
  finished_at        DateTime? @db.Timestamptz(6)
  dry_run            Boolean  @default(false)
  clients_processed  Int      @default(0)
  members_processed  Int      @default(0)
  members_skipped    Int      @default(0)   // API access off, no token, aborted by gate
  contacts_scanned   Int      @default(0)
  collisions_found   Int      @default(0)
  deleted            Int      @default(0)
  failed             Int      @default(0)
  status             String   @default("running") // running | ok | partial | error
  notes              String?
  @@map("phoneburner_purge_runs")
}
```

*(Option A would additionally add a `phoneburner_contacts` mirror: `client_id, pb_member_id,
pb_contact_id, email, phone_e164, domain, raw Json, synced_at`, unique on
`(pb_member_id, pb_contact_id)`.)*

---

## 7. Token & access model

- **One durable secret:** `PHONEBURNER_ADMIN_TOKEN` (the BOBBY/admin bearer token) in env.
- **Runtime resolution** (mirror of `getValidToken`): `GET /rest/1/members?page_size=100`
  with the admin token → map `member_id → {bearer_token, expires}`. Cache for the run;
  re-pull when a token is within ~2 min of `expires`. New `src/services/phoneburner-token.service.ts`.
- **Per-SDR API Access is a hard dependency.** If a member's token 403s ("API Access not
  enabled"), the job **skips** that member, sets `api_access_ok=false`, and surfaces it in the
  run summary. **Onboarding step:** enable API Access on each dialing SDR's PB account.
- **OPEN QUESTION:** how is `PHONEBURNER_ADMIN_TOKEN` itself kept fresh? PB OAuth tokens expire.
  Need either a long-lived admin token, or store an admin refresh-token + app creds and refresh
  (small `phoneburner-oauth` helper). Decide before go-live (see §11).

---

## 8. Safety rails (non-negotiable)

1. **Backup before delete** — store full contact JSON in `phoneburner_deletions.snapshot`
   (re-importable). The CyberNut one-off proved this matters.
2. **Collision-ratio gate** — abort a member's deletes if collisions exceed `PB_PURGE_MAX_RATIO`
   (default 0.40) of its book; log + alert instead of deleting. Stops a bad DNC sync from
   wiping a whole book.
3. **Dry-run mode** — `PB_PURGE_DRY_RUN=true` (and `npm run pb:purge -- --dry-run`): compute and
   write audit rows with `status='dry_run'`, **no deletes**. First production runs should be dry.
4. **Idempotent** — deletion keyed on `pb_contact_id`; already-gone → skip, not error.
5. **Rate-limited + retried** — `pbFetch()` with throttle + backoff on 429/5xx (mirror `hsFetch`);
   `User-Agent` always set.
6. **Order dependency** — must run **after** `dnc:sync` so the DNC cache is fresh.
7. **Scope control** — only `Client.active=true` with ≥1 `active` `PhoneburnerMember`; skip
   inactive SDRs (e.g. Nathan-style) — they 403 anyway.
8. **Per-run cap (optional)** — `PB_PURGE_MAX_DELETES_PER_RUN` circuit breaker.

---

## 9. Strategic note — the durable fix is upstream
Delete-on-a-schedule is a **mitigation**, not a cure (§1). Two durable complements, both out of
scope here but worth a follow-up:
- **Scrub at import** — have the lead-loading pipeline (Clay/import) call this project's existing
  `POST /dnc-check` before a contact ever enters PhoneBurner. Stops the re-import treadmill.
- **Real DNC list** — bulk-add the numbers to PhoneBurner's internal DNC list (team-wide,
  survives re-import) via browser-replay of the internal endpoint. Needs Chrome → run as a
  separate operator-triggered tool, not this headless cron.

---

## 10. New surface area (files / commands / env)

```
src/services/phoneburner.service.ts          fetch contacts (paged), delete contact, pbFetch()
src/services/phoneburner-token.service.ts    admin-token → member-token resolution + cache
src/services/phoneburner-purge.service.ts    per-client collision + delete + audit + gates
src/scripts/purge-phoneburner.ts             npm run pb:purge  (entry point; --dry-run, [slug])
src/scripts/generate-clients.ts (extend)     also emit client → pb_member_id map (SDR Launch join)
src/controllers/dnc.controller.ts (extend)   optional POST /admin/phoneburner/purge {client_id?, dry_run?}
prisma/schema.prisma (extend)                3 models in §6
```

New env:
```
PHONEBURNER_ADMIN_TOKEN=...        # BOBBY/admin bearer (token resolution)
PHONEBURNER_API_BASE=https://www.phoneburner.com/rest/1
PB_PURGE_DRY_RUN=true             # default true until validated
PB_PURGE_MAX_RATIO=0.40
PB_PURGE_MAX_DELETES_PER_RUN=     # optional circuit breaker
```

Cron (Railway), sequential:
```
npm run dnc:sync   &&   npm run pb:purge        # daily, e.g. 03:00 UTC
```

---

## 11. Open questions for the team
1. **Admin token refresh** (§7) — long-lived token vs OAuth refresh helper? Blocker for go-live.
2. **Client → SDR mapping source of truth** — SDR Launch DB (has pb member id + assignments) vs
   Airtable Master Client Board "SDRs"? Recommend SDR Launch (already joined in `clients:generate`).
3. **Multi-client SDRs** — can one PB member dial for >1 client? If so, scope deletes per client
   (only delete a contact when it collides with *that* client's DNC) — the mapping is many-to-many.
4. **Domain-level aggressiveness** — keep domain collisions in scope (CyberNut run: a large share
   were domain-only)? Same toggle question as the one-off.
5. **A vs B** — confirm Option B, or do we want the PB mirror (Option A) for analytics?
6. **Rollout** — start with one client (CyberNut) in dry-run, verify audit, then enable deletes,
   then expand. Agreed?

---

## 12. Phased rollout
1. Schema + `phoneburner.service` + token service; `pb:purge` in **dry-run**, single client.
2. Review `phoneburner_deletions` (dry_run rows) vs expectation; tune normalization/threshold.
3. Enable real deletes for one client; verify counts + backups.
4. Extend mapping to all active clients; wire the cron after `dnc:sync`.
5. Add alerting on run summary anomalies (skips, gate aborts, failure spikes).
6. Follow-up: import-time `/dnc-check` scrub (§9) to shrink the daily delete volume over time.
```
