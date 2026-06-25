# Multi-tenant DNC — Bootstrap, Classification & Daily Sync (Implementation Plan v2)

Status: **awaiting approval** — nothing below is built yet.

## Goal
Populate the production DNC cache for every TAM customer that has a HubSpot
integration, by discovering each portal's `TAM - Do Not Contact …` lists,
classifying them as **individual** or **domain** suppression, syncing their
members into the cache, and keeping them fresh daily.

---

## What was verified live (production data)

- **Tokens DB** (`HUBSPOT_TOKES_DATABASE_URL` → Railway `portal_tokens`): 14 portals,
  only `portal_id` + OAuth tokens (30-min TTL). **No customer names.**
- **Token refresh is already solved** by the provisioner:
  `GET {HUBSPOT_PROVISIONER_URL}/internal/token?portalId=X` with header
  `X-Internal-Secret: $HUBSPOT_PROVISIONER_API_SECRET` returns a freshly-refreshed
  token. Tested live across all portals ✅.
- **Slug bridge** = SDR_Launch `clients` table (the Airtable-synced mirror): has
  `slug` (unique, lowercase-hyphen), `name`, `client_reference_name`,
  `airtable_record_id`, and `hubspot_portal_id`. This is the *only* place the
  portal ↔ client link exists (Airtable's Master Client Board has the client
  reference + domain but **no portal id**).
- **Discovery works**: `POST /crm/v3/lists/search {query:"TAM - Do Not Contact"}`
  returns the lists per portal. All DNC lists are **contact** lists (`objectTypeId 0-1`).

### Portal → slug mapping (13 of 14 resolved)

| portal_id | slug | name | DNC lists discovered (live) |
|---|---|---|---|
| 2100863 | `pathwise` | Pathwise | `19220` plain → individual; `19696` (Domain) |
| 3313790 | `stellic` | Stellic | `6828` (Domain); `6830` (Individual) |
| 20524720 | `studentbridge` | StudentBridge | `16432` (Domain); `16434` (Individual) |
| 21369353 | `kaleidoscope` | Kaleidoscope | `1138` (Domain); `1142` (Individual) |
| 22493085 | `hilight` | Hilight | `845` (Domain); `848` (Individual) |
| 23342274 | `club-hub` | Club Hub | `716` (Domain); `747` (Individual) |
| 45274441 | `cybernut` | CyberNut | `792` (Individual); `795` (Domain); `1245` (Inbound→individual+warn) |
| 46773168 | `nido-learning` | Nido Learning | **none** (client created, no sources) |
| 47008204 | `scantron` | Scantron | `1356` plain → individual |
| 47815345 | `mastra` | Mastra AI | `494` (Domain); `497` (Individual) |
| 242448990 | `awarded-software` | Awarded Software | `13` (Domain); `15` (Individual) |
| 244264386 | `tam-to-target` | TAM to Target | `299` (Domain); `302` (Individual) |
| 245381868 | `reddrop` | RedDrop | `17`+`66` (Domain); `20`+`67` (Individual) — redundant pair |
| **85896** | **— unmapped —** | (stale 2026-05-19 token, no client) | **skip + report** |

---

## Design decisions

1. **`external_id` = the SDR_Launch slug** (e.g. `hilight`, `awarded-software`).
   Already lowercase-hyphen, already derived from the Airtable client reference,
   and consistent with how the rest of the platform identifies clients. Clay
   passes this as `client_id`.

2. **Tokens are resolved at runtime via the provisioner**, never stored on the
   client. `clients.hubspot_portal_id` holds the portal; we fetch a fresh token
   per sync. Uses the new `HUBSPOT_PROVISIONER_API_SECRET` env var.

3. **Two DNC levels, classified by list name (case-insensitive, substring):**
   - contains `(domain)` → **domain**
   - else contains `(individual)` → **individual**
   - else (plain / `(Inbound)` / unknown) → **individual** + log a warning
   - **individual source** writes exact-match entries: `email`, `phone`.
   - **domain source** writes exact entries **and** a deduped `domain` entry per
     member, where the domain is taken from the member's email host (and any
     explicit domain property), **excluding free/disposable providers**
     (`data/free_providers.txt`, `data/disposable_domains.txt`) to avoid blocking
     `gmail.com` etc.

4. **Check-side already supports domain matching** — `normalizeCheckIdentifiers`
   derives the incoming email's domain, and `findMatch` ORs
   `email | phone | explicit-domain | email-domain` against stored entries. So
   once domain entries are written, a check on `jane@acme.com` matches a stored
   `acme.com` domain entry. Requirement "compare domain + email-domain on both
   sides" is satisfied.

5. **Unknown `client_id` → 404 with suggestions.** `/dnc-check` (and
   `/admin/clients/:id`) return `{ error, suggestions: [...] }` — the closest
   slugs/names by similarity (normalized Levenshtein + substring), top 3.

---

## Changes

### New env (already added by user)
`HUBSPOT_PROVISIONER_URL`, `HUBSPOT_PROVISIONER_API_SECRET`, `HUBSPOT_TOKES_DATABASE_URL`.
Add `DNC_LIST_NAME_PREFIX="TAM - Do Not Contact"` (configurable nomenclature).

### Schema (Prisma `db push`, no migration files in this repo)
- `DncSource.dnc_level String @default("individual")` — `'individual' | 'domain'`.

### New files
- `src/services/hubspot-token.service.ts` — `getValidToken(portalId)` → provisioner
  `/internal/token`; in-memory per-run cache.
- `src/services/tokens-db.service.ts` — `listPortalIds()` reads `portal_tokens`
  (adds `pg` dep for this single cross-DB read).
- `src/config/clients.ts` + generated `data/clients.json` — committed client
  registry (`slug, portal_id, name, client_reference_name, domain`). Generated
  **once** by `npm run clients:generate` (joins token DB ⋈ SDR_Launch clients).
- `src/services/client-registry.service.ts` — load registry; `suggestSimilar(query)`.
- `src/scripts/bootstrap-dnc.ts` (`npm run dnc:bootstrap`) — idempotent: per
  registry entry → upsert cache client → discover + classify lists → upsert a
  source per list → sync. Per-portal report (lists, level, entries, skips).

### Modified
- `src/services/hubspot-lists.service.ts` — add `searchDncLists(token, prefix)`
  (lists/search + prefix filter + classify) and extend the member fetch to also
  read `hs_email_domain` for domain extraction.
- `src/services/dnc-sync.service.ts` — resolve token via `getValidToken(portal_id)`;
  branch entry-building on `source.dnc_level` (domain expansion + free-provider filter).
- `src/scripts/sync-dnc.ts` — daily job = **re-discover + sync** (picks up new
  lists, reclassifies, deactivates vanished lists, refreshes membership).
- `src/controllers/dnc.controller.ts` + `routes.ts` — `POST /admin/dnc/discover`
  (HTTP-triggerable bootstrap); unknown-client suggestions on `check`/`getClient`.
- `package.json` — add `pg`; scripts `clients:generate`, `dnc:bootstrap`.
- Update tests touching the stored-token sync path + add classifier/domain tests.

### Daily scheduler
Railway cron → `npm run dnc:sync` (re-discover + sync) once daily.
HTTP-cron alternative: `POST /admin/dnc/discover` then `POST /admin/dnc/sync`.

---

## Known limitation (documented)
DNC lists are dynamic **contact** lists. A brand-new contact at a suppressed
company is blocked only after HubSpot adds it to the (Domain) list **and** we
re-sync (daily). Domain expansion mitigates this for any company that already has
≥1 listed contact with a corporate email. True zero-day company blocking would
need a company-domain feed (CSV `domain` column) — out of scope.

## Validation (run live after build)
1. `npm run clients:generate` → registry written (13 clients + 85896 flagged).
2. `npm run dnc:bootstrap` → report: clients created, lists per portal w/ level,
   entries synced; nido-learning shows 0 sources; 85896 skipped.
3. `GET /admin/clients/hilight` → 2 sources (845 domain / 848 individual),
   `last_sync_status: ok`, sane `last_entry_count`.
4. `POST /dnc-check`:
   - a known individual member → `contactable:false, matched_on:"email"`
   - an email at a suppressed corporate domain → `contactable:false, matched_on:"domain"`
   - a free-provider/random email → `contactable:true`
   - unknown `client_id:"hilightt"` → 404 + `suggestions:["hilight", …]`
5. Second `dnc:sync` is idempotent (counts stable, no dupes).
