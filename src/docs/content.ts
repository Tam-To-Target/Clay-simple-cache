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

## Email Cache

### 5. Verify Email
**POST** \`/verify\`

Verify an existing email address. Results are served from the verification cache when available; otherwise the email is checked through the multi-tier API cascade and the result is cached.

**Request Body (JSON)**:
| Field | Type | Required | Description |
|---|---|---|---|
| \`email\` | String | **Yes** | The email to verify. |
| \`max_tier\` | Number | No | Max verification tier: 1 or 2 (default: 2). |

**Response (JSON)**:
\`\`\`json
{
  "email": "juan@empresa.com",
  "status": "valid",
  "confidence": 0.95,
  "method": "emaillistverify",
  "domain_info": { ... },
  "cost_usd": 0.0004,
  "duration_ms": 450
}
\`\`\`

---

### 6. Stats
**GET** \`/stats\`

Returns aggregate metrics for the email verification cache.

**Response (JSON)**:
\`\`\`json
{
  "emails_cached": 1240,
  "valid_cached": 870,
  "catch_all_cached": 95,
  "methods_breakdown": { "emaillistverify": 720, "debounce": 150 },
  "domains_in_cache": 93
}
\`\`\`

---

## LinkedIn Finder

### 7. Find Company LinkedIn
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

### 8. DNC Check
**POST** \`/dnc-check\`

Check whether a contact is on a client's Do Not Contact list. If suppressed, the
response says so (with the reason and source) and **does not** return contact
data. If not suppressed, it returns the contact's cached profile data (if any).

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

### 9. Upsert Client
**POST** \`/admin/clients\`

Create or update a client (tenant), keyed by \`external_id\`.

| Field | Type | Required | Description |
|---|---|---|---|
| \`external_id\` | String | **Yes** | The ID used in \`/dnc-check\` payloads. |
| \`name\` | String | No | Display name. |
| \`active\` | Boolean | No | Defaults to true. |
| \`hubspot_portal_id\` | String | No | HubSpot portal ID. Tokens are resolved (and refreshed) automatically per portal, so this is all the sync needs. |
| \`hubspot_access_token\` | String | No | Legacy/optional static token. Not required — the multi-tenant sync resolves a fresh token from \`hubspot_portal_id\`. Never returned by the API. |

### 10. Get Client
**GET** \`/admin/clients/:external_id\`

Returns the client and its DNC sources (with last-sync status). The HubSpot token is never included.

### 11. Register DNC Source
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

### 12. Import DNC (CSV)
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

### 13. Sync HubSpot Lists
**POST** \`/admin/dnc/sync\`

Refreshes membership of the **already-registered** HubSpot-list sources (full
snapshot replace per list). Does not look for new lists — use **Discover** for that.

| Field | Type | Required | Description |
|---|---|---|---|
| \`client_id\` | String | No | Sync one client; omit to sync all active clients. |

Response: \`{ "status": "ok", "scope": "all", "sources_synced": 4, "results": [ ... ] }\`.

### 14. Discover + Sync HubSpot Lists
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

---

### Pending (Not Yet Implemented)
- **POST /verify/batch** — Batch email verification.
- **Tier 3 verification** — NeverBounce provider ($0.008/email).
`;
