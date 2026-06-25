# Identity Cache & Enrichment API

Service to ingest, normalize, and enrich identity data (Profiles & Companies). It allows upserting records based on normalized keys and merging data into a unified record, plus a multi-tenant **Do Not Contact** suppression service backed by HubSpot lists.

## Features
- **Profiles**:
  - Normalization: Email, LinkedIn (Slug & Full URL), Phone.
  - Resolution: Email > LinkedIn URL > LinkedIn Slug > Phone.
- **Companies**:
  - Normalization: Domain (trim, lowercase, remove www/protocol), LinkedIn.
  - Resolution: Domain > LinkedIn.
- **Do Not Contact (DNC)**:
  - Multi-tenant suppression — each client (`client_id`) has its own DNC list.
  - Matches on email, phone (E.164), or domain (domain entries block a whole company).
  - DNC data sourced from CSV uploads and HubSpot lists; HubSpot lists are re-synced on a schedule.
  - If a contact is suppressed, the check returns the reason/source and withholds contact data; otherwise it returns the contact's cached profile.
- **LinkedIn Finder**:
  - Given a domain, finds the company's LinkedIn page via SERP lookup.
- **Data Merging**: Merges JSON data safely.
- **ORM**: Builds on **Prisma** + **Neon** (PostgreSQL).

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Environment Variables**:
   Copy `.env.example` to `.env` and add your keys:
   ```bash
   cp .env.example .env
   ```

   Required variables:
   - `PORT`: Server port (default 3000)
   - `API_KEY`: Bearer token for authentication
   - `DATABASE_URL`: Neon Postgres connection string (`sslmode=require`)
   - `SERPER_API_KEY`: SERP lookups for the LinkedIn finder (google.serper.dev)
   - `HUBSPOT_TOKES_DATABASE_URL`: tokens DB (portal IDs of installed HubSpot apps)
   - `HUBSPOT_PROVISIONER_URL` / `HUBSPOT_PROVISIONER_API_SECRET`: resolve+refresh HubSpot tokens per portal
   - `DNC_LIST_NAME_PREFIX`: DNC list name to discover (default `TAM - Do Not Contact`)

3. **Database Setup**:
   Push the schema to your database:
   ```bash
   npm run prisma:push
   ```

## Usage

**Start Development Server**:
```bash
npm run dev
```

**Production Build**:
```bash
npm run build
npm start
```

**API Endpoints**:

See full documentation at `GET /docs/api` or visit `http://localhost:3000/docs/api` locally.

- **Profiles**
  - `POST /profiles`: Upsert/Enrich a profile.
  - `GET /profiles`: Query by `email`, `linkedin`, or `phone`.

- **Companies**
  - `POST /companies`: Upsert/Enrich a company.
  - `GET /companies`: Query by `domain` or `linkedin`.

- **LinkedIn Finder**
  - `POST /find-linkedin`: Find a company's LinkedIn page by domain.

- **Do Not Contact**
  - `POST /dnc-check`: Check a contact against a client's DNC list.

- **DNC Administration**
  - `POST /admin/clients`: Upsert a client (tenant) + HubSpot credentials.
  - `GET /admin/clients/:external_id`: Inspect a client and its DNC sources.
  - `POST /admin/dnc/sources`: Register a DNC source (`csv` or `hubspot_list`).
  - `POST /admin/dnc/import`: Import DNC entries from a CSV string or array.
  - `POST /admin/dnc/sync`: Pull current HubSpot list memberships into the DNC tables.

### Example: DNC Check

```bash
curl -X POST http://localhost:3000/dnc-check \
  -H "Authorization: Bearer your_api_key" \
  -H "Content-Type: application/json" \
  -d '{"client_id": "cust_123", "email": "juan@empresa.com"}'
```

Suppressed → `{ "contactable": false, "status": "do_not_contact", "reason": "...", "matched_on": "email", "source": { ... } }`
Allowed → `{ "contactable": true, "contact": { ...cached profile... } }`

## Do Not Contact — Architecture

```
clients ──< dnc_sources ──< dnc_entries
  │             │                │
  │             │                └─ email / phone_e164 / domain + reason + source_type
  │             └─ type: 'csv' | 'hubspot_list'  (+ hubspot_list_id, last_sync_*)
  └─ external_id (the API client_id), optional HubSpot token
```

- **clients** — one row per tenant. `external_id` is what callers pass as `client_id`. A per-client HubSpot private-app token is stored here (only for clients that sync from HubSpot).
- **dnc_sources** — where a client's DNC entries come from. A CSV upload or a HubSpot list. HubSpot sources carry the `hubspot_list_id` and the last-sync status.
- **dnc_entries** — the suppressed contacts. Each row can carry any of email / phone / domain. A check matches on **any** provided identifier (and the email's domain against domain entries).

**Ingestion paths**
- **CSV** → `POST /admin/dnc/import` (headers auto-detected; re-importing the same `source_label` replaces that source's entries).
- **HubSpot lists** → register with `POST /admin/dnc/sources`, then sync. Each sync pulls the list's **current** membership (works for dynamic/active lists) and replaces that source's entries as a full snapshot.

### Daily HubSpot sync (cron)

The sync is exposed two ways — wire **one** to a daily scheduler:

```bash
# CLI (Railway cron, GitHub Actions, etc.)
npm run dnc:sync                 # all active clients
npm run dnc:sync -- cust_123     # a single client

# or HTTP (any external/platform cron)
curl -X POST http://localhost:3000/admin/dnc/sync \
  -H "Authorization: Bearer your_api_key" -H "Content-Type: application/json" -d '{}'
```

Example Railway cron (daily at 03:00 UTC): schedule the command `npm run dnc:sync`.

> Sync is intentionally **not** an in-process timer, so it runs once regardless of how many app instances are deployed. HubSpot credentials live per-client in the DB, so no app-wide HubSpot env var is needed.

## Testing Normalization
Run the verification scripts:
```bash
npx ts-node src/verify_normalization.ts # Profiles
npx ts-node src/verify_companies.ts     # Companies
```
