# EmailBison DNC Suppression — Integration Plan

**Status:** Plan / RFC (2026-07-27). Net-new. No suppression code exists in either repo yet.
**Goal:** every time a contact enters DNC — via a HubSpot DNC list *or* the `/admin/dnc/import`
API — suppress that contact (email **and** domain) in the client's EmailBison sending workspace,
so it stops receiving cold email. This is the **email-channel analog of the PhoneBurner purge**,
reusing the same triggers and the same `dnc_entries` pipeline.

**One-line design:** add EmailBison as a second **suppression provider** alongside PhoneBurner,
driven by the same `dnc_entries.created_at` watermark, resolving per-workspace API keys from GTMOS
(never storing them here), and **adding** identifiers to EmailBison's native blocklist (durable —
no delete/rescan machinery needed).

---

## Part 1 — How EmailBison suppression works (the mechanism)

EmailBison's native "Block List" is exposed as **two REST resources** on the same host/auth as our
verified sync API (`https://send.tamtotarget.com`, `Authorization: Bearer <per-workspace key>`).
**The token *is* the tenant** — each workspace key returns/writes only that workspace's blocklist.
Adding an entry excludes it from **all sends across that workspace** immediately.

**P0 verified live 2026-07-27** (against TAM to Target's own workspace, throwaway `.invalid`
values, cleaned up — zero client impact). Confirmed shapes:

| Op | Method | Path | Body | Live result |
|---|---|---|---|---|
| Add email | `POST` | `/api/blacklisted-emails` | `{ "email": "user@x.com" }` | **201** `{data:{id,email,created_at,updated_at}}` ✅ |
| Add email (dup) | `POST` | same | same | **422** `"The email has already been taken."` → **treat as success** |
| Bulk add | `POST` | `/api/blacklisted-emails/bulk` | `{ "emails":[...] }` | **500 Server error** ❌ — **do NOT use bulk** |
| Add domain | `POST` | `/api/blacklisted-domains` | `{ "domain": "x.com" }` | **201** ✅ |
| Remove | `DELETE` | `/api/blacklisted-{emails,domains}/{id}` | by **id** | **200** ✅ (not used in v1) |
| List | `GET` | `/api/blacklisted-emails?page=N` | Laravel `{data,links,meta}`, `per_page`=15 | ✅ (not used in v1; `?search=` does **not** reliably filter) |

Design consequences (locked by P0):
- **Single POST per identifier, NOT bulk** (bulk 500s). Fan out new entries with bounded
  concurrency (~5–10) + retry. Per-entry status is cleaner anyway.
- **422 "already been taken" = SUCCESS** (already suppressed). This is the idempotency mechanism —
  no need to pre-check the remote list.
- **Add-only, never read the remote list** (confirmed by product decision — see §9). So the
  expensive `per_page`=15 LIST and the unreliable `?search=` never touch the hot path. The write
  path is purely watermark-driven: push `dnc_entries` newer than `suppressed_through`, tolerate 422.

---

## Part 2 — How current DNC works (and the hook points)

(Full detail lives in `PHONEBURNER_DNC_PURGE_PLAN.md` + the code; this is the integration-relevant slice.)

- **Ingestion → `dnc_entries`.** Two paths both land normalized rows in `dnc_entries`
  (`email` lowercased, `phone_e164`, `domain` bare/free-filtered), with `created_at` as the **load-bearing
  watermark** (preserved on unchanged rows by `dncService.diffSourceEntries`, `src/services/dnc.service.ts:151`):
  1. **HubSpot lists** — `dnc-sync.service.ts` (`discoverClient` → `syncHubspotSource` → `buildEntries`),
     3-tier change detection; domain-classified lists also emit corporate-domain entries.
  2. **Direct import** — `POST /admin/dnc/import` (`dnc.controller.ts:390`, `importCsv`).
  Both bump `Client.dnc_changed_at`.
- **The purge choke point** every trigger funnels through is `runPurge()`
  (`src/services/phoneburner-purge.service.ts:1002`). Per client it calls `loadDncSets(clientId)`
  (line 178 → `{emails, phones, domains}` Sets) and, for incremental runs, the new-entries query
  (line 564: `dnc_entries where created_at > watermark`).
- **Triggers:** `npm run ops:daily` (`src/scripts/ops-daily.ts` — discover+sync, then purge) and the
  optional hourly `src/scheduler.ts` detector (`runPurge({mode:"targeted"})`).
- **Token pattern (critical):** ttt-api-service **never stores provider secrets.** PhoneBurner PATs
  are fetched at runtime from **GTMOS** `GET /api/internal/phoneburner-tokens` (header `X-Internal-Secret`),
  cached 15 min (`phoneburner-token.service.ts` + `sdr-launch.service.ts`). Encryption lives in GTMOS.

**Where EmailBison hooks in:** as a **sibling provider** invoked right after `runPurge` in
`ops-daily.ts` (batch) and after the targeted purge in `scheduler.ts:tick` (incremental). It reads the
same `dnc_entries` (per client, watermarked) — no new trigger, no event bus. Because suppression is
*add-only to a durable list*, it does **not** touch PhoneBurner's identity index, full-scan, ratio
ceiling, or shared-book guard.

---

## Part 3 — Target architecture

```
 HubSpot DNC list  ─┐                          ┌─► PhoneBurner purge (delete)   [existing]
                    ├─► dnc_entries (watermark) ┤
 POST /admin/dnc/…  ─┘   created_at            └─► EmailBison suppress (blocklist add)  [NEW]
                                                       │
                                    per client → EmailbisonWorkspace(s) → workspace key (from GTMOS)
                                                       │
                                    POST /api/blacklisted-emails/bulk   (+ /blacklisted-domains/bulk)
```

Introduce a light **suppression-provider** shape so PhoneBurner and EmailBison are peers rather than
EmailBison being bolted onto the PB path (wrong granularity — PB is per-SDR-book, EmailBison is
per-workspace):

```ts
interface SuppressionProvider {
  name: "phoneburner" | "emailbison";
  suppressClient(client, opts): Promise<ClientSuppressSummary>;
}
```
v1 can keep it pragmatic: a standalone `runEmailbisonSuppress(opts, onlySlug?)` mirroring `runPurge`,
called as "Phase 3" in `ops-daily.ts`. Refactor PhoneBurner behind the same interface later if desired.

---

## Part 4 — Key sharing (GTMOS → ttt-api-service)

**Mirror the PhoneBurner token pattern exactly — do not duplicate keys into this DB.** GTMOS already
holds the per-workspace EmailBison keys pgcrypto-encrypted (`eb_workspaces.api_key_encrypted`,
`lib/emailbison/token-store.ts`, key = `EMAILBISON_TOKEN_ENC_KEY`).

1. **GTMOS:** add `app/api/internal/emailbison-tokens/route.ts` — a clone of
   `app/api/internal/phoneburner-tokens/route.ts`. Auth via the same `X-Internal-Secret`
   (`SDR_LAUNCH_INTERNAL_SECRET`). Returns decrypted keys keyed by `workspace_id`
   (e.g. `{ "21": "21|abc…", "27": "27|def…" }`), optionally filterable by `?client=`. Reuse
   `token-store.ts`'s reveal/decrypt (`pgp_sym_decrypt` with the env key). Never logs plaintext.
2. **ttt-api-service:** add `src/services/emailbison-token.service.ts` mirroring
   `phoneburner-token.service.ts` — `getWorkspaceKey(workspaceId)` → fetch from
   `GET {SDR_LAUNCH_INTERNAL_URL}/api/internal/emailbison-tokens` (`X-Internal-Secret`), 15-min cache,
   re-pull on 401, `skipped_no_key` (not error) on miss.

Result: the plaintext keys live in **one** place (GTMOS, encrypted); ttt-api-service holds only
short-lived in-memory copies. Consistent with the HubSpot/PhoneBurner invariant. The local CSV
(`kai-emails-process/Bison-API-Keys-*.csv`) remains only the re-seed source for GTMOS and should move
to 1Password.

---

## Part 5 — Data model (Prisma)

Add one model mirroring `PhoneburnerMember` (client → provider account map + per-account watermark):

```prisma
model EmailbisonWorkspace {
  id                  String    @id @default(uuid())
  client              Client    @relation(fields: [client_id], references: [id])
  client_id           String
  workspace_id        Int                       // EmailBison integer workspace id
  workspace_name      String?
  active              Boolean   @default(true)
  suppressed_through  DateTime?                  // watermark: dnc_entries.created_at processed
  emails_suppressed   Int       @default(0)      // running counters (audit)
  domains_suppressed  Int       @default(0)
  last_run_at         DateTime?
  last_run_status     String?
  created_at          DateTime  @default(now())
  updated_at          DateTime  @updatedAt
  @@unique([client_id, workspace_id])
  @@map("emailbison_workspaces")
}
```
Optional (audit parity with `PhoneburnerDeletion`): `EmailbisonSuppression { workspace_id, type, value,
provider_id?, status, run_id, created_at }` — recommended so we can prove what we pushed and reconcile.

No identity index / no deletion-snapshot table needed (add-only to a durable remote list).

---

## Part 6 — The suppression service (flow)

`runEmailbisonSuppress(opts, onlySlug?)` — parallel to `runPurge`:

1. Load active clients that have an active `EmailbisonWorkspace` (optionally one slug).
2. Per client → per workspace:
   a. **New identifiers since watermark:** `dnc_entries where client_id = X and created_at >
      workspace.suppressed_through` → split into `emails` (email not null) and `domains` (domain not null).
      (First run: `suppressed_through` is null → backfill the whole client DNC set via `loadDncSets`.)
   b. Resolve the workspace key (`emailbison-token.service`). No key → `skipped_no_key`, continue.
   c. **Single POST per identifier** (bulk 500s — P0), bounded concurrency ~5–10 + retry/backoff:
      `POST /api/blacklisted-emails {email}` and `POST /api/blacklisted-domains {domain}`. Classify
      each: **201 = added**, **422 "already been taken" = already_present (success)**, other = failed.
   d. Record `EmailbisonSuppression` rows (status `added|already_present|failed|dry_run`); bump counters.
   e. **Advance `suppressed_through`** to the max `created_at` processed — *only on a clean run with
      zero `failed`* (`already_present` is fine; mirrors PB's `dnc_processed_through` discipline).
      Set `last_run_at/status`.
3. Slack summary via the existing `src/services/slack-alert.ts` to `#gtmos-ops-alerts` (only on
   failures — reuse the ratio-alert plumbing shape).

**Idempotency / dedup:** the watermark guarantees we never re-push an already-processed entry, and the
API's **422 "already been taken"** makes any accidental re-push a no-op success. So we **never LIST the
(huge, `per_page`=15) remote blocklist** on the hot path — the write path is purely watermark-driven +
422-tolerant. (P0 confirmed 422 behavior live.)

**`--dry-run` + `--only <slug>`** flags like the PB purge, for safe rollout.

---

## Part 7 — Trigger integration (no new trigger)

- **Batch:** `src/scripts/ops-daily.ts` — add **Phase 3** after `runPurge` (line ~140):
  `await runEmailbisonSuppress({ mode: "auto" })`. Same client loop / env-assert pattern.
- **Incremental:** `src/scheduler.ts` tick (after `runPurge({mode:"targeted"})`, line ~48):
  `await runEmailbisonSuppress({ mode: "targeted" })` so the hourly detector also drives email
  suppression for just-changed clients.
- **On-demand:** `POST /admin/emailbison/suppress` (+ `?client=`, `?dryRun=`) in a controller mirroring
  `phoneburner.controller.ts`, wired in `src/routes.ts`.

Net effect: a HubSpot-list add or an `/admin/dnc/import` flows into `dnc_entries`, and the next
daily/hourly pass suppresses those identifiers in EmailBison automatically — exactly the requested
behavior.

---

## Part 8 — Bootstrap / mapping (client → workspace)

- Add `src/scripts/bootstrap-emailbison.ts` (mirror `bootstrap-phoneburner.ts`) to populate
  `emailbison_workspaces` from GTMOS (the crosswalk `clients.config.emailbison_workspace_id` /
  `eb_workspaces.client_id` already maps client↔workspace). Extend `clients:generate` /
  `data/clients.json` (`RegistryClient`) with an `emailbison_workspaces` field if we want it in the
  registry like PhoneBurner.
- Most clients are **1 workspace : 1 client** today, but the model supports 1:many.
- Unlike PhoneBurner, workspaces are strictly per-client → **no shared-book / cross-tenant guard
  needed.** A client's DNC set is suppressed only in that client's own workspace(s).

---

## Part 9 — Edge cases & open decisions

1. **Un-DNC (removal). DECIDED — add-only, no reconciliation.** Once an identifier is suppressed it
   stays on the EmailBison blocklist; we never read the list to detect removals. (Product decision
   2026-07-27.) This is what keeps the service simple: no LIST/search, no value→id lookups, pure
   watermark-forward + 422-tolerant adds. Removal, if ever needed, is a manual/tooling action.
2. **Bulk batch size + rate limits.** Unknown; start at ~200/request with retry/backoff (reuse the
   sync client's retry). Tune after a live test.
3. **First-run backfill volume.** Some workspaces already have huge blocklists (Scantron 235k). The
   first backfill pushes the client's *current DNC set* (not the whole HubSpot audience) — modest — but
   many will already be present. Rely on duplicate-tolerant add (decision from §6).
4. **Domain vs email precedence.** DNC already emits both an email entry and (for domain-level lists) a
   corporate-domain entry; push each to its matching resource. No dedup between the two needed.
5. **Verify ADD/BULK payloads live** (one throwaway address) before the first real run — the shapes are
   inferred from `emailbison-cli`, not observed.
6. **Provider-interface refactor** of PhoneBurner is optional; v1 ships EmailBison as a standalone
   sibling pass.

---

## Part 10 — Build phases

- [ ] **P0 — Verify API.** One live POST of an email + a domain to a throwaway/test workspace;
      confirm add payload, duplicate behavior, and that a send is actually blocked. Confirm bulk shape.
- [ ] **P1 — Key sharing.** GTMOS `/api/internal/emailbison-tokens` route (clone phoneburner-tokens) +
      ttt-api-service `emailbison-token.service.ts`.
- [ ] **P2 — Data model.** `EmailbisonWorkspace` (+ optional `EmailbisonSuppression`) migration;
      `bootstrap-emailbison.ts` from the GTMOS crosswalk.
- [ ] **P3 — Client + service.** `emailbison.service.ts` (REST client: bulk-add emails/domains, list),
      `emailbison-suppress.service.ts` (`runEmailbisonSuppress`, watermark, batching, audit, Slack).
- [ ] **P4 — Triggers.** `ops-daily.ts` Phase 3 + `scheduler.ts` tick + `POST /admin/emailbison/suppress`.
- [ ] **P5 — Rollout.** `--dry-run` on one pilot client (e.g. RedDrop/Bridge-it) → verify counts vs its
      DNC set → live → enable in `ops:daily` for all.

---

### Reference index
- EmailBison blocklist API — Part 1 (`/api/blacklisted-emails`, `/api/blacklisted-domains`).
- Current DNC choke point — `phoneburner-purge.service.ts:1002` (`runPurge`), `loadDncSets` :178,
  new-entries watermark :564.
- Ingestion — `dnc-sync.service.ts`, `dnc.controller.ts:390`, `dnc.service.ts:151`.
- Token pattern to mirror — `phoneburner-token.service.ts` + `sdr-launch.service.ts`;
  GTMOS `app/api/internal/phoneburner-tokens/route.ts` + `lib/emailbison/token-store.ts`.
- Triggers — `ops-daily.ts`, `scheduler.ts`.
