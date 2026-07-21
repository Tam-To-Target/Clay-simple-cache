export const apiDocumentation = `# Identity Cache & Enrichment API

## Overview
This API allows storing, retrieving, and resolving identity profiles (People) and companies.
It uses a "best-effort" resolution strategy based on multiple identifiers (Email, LinkedIn, Phone, Domain).

## Base URL
\`{{BASE_URL}}\`

## Authentication
All endpoints (except \`/health\` and \`/docs/api\`) require an API Key passed via the \`Authorization\` header using the **Bearer** scheme.

**Header**: \`Authorization\`
**Value**: \`Bearer <your_api_key>\`

Example:
\`\`\`bash
curl -H "Authorization: Bearer your_secret_key" {{BASE_URL}}/profiles?email=test@example.com
\`\`\`

**Error Responses**:
| Status | Body | Reason |
|---|---|---|
| \`401\` | \`{ "error": "Unauthorized: Missing or malformed Authorization header" }\` | Header is missing or does not start with \`Bearer \`. |
| \`401\` | \`{ "error": "Unauthorized: Invalid API Key" }\` | The token does not match the server's API key. |

---

## Endpoints

### 1. Upsert Profile
**POST** \`/profiles\`

Create or update a profile record. The API will try to find an existing profile by any of the provided identifiers. If found, it merges the new data into the existing record. Otherwise, it creates a new profile.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`email\` | String | No* | Person's email. Will be lowercased. |
| \`linkedin_url\` | String | No* | LinkedIn profile URL. Slug will be extracted and full URL stored. |
| \`linkedin_profile\` | String | No* | Alias for \`linkedin_url\`. |
| \`phone\` | String | No* | Phone number. Will be normalized to E.164. |
| \`...\` | Any | No | Any additional fields will be stored in the \`data\` object. |

*At least one of \`email\`, \`linkedin_url\`, or \`phone\` is required.*

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "resolved_by": "email | linkedin_slug | linkedin_url | phone_e164 | new",
  "profile_id": "uuid-string",
  "saved_data": {
    "id": "uuid-string",
    "email": "normalized-email | null",
    "linkedin_slug": "slug | null",
    "linkedin_url": "full-url | null",
    "phone_e164": "+E.164 | null",
    "data": { "...additional fields..." }
  }
}
\`\`\`

---

### 2. Get Profile
**GET** \`/profiles\`

Retrieve a profile by identifier.

**Query Parameters**:
| Param | Description |
|---|---|
| \`email\` | Search by email. |
| \`linkedin\` | Search by LinkedIn URL or slug. |
| \`phone\` | Search by phone (E.164 or loose format). |

**Response — Found (JSON)**:
\`\`\`json
{
  "id": "uuid-string",
  "email": "string | null",
  "linkedin_slug": "string | null",
  "phone": "string (E.164) | null",
  "updated_at": "ISO-8601 Date",
  "...": "Dynamic fields from 'data' object are spread here at the root level"
}
\`\`\`

**Response — Not Found (200, JSON)**:
\`\`\`json
{
  "result": null,
  "message": "No records found",
  "search_criteria": {
    "email": "normalized value or undefined",
    "linkedin_url": "value or undefined",
    "linkedin_slug": "value or undefined",
    "phone_e164": "value or undefined"
  }
}
\`\`\`

---

### 3. Upsert Company
**POST** \`/companies\`

Create or update a company record. The API will try to find an existing company by domain or LinkedIn slug. If found, it merges the new data. Otherwise, it creates a new company.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`domain\` | String | No* | Company website domain (e.g. "google.com"). |
| \`linkedin_url\` | String | No* | Company LinkedIn URL. |
| \`...\` | Any | No | Any additional fields will be stored in the \`data\` object. |

*At least one of \`domain\` or \`linkedin_url\` is required.*

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "resolved_by": "domain | linkedin_slug | new",
  "company_id": "uuid-string",
  "saved_data": {
    "id": "uuid-string",
    "domain": "normalized-domain | null",
    "linkedin_slug": "slug | null",
    "data": { "...additional fields..." }
  }
}
\`\`\`

---

### 4. Get Company
**GET** \`/companies\`

Retrieve a company by identifier.

**Query Parameters**:
| Param | Description |
|---|---|
| \`domain\` | Search by domain. |
| \`linkedin\` | Search by LinkedIn URL or slug. |

**Response — Found (JSON)**:
\`\`\`json
{
  "id": "uuid-string",
  "domain": "string | null",
  "linkedin_slug": "string | null",
  "updated_at": "ISO-8601 Date",
  "...": "Dynamic fields from 'data' object are spread here at the root level"
}
\`\`\`

**Response — Not Found (200, JSON)**:
\`\`\`json
{
  "result": null,
  "message": "No records found",
  "search_criteria": {
    "domain": "normalized value or undefined",
    "linkedin_slug": "value or undefined"
  }
}
\`\`\`

---

## LinkedIn Finder

### 5. Find Company LinkedIn
**POST** \`/find-linkedin\`

Given a domain (or URL), finds the company's LinkedIn page via a SERP lookup (requires \`SERPER_API_KEY\`).

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`domain\` | String | **Yes** | Company domain or URL (e.g. "acme.com"). \`url\` is accepted as an alias. |

**Response (JSON)**:
\`\`\`json
{
  "success": true,
  "input": "acme.com",
  "domain": "acme.com",
  "linkedin_url": "https://www.linkedin.com/company/acme",
  "linkedin_slug": "acme",
  "match_type": "domain_in_url",
  "cost_usd": 0.001
}
\`\`\`

If \`SERPER_API_KEY\` is not configured the endpoint returns \`503\` with \`reason: "missing_api_key"\`.

---

## Do Not Contact (DNC)

Multi-tenant suppression. Each **client** (identified by \`client_id\`, its slug)
has its own DNC list. Entries can match on **email**, **phone (E.164)**, or
**domain** (a domain entry blocks every contact at that company). DNC data is
loaded from CSV uploads and from HubSpot lists.

**HubSpot lists are discovered and classified automatically.** Each portal's
\`TAM - Do Not Contact …\` lists are found by name and classified into two levels:
- **Individual** (\`… (Individual)\`) — suppresses the exact members' email/phone.
- **Domain** (\`… (Domain)\`) — additionally suppresses each member's corporate
  email domain, so any contact at that company is blocked. Free/disposable
  providers (gmail.com, etc.) are excluded so a public domain is never blocked.

A \`/dnc-check\` matches the incoming email's domain against domain-level entries,
so domain suppression works even when the caller only sends an email. Lists are
re-discovered and re-synced on a daily schedule (full snapshot replace per list).

### 6. DNC Check
**POST** \`/dnc-check\`

Check whether a contact is on a client's Do Not Contact list. If suppressed, the
response says so (with the reason and source) and **does not** return contact
data. If not suppressed, it returns the contact's cached profile data (if any).

Every check also **caches the contact as a profile** (best-effort) using whatever
identity it carries (\`email\` / \`phone\`), so it becomes retrievable via
\`GET /profiles\`. Domain-only checks are not cached (no profile key).

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | **Yes** | The client's \`external_id\`. |
| \`email\` | String | No* | Contact email. |
| \`phone\` | String | No* | Contact phone (normalized to E.164). |
| \`domain\` | String | No* | Company domain. |

*At least one of \`email\`, \`phone\`, or \`domain\` is required. The email's domain is also matched against domain-level entries.*

**Response — suppressed (JSON)**:
\`\`\`json
{
  "client_id": "cust_123",
  "contactable": false,
  "status": "do_not_contact",
  "reason": "Unsubscribed",
  "matched_on": "email",
  "matched_value": "juan@empresa.com",
  "source": { "type": "hubspot_list", "label": "Suppression", "hubspot_list_id": "42", "synced_at": "..." },
  "added_at": "..."
}
\`\`\`

**Response — contactable (JSON)**:
\`\`\`json
{
  "client_id": "cust_123",
  "contactable": true,
  "status": "ok",
  "contact": { "email": "juan@empresa.com", "phone": "+52...", "firstName": "Juan", "...": "...cached profile data..." }
}
\`\`\`

**Errors**: \`400\` (missing \`client_id\` or no identifier), \`404\` (unknown/inactive client).
A \`404\` includes \`suggestions\` — the closest known client handles — when any are similar:
\`\`\`json
{ "error": "Unknown or inactive client_id: hilightt", "suggestions": ["hilight"] }
\`\`\`

---

## DNC Administration

These endpoints manage clients and their DNC sources. All require the Bearer API key.

### 7. Upsert Client
**POST** \`/admin/clients\`

Create or update a client (tenant), keyed by \`external_id\`.

| Field | Type | Required | Description |
|---|---|---|---|
| \`external_id\` | String | **Yes** | The ID used in \`/dnc-check\` payloads. |
| \`name\` | String | No | Display name. |
| \`active\` | Boolean | No | Defaults to true. |
| \`hubspot_portal_id\` | String | No | HubSpot portal ID. Tokens are resolved (and refreshed) automatically per portal, so this is all the sync needs. |

### 8. List Clients
**GET** \`/admin/clients\`

Returns every customer with their internal name and a roll-up of their data —
useful for a dashboard or picking a valid \`client_id\`. Add \`?active=1\` to list
only active clients.

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "count": 13,
  "clients": [
    {
      "id": "uuid",
      "external_id": "hilight",
      "name": "Hilight",
      "active": true,
      "hubspot_portal_id": "22493085",
      "hubspot_connected": true,
      "dnc_sources": 2,
      "dnc_entries": 4369,
      "contacts": 128,
      "pending_push": 40,
      "failed_push": 0,
      "pushed": 88,
      "created_at": "...",
      "updated_at": "..."
    }
  ]
}
\`\`\`
\`pending_push\` is how many leads were stored for a client whose HubSpot isn't
connected yet (see Create Contact / Backfill below). The HubSpot token is never included.

### 9. Get Client
**GET** \`/admin/clients/:external_id\`

Returns the client and its DNC sources (with last-sync status). The HubSpot token is never included.

### 10. Register DNC Source
**POST** \`/admin/dnc/sources\`

| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | **Yes** | Client \`external_id\`. |
| \`type\` | String | **Yes** | \`csv\` or \`hubspot_list\`. |
| \`label\` | String | No | Friendly name. |
| \`hubspot_list_id\` | String | Yes for \`hubspot_list\` | The HubSpot list to sync. |
| \`dnc_level\` | String | No | \`individual\` (default) or \`domain\`. Usually set automatically by discovery from the list name. |
| \`active\` | Boolean | No | Defaults to true. |

> Most HubSpot-list sources are created automatically by **Discover** (below) —
> manual registration is only needed for custom cases.

### 11. Import DNC (CSV)
**POST** \`/admin/dnc/import\`

Load DNC entries from a CSV string or an explicit entries array.

| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | **Yes** | Client \`external_id\`. |
| \`csv\` | String | No* | Raw CSV text (headers auto-detected: email/phone/domain/reason). |
| \`entries\` | Array | No* | \`[{ email?, phone?, domain?, reason? }]\`. |
| \`column_map\` | Object | No | Override header detection, e.g. \`{ "email": "Correo" }\`. |
| \`source_label\` | String | No | Names the CSV source (re-importing the same label replaces it). |
| \`reason\` | String | No | Default reason for rows without one. |
| \`mode\` | String | No | \`replace\` (default) or \`append\`. |

*Provide either \`csv\` or \`entries\`.*

Response: \`{ "status": "ok", "source_id": "...", "mode": "replace", "imported": 120, "skipped": 3 }\`.

### 12. Sync HubSpot Lists
**POST** \`/admin/dnc/sync\`

Refreshes membership of the **already-registered** HubSpot-list sources (full
snapshot replace per list). Does not look for new lists — use **Discover** for that.

| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | No | Sync one client; omit to sync all active clients. |

Response: \`{ "status": "ok", "scope": "all", "sources_synced": 4, "results": [ ... ] }\`.

### 13. Discover + Sync HubSpot Lists
**POST** \`/admin/dnc/discover\`

The cron entry point. For each client it re-scans the portal for
\`TAM - Do Not Contact …\` lists, (re)classifies them as individual/domain,
registers new sources, **deactivates sources whose list was deleted** (clearing
their stale entries), then syncs membership. Idempotent and safe to run daily.
Equivalent CLI: \`npm run dnc:sync\` (also runs discover + sync).

| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | No | Discover one client; omit for all active clients. |

Response (per client) includes \`sources_active\`, \`deactivated\`, \`unclassified\`
(lists that matched the prefix but had no Individual/Domain suffix — reported,
not synced), and the \`sync\` results.

Every source discovery creates is marked \`origin: "discovered"\` and is subject
to auto-deactivation. Lists **pinned manually** (see *Pin a DNC List* below) are
\`origin: "manual"\` and are **never** auto-deactivated — they're the registry of
record for lists outside the naming convention.

---

### 14. Look up HubSpot Lists
**GET** \`/admin/dnc/hubspot-lists?client_id=<slug>&q=<name>\`

Return a client's HubSpot lists (id + name) so you can find a list id from its
name before pinning it as a DNC source. \`q\` filters by name (HubSpot list
search); omit it to list.

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "client_id": "cybernut",
  "count": 3,
  "lists": [
    { "listId": "1245", "name": "TAM - Do Not Contact (Inbound)", "processingType": "DYNAMIC", "contact_count": 812 }
  ]
}
\`\`\`
**Errors**: \`400\` (missing \`client_id\` / client has no portal), \`404\` (unknown client).

### 15. Pin a DNC List
**POST** \`/admin/dnc/lists\`

Pin ANY HubSpot list as a DNC source for a client **regardless of its name** —
the programmatic way to add lists that don't follow the \`(Individual)\`/\`(Domain)\`
convention. The source is stored with \`origin: "manual"\` (so discovery never
auto-deactivates it) and its membership is synced immediately. Idempotent per
(client, list).

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | **Yes** | The client's \`external_id\` (slug). |
| \`hubspot_list_id\` | String | **Yes** | The HubSpot list id (see *Look up HubSpot Lists*). |
| \`dnc_level\` | String | **Yes** | \`individual\` (exact email/phone) or \`domain\` (also the member's company email domain). |

**Response (JSON)**: \`{ "status": "ok", "client_id": "...", "source": { … }, "sync": { "status": "ok", "entry_count": 812, … } }\`.

**Errors**: \`400\` (missing/invalid fields, or client has no portal), \`404\` (unknown client, or the list id doesn't exist in that portal).

---

## HubSpot Contact Push

### 16. Create Contact
**POST** \`/admin/hubspot/contacts\`

Create a contact in the client's HubSpot portal. If a contact with the same
\`email\` already exists it is **updated** instead (idempotent). The token for the
client's portal is resolved automatically.

**No HubSpot yet? The lead is stored, not rejected.** We routinely build a
customer's list weeks before receiving their HubSpot access. When the client has
no connected portal (no \`hubspot_portal_id\`, or the OAuth grant isn't active
yet), the endpoint returns \`200\` with \`push_status: "pending"\` and persists the
lead (with the exact properties to push). Once access is granted, replay every
stored lead with **Backfill Stored Leads** (below). Nothing is lost and no error
is raised for the "not connected yet" case.

The lead is always **cached as a profile** (email / phone / LinkedIn as identity,
plus all submitted properties and attribution under \`data\`), retrievable via
\`GET /profiles\`, and linked to the customer on the \`contact_clients\` bridge with
its \`push_status\`. The internal contact id is returned as \`contact_id\`; the
HubSpot id (only once pushed) as \`hubspot_contact_id\`.

**\`push_status\` values**: \`pushed\` (live in HubSpot) · \`pending\` (stored, waiting
on CRM access) · \`failed\` (transient upstream error; retried by backfill) ·
\`skipped_dnc\` (suppressed).

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | **Yes** | The client's \`external_id\` (slug). |
| \`email\` | String | **Yes** | Contact email (identity). |
| \`campaign_name\` | String | **Yes** | Campaign name. |
| \`campaign_type\` | String | **Yes** | One of: \`Inbound\`, \`Targeted List\`, \`Signal\`, \`Event\`, \`ICP Fit\` (case-insensitive). |
| \`lead_origin\` | String | **Yes** | Source (e.g. Website, LinkedIn). |
| \`lead_origin_details\` | String | **Yes** | Fit-related context. |
| \`check_dnc\` | Boolean | No | If \`true\`, skip the push when the contact is on the client's DNC list. |
| \`properties\` | Object | No | Extra HubSpot properties, keyed by **internal** property name. |
| \`...\` | Any | No | Extra properties may also be passed as top-level keys (internal names). |

**Response — pushed (JSON)**:
\`\`\`json
{
  "status": "ok",
  "pushed": true,
  "stored": true,
  "push_status": "pushed",
  "created": true,
  "client_id": "tam-to-target",
  "hubspot_portal_id": "244264386",
  "contact_id": "uuid-string",
  "hubspot_contact_id": "508943115974",
  "dnc_checked": true
}
\`\`\`
\`created\` is \`false\` when an existing contact was updated.

**Response — stored, CRM not connected yet (200, JSON)**:
\`\`\`json
{
  "status": "pending",
  "pushed": false,
  "stored": true,
  "push_status": "pending",
  "client_id": "acme",
  "contact_id": "uuid-string",
  "reason": "No HubSpot portal connected yet — lead stored; run /admin/hubspot/backfill once access is granted."
}
\`\`\`

**Response — suppressed (with \`check_dnc: true\`, JSON)**:
\`\`\`json
{
  "status": "do_not_contact",
  "created": false,
  "pushed": false,
  "stored": false,
  "client_id": "tam-to-target",
  "reason": "...",
  "matched_on": "email",
  "matched_value": "juan@empresa.com"
}
\`\`\`

**Errors**: \`400\` (missing required field or invalid \`campaign_type\`),
\`404\` (unknown client, with \`suggestions\`), \`422\` (HubSpot rejected a property — e.g. an
unknown internal name). A **missing/inactive HubSpot connection is NOT an error** —
it returns \`200\` with \`push_status: "pending"\`. A transient upstream failure also
returns \`200\` (\`status: "stored_push_failed"\`, \`retryable: true\`) with the lead
stored for backfill, so leads are never lost.

---

### 17. Backfill Stored Leads
**POST** \`/admin/hubspot/backfill\`

Replays leads that were **stored while HubSpot wasn't connected** into the
client's portal. Run this once a customer's HubSpot access is granted. Processes
\`pending\` and \`failed\` leads by default, **re-checks DNC per lead** (a lead may
have been suppressed while it waited), pushes each through the same idempotent
upsert as Create Contact, and flips each row's \`push_status\`. Safe to re-run.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | **Yes** | The client's \`external_id\` (slug). Must now have a connected portal. |
| \`dry_run\` | Boolean | No | Preview only — reports what would push, changes nothing. |
| \`limit\` | Number | No | Max leads to process this run (default 200, max 1000). Call repeatedly to drain a large backlog. |
| \`statuses\` | Array | No | Which statuses to replay (default \`["pending","failed"]\`; also accepts \`"skipped_dnc"\`, \`"pushed"\`). |

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "client_id": "acme",
  "hubspot_portal_id": "244264386",
  "dry_run": false,
  "candidates": 40,
  "created": 37,
  "updated": 1,
  "skipped_dnc": 2,
  "still_pending": 0,
  "failed": 0,
  "results": [ { "contact_id": "uuid", "email": "...", "outcome": "created", "hubspot_contact_id": "..." } ]
}
\`\`\`

**Errors**: \`400\` (missing \`client_id\`, or the client still has no \`hubspot_portal_id\`),
\`404\` (unknown client).

---

### 18. PhoneBurner DNC purge
**POST** \`/admin/phoneburner/purge\`

Deletes, from each client's PhoneBurner members' dialing books, every contact
that collides with that client's cached DNC list (by **email**, **phone**, or
**domain**). SDRs dial out of PhoneBurner, which doesn't read our DNC list, so
this closes that gap. Normally run daily by cron **after** \`dnc:sync\`; this
endpoint triggers it on demand. See \`PHONEBURNER_DNC_PURGE_PLAN.md\`.

**Safety rails**: dry-run by default (\`PB_PURGE_DRY_RUN\`, only real deletes when
explicitly \`false\` or \`dry_run:false\`); every deletion is backed up
(re-importable snapshot) to \`phoneburner_deletions\` before removal; a member is
**aborted entirely if more than 30% of its book is on the DNC** — a hard ceiling
that protects a legitimate campaign into a suppressed segment or a corrupt DNC
sync. \`PB_PURGE_MAX_RATIO\` can set a **stricter** (lower) gate but can never raise
it above 30%. Optional \`PB_PURGE_MAX_DELETES_PER_RUN\` circuit breaker; deletes are idempotent.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | No | Limit to one client's \`external_id\` (slug). Omit for all eligible clients. |
| \`dry_run\` | Boolean | No | Override the default. \`true\` = compute + audit only; \`false\` = delete. |

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "run": {
    "run_id": "uuid",
    "dry_run": true,
    "status": "ok",
    "totals": {
      "clients_processed": 1, "members_processed": 2, "members_skipped": 0,
      "contacts_scanned": 1240, "collisions_found": 37, "deleted": 37, "failed": 0
    },
    "clients": [
      { "client_external_id": "cust", "members": [
        { "pb_member_id": "1270387091", "status": "ok", "contacts_scanned": 800, "collisions": 20, "deleted": 20, "failed": 0 }
      ] }
    ]
  }
}
\`\`\`
Member \`status\` is one of \`ok\`, \`skipped_no_token\`, \`skipped_no_access\` (API
Access off), \`skipped_no_dnc\`, \`aborted_ratio\`, \`capped\`, \`error\`. In dry-run,
\`deleted\` is the would-delete count.

**Errors**: \`400\` (\`PHONEBURNER_ADMIN_TOKEN\` not configured), \`404\` (unknown
client, with \`suggestions\`), \`500\` (unexpected failure). Per-member problems
(no token / API access off / ratio gate) never fail the request — they're
reported per member.

---

### 19. PhoneBurner list upload
**POST** \`/admin/phoneburner/upload\`

Pushes a lead list into the assigned SDR's PhoneBurner dialing book — the
programmatic replacement for the manual "saved-search folder → Clay → CSV
import" flow. The client + campaign become searchable **tags**, the lead-group
identifier (e.g. \`club8\`) becomes the **folder** (\`category_id\`, created if
absent), and leads are created under the SDR's own token (\`owner_id\` = their
member id). Numbers already on the client's DNC are **scrubbed before upload**
by default (see \`PHONEBURNER_DNC_PURGE_PLAN.md\` §9) so the import doesn't feed the
very numbers the daily purge then deletes.

The SDR→client mapping is the same one the purge uses (\`phoneburner_members\`);
tokens are resolved from GTMOS, so \`SDR_LAUNCH_INTERNAL_URL\`/\`_SECRET\` must be set.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | Yes | Client \`external_id\` (slug). |
| \`sdr\` | String | Conditional | slug \\| name \\| email \\| \`pb_member_id\`. Required only when >1 SDR is assigned; a \`409 {needs_sdr, sdrs[]}\` lists the choices. |
| \`contacts\` | Array | Yes | Rows: a bare phone string, or \`{ phone, first_name?, last_name?, name?, company?, email?, title?, notes? }\`. \`phone\` is required per row. |
| \`campaign\` | String | No | Added as a tag (e.g. \`ISTE 2026 TAM\`). |
| \`lead_group\` | String | No | Folder name (e.g. \`club8\`); resolved or created. |
| \`attempt\` | String | No | Added as a tag (e.g. \`first attempt\`). |
| \`tags\` | String[] | No | Extra tags. |
| \`dnc_scrub\` | Boolean | No | Default \`true\`. \`false\` uploads everything unchecked. |
| \`on_duplicate\` | String | No | \`update\` (default) or \`skip\`. |
| \`dry_run\` | Boolean | No | Validate + DNC-scrub + report without creating anything. |

**Response (JSON)**:
\`\`\`json
{
  "status": "ok",
  "dryRun": false,
  "clientId": "club-hub",
  "sdr": { "pbMemberId": "111", "name": "Prince Derek", "slug": "prince-derek", "username": "prince@tamtotarget.com" },
  "folder": { "id": "11888", "name": "club8", "created": false },
  "tags": ["Club Hub", "ISTE 2026 TAM", "first attempt"],
  "totals": { "received": 300, "invalid": 2, "dnc_skipped": 11, "attempted": 287, "uploaded": 285, "failed": 2 },
  "dnc_skipped": [{ "phone": "+1...", "email": null, "matched_on": "phone", "matched_value": "+1..." }],
  "invalid": [{ "input": "...", "reason": "unparseable phone: ..." }],
  "failed": [{ "phone": "+1...", "status": 422, "error": "..." }]
}
\`\`\`
Detail arrays are capped at 100 entries; the \`totals\` counts are always exact.

**Errors**: \`400\` (missing \`client_id\`/\`contacts\`, GTMOS config absent, no active
SDR, unknown \`sdr\`, or the chosen SDR has no PhoneBurner token), \`404\` (unknown
client, with \`suggestions\`), \`409\` (SDR choice needed, with \`sdrs[]\`), \`500\`.

---

## Fit Scoring (config-driven, multi-tenant)

Scores a target account against a client's stored rubric and returns a 0-100
final score plus a plain-English briefing.

**Scoring is 100% deterministic.** The engine computes every subscore and the
weighted final score in code. The AI writes the reasoning narrative ONLY — it
never does math and never decides a score or recommendation. Each client's rubric
is a validated JSON config in our DB; a single generic engine interprets it.
Adding a client = one validated config row, zero deploys.

### POST /fit-score

Score one target against a client's rubric. (\`/score\` is a temporary alias.)

**Body**:
\`\`\`json
{
  "client_id": "hilight",
  "account_name": "Burlingame Elementary School District",   // REQUIRED
  "account_domain": "burlingame.k12.ca.us",                  // REQUIRED
  "starbridge_id": "SB-123456",                              // REQUIRED
  "values": { "total_enrollment": 8200, "propensity_to_spend": 72,
              "median_household_income": 68000, "enrollment_trend": "growing" },
  "reasoning": true,                  // optional, default true; false = skip the LLM
  "push_to_hubspot": false,
  "hubspot_object_id": "12345",       // required only when push_to_hubspot:true
  "hubspot_object_type": "companies"  // optional; default from config or "companies"
}
\`\`\`

\`account_name\`, \`account_domain\`, and \`starbridge_id\` are REQUIRED identity
properties (outside \`values\`). They are our primary HubSpot ID properties and are
written to the record on push (mapped via config \`hubspot_push.identity_fields\`,
default name/domain/starbridge_id).

**Response**:
\`\`\`json
{
  "final_score": 83,
  "config_version": 3,
  "account": { "account_name": "...", "account_domain": "...", "starbridge_id": "..." },
  "per_criterion": [
    { "key": "total_enrollment", "value": 8200, "subscore": 90, "weight": 0.4, "missing": false }
  ],
  "recommendation": "Prioritize now",
  "reasoning": "This large district ...",
  "cached": false,
  "pushed": false
}
\`\`\`

- No config for \`client_id\` → \`404\`.
- Any of \`account_name\`/\`account_domain\`/\`starbridge_id\` missing → \`422\` with
  \`missing_fields\`.
- Required criterion keys absent from \`values\` → \`422\` with \`missing_keys\`. (A
  key that is present but null/blank is scored with \`missing:true\`, not a 422 —
  "data was missing, don't penalize fit".)
- \`reasoning: false\` skips the LLM for that call (score still returned).
- \`push_to_hubspot:true\` with \`hubspot_push\` not enabled/configured, or without
  \`hubspot_object_id\` → \`422\`.
- Results are cached by (client_id, config_version, hash of values) so identical
  inputs never re-bill the model.

### PUT /config/:client_id

Create or update a client's rubric. **Validated before persisting** — an invalid
config is never stored; you get a per-field \`errors\` list. On success,
\`config_version\` increments (old scores keep their old version).

### GET /config/:client_id

Return the current config + resolved \`config_version\`. This is the endpoint the
config-authoring agent reads to debug/test/propose edits. \`404\` if none.
`;
