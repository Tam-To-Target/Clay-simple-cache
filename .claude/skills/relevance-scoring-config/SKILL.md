---
name: relevance-scoring-config
description: >-
  Author, validate, debug, and run AI relevance scoring for Starbridge signals via
  the enrichment API's POST /relevance-score, PUT /relevance-config/:client_id, and
  GET /relevance-config/:client_id. Use when onboarding a client to signal tiering,
  writing or tuning the per-signal-type prompts (Meeting, RFP, Purchase, JobChange,
  Signal, Buyer), setting a client's business context, enabling HubSpot push of the
  tier/points/reasoning onto the Signal object, scoring a batch of Starbridge
  signals, or when someone says "tier these signals", "set up relevance scoring for
  {client}", "the signal tiers look wrong", "why did this signal get Tier 3", "add a
  prompt for RFPs", or "score Starbridge signals into HubSpot". The AI chooses only
  the TIER; points are derived from the tier in code and prompts must never do math
  or define output format.
---

# Relevance-Scoring Config Authoring

Onboard a client to Starbridge signal tiering **end-to-end via the API** — no code
changes, no deploy. You PROPOSE prompts; the server's validator DISPOSES.

Sibling of `fit-scoring-config`. Read that skill first if you don't know it —
this one deliberately inverts one of its rules, and you need to know which.

## The one rule you must never break

**The model chooses the TIER. Nothing else.**

| | Fit score | Relevance score |
|---|---|---|
| Who decides | deterministic engine | **the AI** |
| AI's job | write prose only | **choose a tier** |
| Points | computed from weights | **table lookup from the tier, in code** |

The model returns exactly `{ tier, reasoning }` under a strict JSON schema. It
never returns points, and the system prompt never shows it the point scale — so it
cannot reason backwards from a desired score. A tier outside the client's ladder
is a **hard error**, not clamped.

Consequently: **never put output-format or arithmetic instructions in a prompt.**
The validator rejects `return JSON`, `response_format`, `"points":`, `100/50/20`,
and `sum/multiply … score`. Those fight the service and silently break parsing.

## Endpoints

Auth: `Authorization: Bearer <API_KEY>` on every call.

- `GET /relevance-config/:client_id` — current config, `config_version`,
  configured `signal_types`, resolved `tiers`. **Always read this first.**
- `PUT /relevance-config/:client_id` — create/update. Validates before
  persisting; `422` + per-field `errors` and nothing is stored. Bumps
  `config_version`.
- `POST /relevance-score` — tier ONE signal.

## The scoring payload is the Starbridge response, verbatim

This is the important integration property: **you do not reshape Starbridge's
output.** Take one element of
`GET https://dashboard.starbridge.ai/api/external/feed/all/top-signals` →
`result[]` and pass it as `signal`:

```json
{
  "client_id": "hilight",
  "signal": { "bridge": { "...": "..." }, "row": { "...": "..." } },
  "push_to_hubspot": true
}
```

`bridge` and `row` may also be sent at the top level. Both are **required**:
`bridge.columns` is the schema and `row.columns` is the data keyed by column
*display name*, so neither alone is interpretable.

### What the service extracts for you

You do not need to flatten anything. The parser handles all three Starbridge
schema hazards:

1. **UUID-prefixed keys.** Contact columns arrive as
   `5c9c9c39-…:firstName`; the UUID differs per bridge. Normalized to
   `firstName`, so `include_keys`/`exclude_keys` can reference stable names.
2. **Keyless `AiAnalysis` columns.** These have no `key` at all — only a display
   name (`RFP Score`, `Relevancy Check?`). They are surfaced to the model as
   `prior_ai_columns` and explicitly labelled as *another model's opinion*, not
   primary evidence.
3. **Empty cells.** Starbridge fills cells asynchronously, so a cell can exist
   and be blank. Blanks are dropped — the model sees absent evidence as absent,
   never as a negative.

Identity (`buyer.name`, `buyer.state`, signal type, first-seen date) is lifted to
the top of the evidence block and removed from `fields`, so the model never sees
the same fact twice.

## Config document shape

```json
{
  "ai": {
    "enabled": true,
    "provider": "openai",
    "model": "gpt-5.4-mini",
    "business_context": "Hilight sells all-staff recognition and culture analytics to US K-12 districts. Buyers are district cabinet (Superintendent, Chief HR/Talent, CAO) and Comms leaders. Signals matter most when a district is actively investing in staff culture, engagement measurement, retention, recognition, or strategic planning naming those priorities.",
    "prompts": {
      "Meeting":   { "prompt": "…tier anchors for board meetings…" },
      "RFP":       { "prompt": "…" },
      "Purchase":  { "prompt": "…", "exclude_keys": ["op_template:meeting_sum_relevance"] },
      "JobChange": { "prompt": "…" },
      "Signal":    { "prompt": "…" },
      "Buyer":     { "prompt": "…" }
    },
    "default_prompt": { "prompt": "…conservative fallback for an unknown signal type…" }
  },
  "tiers": [
    { "tier": 1, "points": 100, "label": "Tier 1", "meaning": "so relevant that an SDR should contact this buyer immediately" },
    { "tier": 2, "points": 50,  "label": "Tier 2", "meaning": "a good signal with strong intent, but no immediate action required" },
    { "tier": 3, "points": 20,  "label": "Tier 3", "meaning": "somewhat relevant; useful context only" }
  ],
  "hubspot_push": {
    "enabled": true,
    "object_type": "0-162",
    "signal_id_field": "sb_signal_id",
    "tier_field": "sb_tier",
    "points_field": "sb_score_points",
    "reasoning_field": "sb_ai_reasoning",
    "create_missing": true,
    "pipeline": "ba9cdbd6-e220-45b2-a5a2-d67ebdcbade6",
    "pipeline_stage": "8e2b21d0-7a90-4968-8f8c-a8525cc49c70",
    "field_map": { "buyer_id": "sb_buyer_id" },
    "create_only_fields": ["signal_status"]
  }
}
```

`client_id` and `config_version` in the body are ignored — the server owns them.
`tiers` is optional; omitting it uses the 100/50/20 default. `label` is written
**verbatim** to the HubSpot enumeration property, so it must match an existing
option exactly. `meaning` is injected into the prompt as the tier definition —
that is where tier wording lives, never in prompt text.

## What the prompt must and must not contain

A `prompts.<Type>.prompt` is **only the tier rubric for that signal type**:
concrete anchors saying what makes this type Tier 1 vs 2 vs 3.

The service already supplies, for every type: the business context, the tier
ladder with its meanings, the JSON output contract, and these universal
guardrails — judge only on given evidence, treat missing/`N/A` as absent not
negative, default DOWN when uncertain, treat `prior_ai_columns` as opinion,
weigh recency, 2-3 sentences citing specific evidence.

**Do not restate any of that.** Write the anchors and stop.

Good (Meeting):
```
Tier 1 — the board explicitly approved or funded work on staff culture,
         engagement, retention, recognition, or climate survey.
Tier 2 — a strategic plan or board discussion names those as a goal, with no
         funding or decision yet.
Tier 3 — routine board business only tangentially touching staff topics.
A posted_date older than about six months caps this at Tier 2.
Starbridge's own confidenceScore is an input, not the answer — disagree with it
when the evidence warrants.
```

Bad — every line here is rejected or redundant:
```
Return JSON with tier and points.            ← validator rejects (owns format)
Use the 100/50/20 ladder.                    ← validator rejects (points are ours)
Sum the relevance across fields.             ← validator rejects (arithmetic)
Only judge on the evidence given.            ← already in the system prompt
```

## Per-type traps (measured on 150 real Hilight signals)

These are not hypothetical — each cost a wrong tier in testing.

| Type | Trap | Handling |
|---|---|---|
| **Purchase** | `op_template:meeting_sum_relevance` returns the literal string `"N/A"` (reused template). Prices run as low as **$85** (a junior-high basketball PO). | `"exclude_keys": ["op_template:meeting_sum_relevance"]`, and make the rubric **gate on price** or Purchase floods Tier 1. |
| **Buyer** | No `buyer:name`, no `op:added_date`, no `confidenceScore`. | Parser falls back to `row.name` for the buyer. Tell the rubric that a missing score is **not** negative, and that Tier 1 should be rare — this is enrichment, not an event. |
| **Meeting / RFP / Purchase** | Only these three carry `confidenceScore` (0-5). | Rubric may use it as an input; say explicitly it is not the answer. |
| **JobChange / Signal / Buyer** | **No native score at all** — the reason this endpoint exists. | Rubric must stand alone on the payload fields. |
| **RFP** | `op:due_date` can be in the past. | "An expired due_date can never be Tier 1 — there is nothing to act on." |
| **JobChange** | `jobChange:type` distinguishes `New Joiner` from promotions. | New joiner in a decision seat within ~90 days is the classic Tier 1 window. |
| **All** | `op:until_date` is always empty. | Ignore it. |

## Authoring a config from a brief

1. **Write `business_context` first and get it confirmed by the human.** Every
   tier decision keys off it; a wrong context silently mis-tiers everything. The
   validator enforces ≥40 chars but cannot check accuracy.
2. Pull a real sample per signal type (`top-signals?filterType=RFP&pageSize=5`)
   and read what fields actually arrive. Do not guess the payload.
3. Write one rubric per type present in the client's bridges. Anchor each tier in
   concrete, checkable evidence, not adjectives.
4. Add `exclude_keys` for fields that are present but meaningless.
5. Add a conservative `default_prompt` — otherwise a new bridge type `422`s.
6. `PUT`. On `422`, fix each `errors[].path` and re-PUT.
7. **Hand-check before scaling.** Score ~10 signals spanning every type and read
   every `reasoning`. Tier distribution skewed to Tier 1 almost always means the
   rubric's Tier 1 anchor is too loose, not that the model is wrong.

## Enabling HubSpot push

1. Provision the properties on the client's Signal object. **Don't hand-build them,
   and don't look for this in the hubspot-provisioner** — that app uses the public
   OAuth grant, which cannot reach the Signal object at all. It's an endpoint on
   *this* service, using the client's private-app token:

   ```
   GET  /relevance-provision/:client_id    # dry run: the plan + what already exists
   POST /relevance-provision/:client_id    # create them (idempotent)
   ```

   Order matters: **PUT the config first**, then provision. The plan is derived
   from the stored config — the spine from `field_map`, the verdict properties from
   `tier_field`/`points_field`/`reasoning_field`, and the tier enum's options from
   your **tier ladder labels**. So provisioning and pushing can never drift, and a
   custom label can never be rejected by the enum.

   It skips HubSpot-defined properties (`hs_name`), creates the signal-id property
   with `hasUniqueValue`, never patches an existing definition, and returns `207`
   with `failed[]` if some properties fail. Watch the `warnings` array: a
   pre-existing **non-unique** signal-id property silently breaks the push's record
   lookup and must be recreated.
2. Set the `hubspot_push` block (above). `object_type` defaults to `0-162`,
   `signal_id_field` to `sb_signal_id`.
3. Pass `"push_to_hubspot": true` per call.

**Push UPSERTS the record** — verdict + spine, located by `signal_id_field`:

| Canonical field | Default property |
|---|---|
| `name` | `hs_name` (`row.name` → buyer name → `Starbridge signal <id>`) |
| `signal_id` | `sb_signal_id` |
| `bridge_id`, `bridge_name` | `sb_bridge_id`, `sb_bridge_name` |
| `entity_id`, `entity_type`, `filter_type` | `sb_entity_id`, `sb_entity_type`, `sb_filter_type` |
| `buyer_id`, `buyer_name`, `buyer_state` | `sb_buyer_id`, `sb_buyer_name`, `sb_buyer_state` |
| `added_date`, `created_at`, `updated_at`, `synced_at` | `sb_added_date`, `sb_row_created_at`, `sb_row_updated_at`, `sb_synced_at` |
| `signal_status` | `sb_signal_status` |
| `contact_first_name/last_name/title/email/phone` | `sb_contact_*` |

Override any of them with `field_map`; map to `""` to stop writing one.

It does **not** write the wider Starbridge payload — the ~43 detail properties and
the raw JSON blobs belong to the bulk sync, which owns them.

Behavior:
- record found → **update** (`push_action: "updated"`);
- not found → **create** (`push_action: "created"`), unless `create_missing:false`;
- more than one sharing that signal id → `push_error`, refuses to guess. Dedupe,
  or pass an explicit `hubspot_object_id`.

### Authentication: a per-client private-app token (required for push)

**Record access to the Signal object is not available to a public OAuth app at any
scope.** HubSpot answers *"The scope needed for this API call isn't available for
public use"* on record read/search/write for `0-162`; only the object's SCHEMA
endpoints are grantable. Granting `crm.objects.services.*` to the provisioner app
does **not** fix this — do not go down that road again.

So the push authenticates with a **HubSpot private-app token stored per client**.
Everything else in the service keeps using the provisioner's OAuth grant; the token
is scoped to this endpoint by construction (its own column on the relevance config,
read only by the push, threaded explicitly into the three HubSpot calls).

Set it through the normal config API — no env var, no redeploy per client:

```json
"hubspot_push": { "enabled": true, "private_app_token": "pat-na1-…", "...": "..." }
```

It is **write-only**: stripped from the stored document and never returned. `GET`
reports `private_app_token_set: true|false`.

| `private_app_token` | Effect |
|---|---|
| omitted | keep the token on file — a routine prompt edit never resends the secret |
| a value | replace it |
| `""` | clear it |

Requesting a push with no token on file → `422` **before** the model is billed.
A `401` from the token is final; private-app tokens are not refreshable, so the
push does not retry. If you see one, the private app was deleted or its scopes
were narrowed in the portal.

The private app needs `crm.objects.services.read` + `.write` (plus
`crm.schemas.services.read` to inspect properties).

### Three traps in the push

- **`pipeline_stage` is required when `create_missing` is on** (the default). The
  Signal object declares `hs_pipeline_stage` mandatory, so a create without it
  fails. The validator rejects the config rather than letting every create 400.
  On Hilight: pipeline `ba9cdbd6-e220-45b2-a5a2-d67ebdcbade6`, stage "New"
  `8e2b21d0-7a90-4968-8f8c-a8525cc49c70`. Stage is written on create only — it is
  the record's own workflow state afterwards, not ours.
- **`create_only_fields` defaults to `["signal_status"]`, and you should leave it
  there.** Starbridge's `common:status` reads `"New"` on every signal we have ever
  seen; HubSpot is where a rep moves it to Actioned/Saved/Not Interested.
  Re-pushing it on each re-score would silently reset the rep's work.
- **Bad enum values are dropped, not sent.** An unrecognized `filterType`,
  `entity.type` or status would 400 the entire push, so it is omitted. If a tier
  lands but `sb_filter_type` is empty, a new Starbridge type has appeared — add a
  prompt for it and, if needed, a HubSpot enum option.

The client's HubSpot token is resolved server-side — **never pass a token.**

## Debugging

- **"Why did this get Tier 3?"** Read `reasoning` and `evidence_fields` in the
  response. `evidence_fields` is exactly what the model saw. If a decisive field
  is missing from that list, the bug is upstream (an `include_keys` that's too
  narrow, or an empty Starbridge cell), not in the prompt.
- **`422 No prompt configured for signal type "X"`** — a new bridge type appeared.
  Add `ai.prompts.X` or a `default_prompt`.
- **`502 Relevance classification failed`** — upstream model failure. Check the
  server's `OPENAI_API_KEY`, and the error text for a rate limit or a bad model
  name in `ai.model` / per-type `model`.
- **`Model returned an unknown tier`** — the prompt is fighting the ladder
  (usually inventing a "Tier 4" or a "not relevant" bucket). Either add that tier
  to `tiers` or fix the rubric.
- **Same signal, different tier across runs** — `temperature` is 0, so drift means
  the *evidence* changed. Starbridge fills cells asynchronously; compare
  `evidence_fields` between runs. This is also why the cache keys on the evidence
  hash rather than on `rowId`.
- **Re-scoring history after a prompt change:** a `PUT` bumps `config_version`,
  which invalidates the cache by construction. Old `relevance_results` rows keep
  their old version, so a past tier stays explainable against the prompt that
  produced it.

## Never do

- Never let the model set or see the point value.
- Never restate the output format or the tier ladder inside a prompt.
- Never write the Starbridge payload properties from this path — the bulk sync owns them.
- Never remove `signal_status` from `create_only_fields` without a reason; it resets rep state.
- Never accept an API key from a caller.
- Never ship a `business_context` a human hasn't confirmed.
- Never scale a batch before hand-reading ~10 reasonings.
