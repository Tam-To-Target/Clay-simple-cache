---
name: phoneburner-upload
description: Upload a call list (CSV) into the shared PhoneBurner dialing org for a client, following that client's real list convention — the right client/campaign tags, the next Lead Score identifier, the SDR seat who dials it — then verify. Use when the user says "upload this call list to PhoneBurner", "add these leads to the dialer for <client>", "load this list for <SDR> to call", "push this CSV to PhoneBurner", "tee up a call list for <client>", or "/phoneburner-upload". Handles tag/owner routing, custom fields, DNC, dedupe/overlap with prior lists, and the manual saved-search step. NOT for email sends (use bison/gov/cold-email) and NOT for call-list health analysis (use call-campaign-health).
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# PhoneBurner Upload — load a call list the way the account actually works

Push a CSV of contacts into the shared PhoneBurner dialing org (admin `bobby@rhosales.com`,
~66 seats, mostly `@tamtotarget.com` SDRs) so a named SDR can dial them. **The account does
not use folders per client** — a client is a **tag**, the per-list identifier is a **custom
field called `Lead Score`**, and each contact is owned by the **SDR seat** who dials it. This
skill discovers that convention from real data, loads correctly, and verifies — it does not
guess tags or Lead Scores (a wrong Lead Score collides two lists).

The heavy lifting is two committed helpers — **do not re-derive their work inline**:
- `scripts/phoneburner-convention.py` — reads the SDR Launch history to report the client tag,
  campaign-tag format, Lead Scores in use, the **next** Lead Score, and the SDR seats.
- `scripts/phoneburner-upload.py` — `members` / `tags` / `folders` / `upload` / `backfill`
  (dry-run by default; `--apply` writes). It already sends `custom_fields` in the required
  `[{name,type,value}]` array shape and maps `title` → the account's `Job Title` field.

**Token.** OAuth bearer, expires — set `PHONEBURNER_TOKEN` in the env (never commit). A stale
token returns `40109 Expired oauth token`; ask the user for a fresh one. All work runs on the
orchestrator (deterministic scripts + your reasoning) — no OpenRouter/model routing.

---

## Step 0 — Lock the client + discover its convention (MANDATORY, BLOCKING)

Never guess the client or its tags. Resolve the client against **SDR Launch** (its client set
can differ from the GTM email roster) and pull the live convention:

```bash
python3 scripts/phoneburner-convention.py "<what the user said>"   # e.g. "Plan-It"
```

It prints: `client_tag` (e.g. `PlanIt`), the `campaign_tags` already in use, the `lead_scores`
in use, the **`next_lead_score`** to use for a NEW list, and the `sdr_seats` who dial this
client. If the client is ambiguous it exits and lists candidates — **AskUserQuestion** to
confirm, then rerun. If SDR Launch has no history for the client (brand-new to calling),
fall back to `phoneburner-upload.py tags` and confirm the tag scheme with the user.

## Step 1 — Confirm the four routing decisions with the user

From Step 0 you have defaults; confirm anything not already stated in the request:

1. **Owner (SDR seat)** — who dials it. Use a seat from `sdr_seats`; `phoneburner-upload.py
   members --grep <name>` resolves a username. Required.
2. **Campaign tag** — `"<ClientTag>: <Campaign Name>"` (match the existing casing, e.g.
   `PlanIt: GFOA Post-Conference Call-Down`). New campaign → new tag; a re-load of an existing
   campaign → reuse its tag.
3. **Lead Score** — the `next_lead_score` from Step 0 for a NEW list. **Do not reuse an
   existing one.** This is the "won't mix with other lists" identifier.
4. **Fixed customs / folds** — e.g. `Classification=government` for gov lists; fold
   scoring/status columns into notes rather than making new account-wide custom fields.

## Step 2 — DNC scrub (attempt; note the caveat)

```bash
python3 scripts/dnc-scrub.py --client <slug> --input <csv> --output /tmp/clean.csv
```

Suppressed people are dropped. **Known caveat:** if the client isn't wired to the DNC service
(tenant-id ≠ slug) and has no `NEON_<SLUG>_CLIENT_DATA_URL`, the scrub **fails open** ("DNC NOT
APPLIED", all kept UNVERIFIED). Report that plainly — do not present an unscrubbed list as
clean — and proceed only if the user accepts (they may say "ignore DNC for now").

## Step 3 — Dry-run the upload (ALWAYS first)

```bash
python3 scripts/phoneburner-upload.py upload \
  --input <csv> \
  --client-tag <ClientTag> \
  --tag "<ClientTag>: <Campaign Name>" \
  --custom "Lead Score=<NEXT>" \
  --custom "Classification=government" \        # if applicable
  --fold-notes "priority" --fold-notes "gfoa_interest:GFOA interest" --fold-notes "status" \
  --owner <seat>
```

Read the printed payloads back to the user: confirm the phone maps, `title` → `Job Title`,
the folded notes, tags, and Lead Score. It also reports rows skipped for **no phone** — name
them; offer `/find-dials` to fill them rather than dropping silently.

## Step 4 — Apply

Add `--apply --report <out.csv>`. The tool creates one contact per row (no bulk endpoint),
throttled, and writes a per-row result CSV. Expect the write to go through the tool (the
safety classifier allows this vetted path; a raw ad-hoc write script gets blocked).

## Step 5 — Verify + handle overlap

**Always verify under the SEAT's own token** (contacts are per-owner; the admin token can't see
another seat's book — the tool's `backfill` resolves the seat token for you). Spot-check a few
created contacts have the tags + `Lead Score` + `Job Title`.

**Overlap with a prior list is common and expected.** PhoneBurner **de-dupes on email/phone**:
a person already in the seat's book (e.g. on a prior campaign) is **merged** — the new tag is
added, but a `--custom "Lead Score=<NEW>"` on create will **overwrite** their old Lead Score.
When the list likely overlaps a prior campaign for the same client, prefer the **overlap-safe
pattern**: upload WITHOUT `Lead Score` in `--custom`, then

```bash
python3 scripts/phoneburner-upload.py backfill \
  --input <csv> --owner <seat> \
  --match-tag "<ClientTag>: <Campaign Name>" \
  --custom "Classification=government" \
  --lead-score <NEXT> --report <bf.csv> --apply
```

`backfill` sets `Lead Score` on **net-new only** and leaves overlaps' prior Lead Score intact,
matches by email then name, and reports net-new / overlap / unmatched. Investigate any
**unmatched**: usually two rows share one phone (a switchboard line) and merged into one
contact — that's a source-list reality, not a bug; report the collision.

## Step 6 — The saved-search folder (MANUAL — no API)

There is **no saved-search endpoint**. Tell the user to build the smart folder in the
PhoneBurner UI, filtered on the campaign tag (or `Lead Score = <NEXT>`) — that's their
"check the saved search folder" step. The contacts are already correct; this is the last click.

---

## Field mapping (what the tool does)

`first_name`/`last_name` (or a single `name`), `phone`/`direct_dial` (the auto-dial number),
`email`, `company`, `state`, `notes` → native fields. `title` → the `Job Title` custom field.
Any other column → a custom field by its header **unless** you `--fold-notes` it. `--custom
KEY=VALUE` sets a fixed field on every contact. Custom fields are sent as `[{name,type,value}]`
(a plain dict is silently dropped by the API — the tool handles this; don't hand-roll a dict).

## Gotchas (learned 2026-07-21, Planit GFOA)

- **Cloudflare 1010** blocks the default urllib User-Agent — the tool sends a browser UA.
- **`/members` exposes each seat's own bearer token**; the tool uses it so reads/writes hit the
  right per-owner book.
- **A dict `custom_fields` returns 200 but persists nothing** — must be the `{name,type,value}`
  array (fixed in the tool).
- **Shared phone numbers collapse people** — two names on one switchboard line become one
  contact; only one identity survives. Flag it; the fix is a real direct dial (`/find-dials`).
