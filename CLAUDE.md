# CLAUDE.md — TTT-api-service (Identity Cache & Enrichment + DNC)

**This is a standalone git repo** (nested inside the `ops-projects` workspace). This dir is the git
root — never let a parent-level `git add`/`commit` reach in here.

Two responsibilities:
1. **Identity Cache & Enrichment API** — ingest/normalize/resolve Profiles & Companies
   (email > LinkedIn URL > slug > phone; domain > LinkedIn), safe JSON merging, LinkedIn finder via SERP.
2. **Multi-tenant Do Not Contact (DNC)** — per-client (`client_id`) suppression on email/phone/domain,
   sourced from CSV uploads + HubSpot lists (re-synced on schedule) + the **PhoneBurner DNC-purge**.

Stack: **Prisma + Neon (Postgres)**, TypeScript. `⚠️ .env DATABASE_URL points at PROD` — `prisma db
push` is additive/safe but test with a throwaway tenant; never run destructive ops against prod.

## Commands
```bash
npm run dev              # prisma generate + db push + nodemon
npm run build && npm start
npm run prisma:studio    # inspect DB
npm run dnc:sync         # re-sync DNC from HubSpot lists
npm run pb:purge         # PhoneBurner DNC purge (HARD 30% ceiling — aborts + Slack-alerts if exceeded)
npm run ops:daily        # daily cron: change-detect DNC sync + targeted PB deletes
npm test                 # vitest run
```

## Key specs (read before changing behavior)
`LOGIC_SPEC.md`, `DNC_MULTITENANT_PLAN.md`, `PHONEBURNER_DNC_PURGE_PLAN.md`,
`MEETING_PROTECTION_PLAN.md`, `IMPROVEMENTS.md`, `SKILL-phoneburner-list.md`.

## Gotchas (see workspace `memory/`)
- PhoneBurner REST API **cannot set DNC** — only browser-replay / UI CSV import.
- `clients:generate` can create duplicate clients on slug divergence (e.g. `bridge-it` vs `bridgeit`).
- DNC drives **two channels**: the PhoneBurner purge (call) **and** EmailBison blocklist suppression
  (email — `emailbison-suppress.service`, gated `EMAILBISON_SUPPRESS_ENABLED`, add-only). Both feed off
  the same `dnc_entries` watermark; EmailBison keys come from GTMOS, never stored here.
- Standard workspace rules apply (see root `CLAUDE.md`): live data, confirm destructive ops.
