# Security & Compliance Plan — TTT-api-service

**Status:** planned (not built) · **Date:** 2026-08-05 · **Owner:** Javier
**Driver:** an education-sector client's legal review rejected two vendors on *data-use* grounds.
TTT's answer is a bespoke DPA rather than SOC 2 — but the DPA is only signable if the software backs
each clause. This service holds the client-provided suppression data, so it carries most of the
processor obligations. GTMOS's half is `gtmos/docs/pending/32-security-and-compliance-hardening.md`.

**Companion documents** (workspace root `Compliance/`): `DPA Framework.md` (clause numbers used
throughout), `Engineering Remediation Plan.md` (R-numbers), `GDPR & EU Reference.md`,
`Security Standards & Buyer Instruments.md`.

> **Rule: no clause ships in the DPA before its item here is merged.** Each section names the clause
> it unblocks. A signed promise the code does not keep is worse than no promise.

---

## 0. Why this service carries the weight

Clients hand us a Do-Not-Contact list — emails, phones, domains — and we store it (`dnc_entries`),
re-sync it from their HubSpot lists, and push suppressions into PhoneBurner and EmailBison. That is
**processing personal data on the client's documented instruction**, which makes TTT a processor and
this service the system of record for the obligation.

Two properties are already strong and worth protecting:

- ✅ **No provider secrets at rest here.** PhoneBurner PATs and EmailBison keys are fetched at
  runtime from GTMOS over an internal-secret channel and held in memory only; GTMOS stores them
  pgcrypto-encrypted. Compromising this service does not yield dialer credentials.
- ✅ **Suppression matching is deterministic.** Normalize (email lowercase, phone → E.164, domain
  stripped of protocol/`www`) then exact match. **No model is involved anywhere in the DNC path** —
  which lets us make the strongest possible version of clause 3.

## 1. Current state — verified against the code

| Finding | Evidence | Consequence |
|---|---|---|
| ❌ **Every DNC route sits behind one shared static key** | `src/middleware/auth.middleware.ts:17`; routes `src/routes.ts:31-42` | No per-person attribution. "Who accessed our teachers' data?" is unanswerable |
| ✅ Per-user identity middleware already exists | `src/middleware/identity.middleware.ts` — `requireIdentity`, `canAccessSlug`, introspects GTMOS `sdr_live_…` via `src/services/sdr-launch.service.ts:136` | **Wired to exactly one route** (`routes.ts:56`). §2 is wiring, not building |
| ❌ **No access log** | none | Clause 12 evidence and incident scoping both fail |
| ❌ **Ingest persists more than the identifier** | `prisma/schema.prisma:360` — `data Json` documented as holding "extra context (hubspot contact id, raw row, etc)" | A CSV import can persist whole source rows. Minimization gap |
| ⚠️ **Identity cache is pooled across tenants** | `profiles` / `companies` are global, not per-client | The § 7051(a)(4) problem — see §6 |
| ⚠️ **AI endpoints live in this service** | `/relevance-score`, fit scoring | So "this service uses no AI" is **false**. The defensible claim is a *module boundary* — see §5 |
| ⚠️ Introspection is uncached | `sdr-launch.service.ts:136` does a live round trip | **Keep it that way** — see §2 |

---

## 2. Per-user authentication on DNC routes (unblocks clause 9)

Three caller classes, explicitly separated:

| Caller class | Auth required | Actor recorded |
|---|---|---|
| **Human / interactive** — all `/admin/dnc/*`, imports, list management, ad-hoc checks | named service key **+** `X-User-Token` (`sdr_live_…`), `requireIdentity` | `user:<uuid>` + email |
| **Machine / automation** — `ops:daily`, hourly scheduler, Clay-driven `/dnc-check` | named service key only (§3) | `service:<name>` |
| **Break-glass** — `global` superadmin acting outside assigned clients | as human, plus higher-severity log | `user:<uuid>`, `global=true` |

Enforce `canAccessSlug(identity, slug)` on every client-scoped route so an engineer cannot read a
customer they are not assigned to. Reuse GTMOS's existing model (`role='manager'` +
`user_client_access`; `users.user_type` already has `gtm_engineer`) rather than inventing a second one.

> ⚠️ **Do not cache introspection.** It is a live round trip today, so revocation and offboarding
> take effect immediately. `emailbison-token.service` and the PhoneBurner token service cache for 15
> minutes — **do not copy that pattern here**; the cache window is exactly the window in which a
> revoked engineer keeps access. If load ever demands it, cap at 60s and document it.

**Acceptance:** no `X-User-Token` on a human route → 401; revoked or disabled user's token → 401;
unassigned client slug → 403; cron paths keep running unattended.

## 3. Named service principals (unblocks clause 9)

One `API_KEY` currently serves the cron, the scheduler, Clay, internal tools, and any human with the
env var. It cannot be rotated without breaking everything at once, and it makes §4's `actor` column
meaningless for machine callers.

Add a `service_keys` table (`name`, `key_hash`, `scopes`, `status`, `created_at`, `last_used_at`),
hashed at rest, resolving to a named principal. Smaller first step if needed: discrete env keys
(`API_KEY_CRON`, `API_KEY_CLAY`, `API_KEY_INTERNAL`). Accept the legacy key for one deploy with a
loud log line, then remove it.

## 4. DNC access log (unblocks clauses 9 and 12)

Append-only `dnc_access_log` **local to this service** — logging must not depend on a network hop to
GTMOS, or it fails open.

Columns: `actor` (`user:<uuid>` / `service:<name>`), `actor_email`, `client_id`, `action`
(`check` | `import` | `sync` | `export` | `list` | `purge` | `suppress`), `route`,
`identifier_count`, `global_override`, `ip`, `created_at`.

**Log counts, never identifiers.** An audit table full of suppression-list emails defeats its own
purpose. Mirror GTMOS's `writeAuditLog` pattern: typed action union, failures swallowed so auditing
never breaks the action.

## 5. Data minimization and the AI module boundary (unblocks clauses 3 and 7)

**5.1 — Allowlist what `DncEntry.data` may hold**: source record id, reason code, source type.
Strip everything else at ingest in `dnc.service.ts` / `dnc.controller.ts` `importCsv`, and prune
existing rows to the allowlist.

> ⚠️ **Preserve `created_at`.** It is the load-bearing purge watermark (`dnc.service.ts:151`
> `diffSourceEntries`). **Never delete-and-reinsert.**

**Acceptance:** import a CSV with 20 extra columns; only allowlisted keys persist; watermark
unchanged; the PhoneBurner purge still no-ops correctly afterward.

**5.2 — Enforce the no-model boundary with a test.** The DNC path is deterministic today, but the
same service hosts `/relevance-score` and fit scoring, which do call models. Add a test asserting
that no module reachable from `dnc.service`, `dnc-sync.service`, `phoneburner-purge.service`, or
`emailbison-suppress.service` transitively imports an AI SDK or scoring module. Record the invariant
in a short ADR so a future "smart matching" feature cannot silently break a contractual promise.

**5.3 — Assert Serper isolation.** `google.serper.dev` serves the LinkedIn-finder route and must
never see suppression data. Confirm in code and add a test, so the subprocessor register's
"receives none" claim is enforced rather than assumed.

## 6. Tenant isolation of the identity cache (unblocks clause 4)

**This is the hardest item in this plan and it is a design decision, not a refactor.**

`profiles` and `companies` are a **global** cache: a record enriched while working Client A is
available when working Client B. Three independent authorities treat that as a problem:

- **11 CCR § 7051(a)(4)** expressly prohibits a service provider from combining personal information
  from one client with PI "received from another source" — and § 7050(a)(3)'s illustrative example
  is an **email-marketing service provider**. Under § 7050(e), losing service-provider status turns
  every client transfer into a **"sale."** CalPrivacy's *ROR Partners* order (2025-12-03) already
  rejected the bundled-services defense: *"A sale is a sale."*
- **GDPR Art. 28(10)** — a processor that determines its own purposes becomes a **controller**. The
  EDPB's canonical example (Guidelines 07/2020 §81, "MarketinZ") is a marketing agency reusing a
  client's database for its own business.
- **HECVAT `DRPV-13`** asks this question directly, naming marketing and data brokers.

**The distinction that decides it:** data TTT sourced independently (Clay, Starbridge) is *our*
corpus and may legitimately be pooled — we are controller of it. Data a **client gave us** must not
enrich that corpus or any other client's work. Today the schema does not draw that line.

**Required:** add provenance to `profiles`/`companies` recording **which client's data, if any, a
record or field originated from**, and exclude client-originated records from cross-client reads.
Suppression entries are already `client_id`-scoped — that part is fine.

**6.1 — Honour the per-client mode. DECIDED 2026-08-05.** GTMOS now carries `ai_learning_mode`
(`pooled` | `isolated`) per client, exposed on `/api/internal/clients` — see
`gtmos/docs/pending/32-security-and-compliance-hardening.md` §5.1. This service must:

- **Never contribute** an `isolated` client's records to the shared `profiles`/`companies` cache;
  keep them in a client-scoped partition.
- **Never serve** an `isolated` client from records originating with another client. Records TTT
  sourced itself (Clay, Starbridge) remain available to everyone — that is our corpus, not theirs.
- **Support withdrawal:** a `pooled → isolated` transition must purge that client's contributed
  records from the shared cache within the DPA's 30-day window and report completion back to GTMOS
  for `ai_learning_purged_at`.

**Acceptance:** fixture test with one `isolated` and two `pooled` clients — the isolated client
contributes nothing to the shared cache and a resolution performed on their behalf returns no
record whose provenance is another client.

## 7. Consume and enforce the per-client compliance flags (unblocks clauses 2, 3, 6, 8)

GTMOS §4 adds compliance columns and exposes them on `/api/internal/clients`. Here:

1. Extend `SdrLaunchClient` in `src/services/sdr-launch.service.ts:22` with the new fields.
2. **Enforce `approved_subprocessors` before egress** — if a client has objected to EmailBison or
   PhoneBurner, `runEmailbisonSuppress` and `runPurge` must skip that client and say so in the run
   summary. Clause 6 gives clients a right to object; the right is meaningless if unenforced.
3. Gate `/relevance-score` and fit scoring on `ai_processing_allowed`.
4. Cache the roster no longer than the existing refresh cycle; a flag flip must take effect the same
   day.

## 8. Per-record provenance (unblocks GDPR Art. 14(2)(f))

Art. 14(2)(f) requires disclosing "from which source the personal data originate" **for that
record**. Store, per profile/company: source vendor, ingestion run, and date — and **never overwrite
it on re-enrichment**; append instead. If provenance is lost, compliance is impossible.

This is compatible with §5.1: keep the source *identifier*, strip the *payload*.

## 9. Retention and destruction (unblocks clause 10)

**9.1 — On `deletion_requested_at`**, purge that client's `dnc_entries`, `dnc_sources`,
`phoneburner_contact_index` rows, EmailBison suppression audit rows, `emailbison_workspaces` row,
and any client-originated profile/company records (§6). Dry-run by default, consistent with every
other destructive path here.

**9.2 — ⚠️ Carve out the suppression list.** GDPR **Art. 28(3)(g)** requires deleting all personal
data at termination — which would force us to delete the very list that stops us contacting people
who opted out. The DPA must expressly carve it out, and this service must honour the carve-out:
retain suppression identifiers (hashed where practical), delete the surrounding context.

**9.3 — Deletion certificate**: per-table counts, timestamp, actor, and what intentionally survives.

> ⚠️ **Never describe this as NIST 800-88 "destruction."** SP 800-88r2 (Sept 2025) states *Destroy*
> applies to all media **"except for logical/virtual storage"**, and for cloud storage cryptographic
> erase may be the only viable Purge option — with keys we do not hold. Promise logical deletion,
> enumerated backup expiry, and subprocessor propagation.

**9.4 — Measure the backups.** Document this project's Neon region and PITR window before any
retention clause is drafted. ⚠️ Neon PITR can be up to 30 days; a flat "30 days including backups"
promise may be false.

## 10. Database and infrastructure posture

| Item | Required |
|---|---|
| **Least-privilege DB role** | The app connects as table owner. Create a restricted application role; reserve owner for migrations |
| **Row-level security** | Not present anywhere. Consider RLS on `dnc_entries` scoped by `client_id` as defense in depth — **but the query layer remains the enforcement point**; RLS does not apply to a table owner |
| **Residency** | Record the Neon and Railway regions in the DPA's Annex II. US where teacher PII is in scope |
| **Encryption at rest** | Confirm and document for both |
| **Key rotation** | Cadence for the internal secret and the new service keys; revocation on offboarding |
| ⚠️ **`.env` points at PROD** | Already flagged in `CLAUDE.md`. Keep `prisma db push` additive-only; test with a throwaway tenant |

## 11. Sequencing

| Phase | Items |
|---|---|
| **Week 1** | §2 + §3 + §4 as one auth-and-audit change · §5.1 minimization · §5.2/§5.3 boundary tests |
| **Week 2** | §7 flag consumption and enforcement · §10 residency and role hardening |
| **Weeks 3–4** | §9 retention/destruction · §9.4 backup measurement · §8 provenance |
| **Blocked on a business decision** | §6 tenant isolation — blocks DPA clause 4 |

## 12. Open decisions

1. ✅ **RESOLVED 2026-08-05 — tiered per client** (§6.1). Client-originated records are partitioned
   for `isolated` clients; TTT-sourced records stay shared. Withdrawal purge required.
2. **`/dnc-check` caller class** — automation, humans, or both? Determines its auth tier.
3. **Service keys: table or discrete env keys** as the first step?
4. **Suppression-list retention after termination** — indefinite (safest for the data subject) or
   bounded? Decide before drafting clause 10.
