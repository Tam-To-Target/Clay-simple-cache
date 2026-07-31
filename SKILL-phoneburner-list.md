---
name: phoneburner-upload
description: Upload a call list into PhoneBurner for a client via the Contact Platform API (POST /admin/phoneburner/upload) — the service handles SDR routing, the next Lead Score, client/campaign tags, DNC scrubbing, and net-new de-dupe. Use when the user says "upload this call list to PhoneBurner", "add these leads to the dialer for <client>", "load this list for <SDR> to call", "push this CSV to PhoneBurner", "tee up a call list for <client>", or "/phoneburner-upload". NOT for email sends (use bison/gov/cold-email) and NOT for call-list health analysis (use call-campaign-health).
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# PhoneBurner Upload — load a call list via the Contact Platform API

Push a CSV of contacts into the assigned SDR's PhoneBurner book by calling ONE
service endpoint. The **Contact Platform** (a.k.a. Clay cache / TTT-api-service)
owns all the convention logic now — you no longer discover tags, compute a Lead
Score, or scrub DNC by hand. You convert the CSV to JSON, POST it, and read the
result.

## The manual process this replaces (from the GTME team's Loom)

| Loom step | Automated? |
|---|---|
| 0:00–1:28 Build the saved-search folder: tag = client, dial attempts = 0, `Lead Score = club8`; name it `<Client>: <Campaign> - 1st Attempt` | ✅ **replaced** — we create a real dial *folder* with that same name and file the list into it (Step 4). No saved search needed. |
| 1:28–2:05 Pull the list into Clay, filter phone-not-empty | ✅ rows without a phone come back in `invalid[]` |
| 2:05–2:57 Clay formula stamping `club8` on every row | ✅ Lead Score auto-minted |
| 2:57–4:17 CSV upload + column mapping (full name → first/last, title → Job Title, school → company, phone → Home) | ✅ |
| 4:17–4:44 Type the import tags: `fresh leads`, `club hub`, `<campaign>` | ✅ |
| 4:44 Complete import, verify the list landed in the folder | ✅ `totals` in the response |

⚠️ **Two strings that look like tags are not tags.** `"<Client>: <Campaign> - Nth
Attempt"` is the *name of the saved search*; the attempt is a *dial-count criterion
inside* it. An earlier version of this skill put both in `tags[]`, so uploads did not
match the tag filters the SDRs' existing saved searches use. Fixed 2026-07-30.

✅ **This is now end-to-end.** A Contact Folder *is* a first-class dial source —
PhoneBurner's flow is Contacts → a folder **or** a saved search → tick → Begin Dial
Session. A folder simply isn't a *dynamic* filter, which is the only reason the team
reached for a saved search. So the upload creates a folder per list and files the
contacts into it via `category_id`; the SDR picks it and dials. (An earlier version of
this file wrongly claimed `/folders` makes "a static category that does not drive the
dial queue" — corrected 2026-07-31, see `PB-list-manager/FINDINGS.md`.)

## Service + auth (only these endpoints, all in this one service)

- **Base URL:** `https://clay-simple-cache-production-27af.up.railway.app`
- **Auth:** every call is `Authorization: Bearer $CLAY_CACHE_API_KEY` (the
  service's `API_KEY`). If it isn't in the env, ask the user for it — never
  hardcode it. A missing/wrong key returns `401`.

Endpoints this skill uses:

| Method + path | Purpose |
|---|---|
| `POST /admin/phoneburner/upload` | The upload. `dry_run:true` previews; `dry_run:false` writes. Handles SDR routing, Lead Score, tags, DNC scrub, net-new. |
| `GET /admin/clients/{slug}` | Resolve/verify the client. `404` returns `suggestions`. |
| `GET /admin/clients?active=1` | List clients (to find a slug when unsure). |

`POST /dnc-check` also exists but is **redundant here** — the upload scrubs DNC
itself and reports every collision. Do not build a separate scrub step.

## What the service does for you (do NOT re-implement)

- **SDR routing.** Give `client_id` (slug). If exactly one SDR dials for the
  client, it's auto-selected. If more than one, the endpoint returns
  `409 {needs_sdr:true, sdrs:[{name,slug,username,pbMemberId}]}` — pick one and
  resend with `sdr` (a slug/name/email/member-id).
- **Lead Score.** Auto-minted as the next value for the client (e.g. `CLUB7 → CLUB8`).
  Pass `lead_score` ONLY to override (reuse/pin a specific one). It's stamped on
  **net-new contacts only** — an overlapping contact keeps its prior list's score.
- **Tags.** `fresh leads` + the client tag (e.g. `Club Hub`) + the **bare** campaign
  name (e.g. `ISTE 2026 TAM`) + any `tags[]`. Exactly what the manual import types.
- **Job Title.** A row's `title` → the account's `Job Title` custom field.
- **DNC.** Scrubbed before upload by default; `dnc_scrub:false` disables.
- **Owner.** Created under the SDR's own PhoneBurner token.
- **Dial folder.** Creates (or reuses) a folder named
  `"<PascalClient>: <Campaign> - <Nth> Attempt"` and files the contacts into it, so the
  SDR has a dialable target with no UI work. `savedSearch.needed` says whether anything
  is left to build — see Step 4.

## Step 0 — Resolve the client (BLOCKING)

Map what the user said to the client **slug** (the service's `external_id`).

```bash
BASE="https://clay-simple-cache-production-27af.up.railway.app"
curl -s -H "Authorization: Bearer $CLAY_CACHE_API_KEY" "$BASE/admin/clients/<slug>"
```

`404` returns `suggestions` — pick the right one (confirm with the user if
ambiguous) and use that slug. The endpoint also accepts known slug aliases
(e.g. a GTMOS-style `bridge-it` resolves to `bridgeit`), but prefer the canonical
slug. If the client genuinely isn't set up, stop and say so.

The response includes `sdrs: [{ name, slug, username, pbMemberId }]` — the SDRs
who dial for this client. Use it to pick the `sdr` up front: if there's exactly
one, you can go straight to the upload; if several, ask the user which. (The
upload endpoint also returns the same list in its `409 needs_sdr`, so either path
works.)

## Step 1 — Build the contacts array from the CSV

The endpoint takes JSON, not a CSV. Convert each row to
`{ phone, first_name?, last_name?, name?, company?, email?, title?, notes? }`
(a bare phone string is also accepted). `phone` is required per row; rows without
one are reported as `invalid` (not silently dropped). Map the columns:

- dial number (`home`/`phone`/`direct_dial`/`mobile`) → `phone`
- first/last, or a single full-name column → `first_name`/`last_name` (or `name`)
- `company`/`school` → `company`; `email` → `email`; job title → `title`
- fold scoring/status/notes columns into `notes`

Example (adjust column names to the file):

```bash
python3 - "$CSV" > /tmp/contacts.json <<'PY'
import csv, json, sys
rows=[]
with open(sys.argv[1], newline='') as f:
    for r in csv.DictReader(f):
        rows.append({
            "phone": r.get("home") or r.get("phone") or r.get("mobile"),
            "first_name": r.get("first_name") or r.get("First Name"),
            "last_name": r.get("last_name") or r.get("Last Name"),
            "name": r.get("full_name") or r.get("Name"),
            "company": r.get("school") or r.get("company") or r.get("Company"),
            "email": r.get("email") or r.get("Email"),
            "title": r.get("title") or r.get("Job Title"),
        })
json.dump([{k:v for k,v in row.items() if v} for row in rows], sys.stdout)
PY
```

## Step 2 — Dry run FIRST (always)

Preview without writing. Omit `sdr` on the first call to discover the routing.

```bash
jq -n --slurpfile c /tmp/contacts.json \
  '{client_id:"<slug>", campaign:"<Campaign Name>", attempt:"first attempt", dry_run:true, contacts:$c[0]}' \
| curl -s -H "Authorization: Bearer $CLAY_CACHE_API_KEY" -H "Content-Type: application/json" \
       -X POST "$BASE/admin/phoneburner/upload" -d @-
```

- **`409 needs_sdr`** → present the `sdrs[]` names, let the user pick (or use the
  one they named), and add `"sdr":"<slug>"`.
- On `200`, read the preview back to the user and confirm:
  - `leadScore.value` (the next Lead Score that WILL be minted — e.g. `CLUB8`),
  - `tags`, `clientTag`, `sdr`,
  - `folder`: the dial folder's `name`, and whether it already exists
    (`would_create:false`) or will be created (`would_create:true`). `assigned` /
    `left_in_place` are projections in a dry run. **A dry run reads the folder list but
    writes nothing** — no folder is created until you apply.
  - `dnc`: if `entries_present:false`, say plainly **"DNC not applied — the client
    has no DNC data to scrub against"** (don't present it as clean); report
    `skipped` + the `dnc_skipped[]` collisions,
  - `totals.net_new` / `overlap` (overlap = already in the seat's book; Lead Score
    won't be re-stamped on them),
  - `totals.invalid` + `invalid[]` — name the no-phone rows rather than dropping
    them silently.

## Step 3 — Apply

Resend with `dry_run:false` (keep the same `sdr`, `campaign`, etc.). Add
`lead_score` only to override the auto-minted value.

```bash
jq -n --slurpfile c /tmp/contacts.json \
  '{client_id:"<slug>", sdr:"<slug>", campaign:"<Campaign Name>", attempt:"first attempt", dry_run:false, contacts:$c[0]}' \
| curl -s -H "Authorization: Bearer $CLAY_CACHE_API_KEY" -H "Content-Type: application/json" \
       -X POST "$BASE/admin/phoneburner/upload" -d @-
```

Report `totals.uploaded` / `failed` / `net_new` / `overlap`, the recorded
`leadScore.value` (`issued:true`), and `folder.name` + `folder.assigned`. Investigate
any `failed[]` (status + error). Then do Step 4 — usually "nothing to do".

## Step 4 — Report the dial target (usually: nothing to do)

The upload files the list into a PhoneBurner **folder**, which is a dialable target.
**Read `savedSearch.needed` and let it decide what you tell the user.**

```json
"folder": { "id": "9142", "name": "ClubHub: ISTE 2026 TAM - 1st Attempt",
            "created": true, "would_create": false,
            "assigned": 240, "left_in_place": 47 },
"savedSearch": { "api_available": false, "needed": true, "reason": "…",
                 "standing": { "name": "ClubHub: 1st Attempt",
                               "criteria": ["tag = Club Hub", "dial attempts = 0"],
                               "build_once": true },
                 "per_list": { "name": "ClubHub: ISTE 2026 TAM - 1st Attempt",
                               "criteria": ["tag = Club Hub", "Lead Score = CLUB8",
                                            "dial attempts = 0"] } }
```

- **`needed: false`** (the normal case) → say plainly: *"Nothing to build. The leads are
  in folder `<folder.name>` — open Contacts, pick that folder, Begin Dial Session."*
  **Do not** hand them saved-search instructions they don't need.
- **`needed: true`** → show `savedSearch.reason` verbatim; it already explains why.
  The usual cause is `folder.left_in_place > 0`: overlapping contacts stayed in their
  existing folder because **a contact can only be in one**, and moving it could yank it
  out of a list the SDR is mid-way through. Offer the choice — dial the folder for the
  new leads, or re-run with `folder_assign:"all"` to pull the overlaps in.

**`standing` / `per_list` are fallback recipes**, for a client who wants a search
anyway. `standing` (build once per client, absorbs every later upload) beats `per_list`
because the only criterion that changed per list was the Lead Score — and
`tag = <client>` + `dial attempts = 0` already means "never-dialed leads for this
client". Lead Score is still stamped either way, so attribution is unaffected.

> If a client does build a search, confirm the dial-count criterion's exact field label
> once — the Loom shows *"always start with zero … for the second attempt put one"*,
> clearly a dial count, but the builder wasn't on screen. Not needed for the folder path.

## Options reference (request body)

| Field | Notes |
|---|---|
| `client_id` | Client slug (required). |
| `sdr` | slug \| name \| email \| pb_member_id. Required only when >1 SDR. |
| `contacts` | Array; `phone` required per row (see Step 1). |
| `campaign` | → a **bare** tag (`ISTE 2026 TAM`) + the `savedSearch` name. |
| `lead_score` | Override the auto-minted Lead Score. Omit to auto-mint. |
| `attempt` | Dial pass (`first attempt` / `2nd` / `3`; default 1). **Not a tag** — drives `savedSearch`. |
| `tags` | Extra tags, appended to the standard three. |
| `fresh_leads_tag` | Default `true`. `false` only when re-tagging leads already in the book. |
| `folder` | Override the dial folder's name. Default = `"<PascalClient>: <Campaign> - <Nth> Attempt"`. |
| `folder_assign` | `net_new` (default), `all` (move overlaps into the folder too), `none` (don't touch folders). |
| `dnc_scrub` | Default `true`. |
| `on_duplicate` | `update` (default — existing gains the new tag) or `skip`. |
| `dry_run` | `true` = preview + mint/write nothing. |

## Gotchas

- **Overlap is expected.** PhoneBurner merges duplicates on email/phone; the new
  campaign tag is added but the prior Lead Score **and folder** are preserved (the
  service only stamps those on net-new). Counts come back in `totals.overlap` and
  `folder.left_in_place`.
- **A contact lives in exactly ONE folder.** That's why overlaps aren't refiled by
  default — `category_id` is singular, so moving a contact removes it from wherever it
  is now, which may be a list someone is actively dialing. `folder_assign:"all"` is the
  deliberate override; don't reach for it reflexively.
- **SDR must have a PhoneBurner token in GTMOS**, or you get `400` ("no
  PhoneBurner token for SDR …"). That SDR hasn't connected PhoneBurner.
- **Shared phone numbers collapse people** — two names on one switchboard line
  become one contact. Flag it; the real fix is a direct dial.
- **Lead Score is auto-minted** — don't compute it. Only pass `lead_score` to pin
  a specific list identifier (e.g. re-loading an existing campaign).
- **The service owns the convention** (seeded once from call history). If a
  client's minted Lead Score prefix looks wrong, that's a data/seed issue in the
  service — don't work around it here.
- **`pb_client_tag` is the tag verbatim, spaces and all** (`Club Hub`, not
  `ClubHub`). The PascalCase form appears only in the saved search's *name*. If a
  client's `pb_client_tag` is unset the service falls back to PascalCase, which may
  not match the SDR's existing tag — check the dry-run `tags[]` before applying.
