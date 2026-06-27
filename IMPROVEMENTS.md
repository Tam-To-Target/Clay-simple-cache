# Production-hardening + PhoneBurner DNC purge — `feature/pb-dnc-purge-prod`

This branch makes clay-simple-cache production-grade (no data loss, secure/simple
endpoints, automatic DNC on any provisioned customer) and implements the
PhoneBurner DNC purge spec (`PHONEBURNER_DNC_PURGE_PLAN.md`). All HubSpot and
PhoneBurner integrations are exercised by mocked tests — **no real customer data
is touched** (PhoneBurner deletes default to dry-run; the suite never hits a live
API). It branches from `main`; merge only after review.

## 1. Code-review fixes (from the prior review)

| # | Fix | Where |
|---|---|---|
| Provenance clobber | DNC-check no longer overwrites push attribution. Each writer owns a namespaced key: pushes write `last_push`, checks write `last_dnc_check`. | `controllers/hubspot.controller.ts`, `controllers/dnc.controller.ts` |
| No data loss | `recordProfile` resolves **all** profiles owning any provided key (one OR query) and merges the data into every one, so a record stays reachable by any key even when identity is split across rows by the unique constraints. A key is filled only when no other matched row owns it (no cross-profile unique collision). | `services/profile.service.ts` |
| Silent cache failures | All swallowed cache errors are now logged. | `services/profile.service.ts` |
| Token refresh | `withRetry` allows up to 3 forced 401 refreshes, so a token that expires more than once over a long paged sync still recovers (was capped at 1). | `services/http-retry.ts` |
| Duplicated fetch policy | Throttle + 401-refresh + 429/5xx-retry extracted to one shared `withRetry`; `hsFetch` refactored onto it (was a second copy). | `services/http-retry.ts`, `services/hubspot-lists.service.ts` |

## 2. Security / robustness

- **Constant-time API-key compare** (`crypto.timingSafeEqual` over SHA-256) so the
  bearer key can't be recovered via timing. — `middleware/auth.middleware.ts`
- **Bounded request bodies** (`express.json({ limit: JSON_BODY_LIMIT })`, default
  10 mb) — generous for CSV DNC imports, capped against memory exhaustion. — `app.ts`
- **Revoked-access resilience** (shipped earlier on main, carried here): a client
  losing HubSpot access is a non-fatal `no_access` skip, not a red cron.

## 3. PhoneBurner DNC purge (new feature — Option B)

SDRs dial out of PhoneBurner, which doesn't read our DNC list. A daily job deletes
every PhoneBurner contact that collides with the client's cached DNC list.

**New schema** (additive): `phoneburner_members`, `phoneburner_deletions`
(full pre-delete snapshot — re-importable backup + audit), `phoneburner_purge_runs`.

**New services**
- `http-retry.ts` — shared throttle + retry (above).
- `phoneburner-token.service.ts` — one durable admin token → per-member bearer
  tokens, cached for the run, re-pulled near expiry. **Tokens never persisted.**
- `phoneburner.service.ts` — `pbFetch` (User-Agent required), paged
  `fetchMemberContacts`, idempotent `deletePbContact`; `PhoneburnerAccessError`
  for members without API Access.
- `phoneburner-purge.service.ts` — load the client's DNC sets from `dnc_entries`,
  full-scan each member's book, collide in memory (email / phone / domain) using
  the **same normalization** that built `dnc_entries` (match parity), apply the
  ratio gate, back up + delete, and record per-member / per-client / per-run.

**Entry points**
- `npm run clients:generate` — now also maps client → PhoneBurner members via the
  SDR Launch join (`calls` → `sdrs.provider_user_ids.phoneburner`, recent window).
- `npm run pb:bootstrap [slug]` — load that map into `phoneburner_members`.
- `npm run pb:purge [slug] [--dry-run|--execute]` — the daily job (fail-fast env).
- `POST /admin/phoneburner/purge { client_id?, dry_run? }` — on-demand trigger.

**Safety rails (all enforced):** dry-run by default; backup-before-delete;
collision-ratio gate (`PB_PURGE_MAX_RATIO`, default 0.40); optional per-run delete
cap (`PB_PURGE_MAX_DELETES_PER_RUN`); idempotent deletes; runs **after** `dnc:sync`;
per-member failures never abort the run.

**Cron (Railway), sequential daily:**
```
npm run dnc:sync && npm run pb:purge
```

## 4. Tests

176 tests (+42 on this branch), all mocked — no live PhoneBurner / HubSpot calls,
no customer-data side effects:
- `http-retry` — 401-refresh bound, 429/5xx backoff + Retry-After, throttle ordering.
- `phoneburner` — contact parsing, paging, 403 → access error, idempotent delete.
- `phoneburner-purge` — collide parity (incl. free-provider domains excluded),
  dry-run vs live, ratio gate, failed-delete handling, `loadDncSets`, options.
- endpoint — auth, missing-admin-token, 404 + suggestions, dry-run passthrough.
- `recordProfile` — no-op, create, split-identity merge (no data loss), race recovery.
- auth — length-mismatch / empty-token rejection.

## 5. Configuration (see `.env.example`)

New: `JSON_BODY_LIMIT`, `PB_MAP_CALL_WINDOW_DAYS`, `PHONEBURNER_ADMIN_TOKEN`,
`PHONEBURNER_API_BASE`, `PHONEBURNER_USER_AGENT`, `PB_PURGE_DRY_RUN` (default true),
`PB_PURGE_MAX_RATIO`, `PB_PURGE_INCLUDE_DOMAINS`, `PB_PURGE_MAX_DELETES_PER_RUN`.

## 6. Branch code-review fixes (round 2)

A high-effort review of this branch surfaced and we fixed:

- **Cross-tenant deletion (shared PhoneBurner book).** A member who dials for
  multiple clients has ONE book; the purge now deletes a contact only when it is
  suppressed by **every** client that member serves (`guardSets` in `purgeMember`,
  built from a cross-client serving map in `runPurge`). A contact on client A's
  DNC that is still a live lead for client B is kept (`protected_other_client`).
- **Member `active` from the wrong source.** `pb:bootstrap` now sets `active`
  from the recent-call mapping (why the member is in the registry), not the SDR's
  global SDR-Launch status — closes a DNC-coverage gap. Genuinely-off SDRs drop
  out of the call window; API-Access-off members are skipped at runtime.
- **Profile sibling clobber.** `recordProfile` now full-merges only the primary
  row; sibling rows get a fill-only merge (keep their values, gain missing keys)
  so a row the caller didn't target is never overwritten.
- **Provenance shape regression.** Push attribution stays as **flat** keys
  (`source`/`client_id`/`hubspot_portal_id`/`hubspot_contact_id`/`pushed_at`) —
  unchanged for downstream consumers; `/dnc-check` writes a **disjoint** flat set
  (`dnc_status`/`dnc_client_id`/`dnc_checked_at`) so neither clobbers the other.
- **Retry budget.** `withRetry` 401-refreshes and 429/5xx retries now use
  separate budgets, so token expiries can't exhaust the transient-error retries.
- **Pagination truncation.** `fetchMemberContacts` paginates authoritatively on
  `total_pages` (an empty middle page no longer truncates the scan), falls back
  to short-page detection, and has a hard page bound.
- **Dry-run audit dedup.** Repeated dry-runs clear the prior dry-run's audit rows
  for the targeted clients instead of accumulating duplicates.

Documented tradeoffs (kept by design, layered behind dry-run + rollout):
- The **40% ratio gate** blocks a *mass* mis-delete but not a sub-threshold one;
  the layered defense is dry-run-by-default → review `phoneburner_deletions` →
  enable per client, plus the optional `PB_PURGE_MAX_DELETES_PER_RUN` breaker.
- **Domain matching is on by default** but only uses domains a client explicitly
  put on a `(Domain)` DNC list (free/disposable-filtered); disable with
  `PB_PURGE_INCLUDE_DOMAINS=false`.

## 7. Open items before enabling live PhoneBurner deletes

1. **`PHONEBURNER_ADMIN_TOKEN` lifecycle** (`PHONEBURNER_DNC_PURGE_PLAN.md` §7/§11):
   long-lived admin token vs. an OAuth-refresh helper. Blocker for go-live.
2. **Per-SDR API Access** must be enabled in PhoneBurner (else the member is
   skipped as `skipped_no_access`).
3. **Rollout**: first prod runs dry-run, verify `phoneburner_deletions`, then flip
   `PB_PURGE_DRY_RUN=false` for one client, then expand.
