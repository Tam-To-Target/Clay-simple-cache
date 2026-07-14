---
name: fit-scoring-config
description: >-
  Author, validate, and debug a client's config-driven fit-scoring rubric for
  the enrichment API's /score, PUT /config, and GET /config endpoints. Use when
  onboarding a new client to fit scoring, translating a natural-language client
  brief into a scoring config, adjusting weights/tiers/criteria for an existing
  client, writing or fixing a reasoning prompt, enabling HubSpot push of the
  score + reasoning, or when someone says "score districts for {client}", "set
  up fit scoring for {client}", "the fit scores look wrong", "add a criterion",
  or "tune the rubric". The engine computes ALL scores deterministically; the AI
  proposes config and writes reasoning prose only — it never computes a score.
---

# Fit-Scoring Config Authoring

This skill lets an agent onboard a client to fit scoring **end-to-end via the
API** — no code changes, no deploy. You PROPOSE a config from a client brief; the
server's validator DISPOSES; the deterministic engine does all the scoring.

## The one rule you must never break

**Scoring is 100% deterministic in the engine. The AI touches ONLY the reasoning
text.** Never put calculation into the config: no "multiply the weights", no
"sum and round", no `calc` field, no "the score must equal…". The engine owns
every subscore and the final score. The client `prompt` holds only: business
context, number→word translation rules, missing-data handling, and instructions
to end with the recommendation verbatim.

## Endpoints

Auth: `Authorization: Bearer <API_KEY>` on every call.

- `PUT /config/:client_id` — create/update a rubric. Validates before persisting;
  invalid config returns `422` with a per-field `errors` list and is NOT stored.
  Success bumps `config_version`.
- `GET /config/:client_id` — read the current config + resolved `config_version`.
  **Always read this first** when debugging or proposing an edit.
- `POST /fit-score` — score one target (this is the fit score; other score types
  will get their own paths). `/score` is a temporary backward-compatible alias.
  Body `{ client_id, account_name, account_domain, starbridge_id, values,
  reasoning?, push_to_hubspot?, hubspot_object_id?, hubspot_object_type? }`.

**Required identity properties (outside `values`):** every `/fit-score` call must
send `account_name`, `account_domain`, and `starbridge_id` — missing any → `422`
with `missing_fields`. These are our primary HubSpot ID properties and are written
to the record on push. They map to HubSpot property names via
`hubspot_push.identity_fields` (defaults: `name` / `domain` / `starbridge_id`).

**Reasoning toggle:** reasoning is ON by default (subject to `reasoning.enabled` in
the config). Pass `"reasoning": false` on a call to skip the LLM (e.g. cheap bulk
scoring) — the deterministic score is still returned. The flag can only suppress,
never force reasoning on when the config disables it.

## Config document shape

```json
{
  "client_id": "hilight",
  "criteria": [ /* see criterion types below */ ],
  "reasoning": {
    "enabled": true,
    "provider": "openai",
    "model": "gpt-5.4-mini",
    "prompt": "…business context + word rules, NO math…",
    "recommendation_bands": [
      { "min": 80, "max": 100, "label": "Prioritize now" },
      { "min": 65, "max": 79,  "label": "Worth a call" },
      { "min": 50, "max": 64,  "label": "Enrich first" },
      { "min": 0,  "max": 49,  "label": "Deprioritize" }
    ]
  },
  "hubspot_push": {
    "enabled": false,
    "score_field": "lead_fit_score",
    "reasoning_field": "lead_fit_score_reasoning"
  }
}
```

`client_id` and `config_version` in the body are ignored — the server owns them
(client_id comes from the URL, version auto-increments).

## Criterion types

Criterion **types are code** (tested, versioned). Their **parameters are data**
(the JSON below). If a client needs logic no type covers, DO NOT invent nested
conditionals in config — request a new criterion type in code. Three types cover
~90% of cases. Every criterion carries a `weight`; **weights must sum to 1.0**
(the validator rejects anything else — it never normalizes for you).

### 1. `numeric_tiers` — value falls into a `[min, max)` band
Use for enrollment, income — anything on a numeric scale. Tiers must be sorted,
contiguous (no gaps/overlaps), and only the **last** tier may have `max: null`
(open-ended). `min` is inclusive, `max` is exclusive.
```json
{
  "key": "total_enrollment", "type": "numeric_tiers", "weight": 0.40,
  "tiers": [
    { "min": 0,     "max": 1000,  "score": 20 },
    { "min": 1000,  "max": 5000,  "score": 60 },
    { "min": 5000,  "max": 18000, "score": 90 },
    { "min": 18000, "max": null,  "score": 100 }
  ]
}
```

### 2. `categorical` — value matched against a `{ key: score }` map
Use for enrollment trend, tier labels, any text field. `default` is **required**
(the score for a present-but-unmatched value). Set `"contains": true` for
substring matching (case-insensitive).
```json
{
  "key": "enrollment_trend", "type": "categorical", "weight": 0.15,
  "map": { "growing": 100, "stable": 60, "declining": 20 }, "default": 0
}
```

### 3. `passthrough` — value is already 0-100, used directly
Use for propensity-to-spend from Starbridge. Clamped to 0-100. Optional linear
rescale for a differently-scaled input: `"rescale": { "in_min": 0, "in_max": 5 }`.
```json
{ "key": "propensity_to_spend", "type": "passthrough", "weight": 0.30 }
```

### Optional: `required` and `labels`
- `"required": false` — an absent value is scored `missing` (subscore 0, flagged)
  instead of triggering a `422`. Default is `true`.
- `"labels": [{ "min": 80, "max": 100, "label": "large" }]` — optional subscore→
  word bands. When present the engine resolves an explicit word for the reasoning
  context. When absent, the model translates value+subscore per its prompt.

## Missing-data semantics (important)

- Required criterion key **absent from `values`** → `POST /score` returns `422`
  with `missing_keys`. This is a caller integration bug (they forgot the field).
- Key **present but null/blank/unparseable** → subscore 0 + `missing: true`, and
  scoring proceeds. This drives the "data was missing, don't penalize fit"
  reasoning behavior. Your prompt must handle it (see below).

## Authoring a config from a client brief

1. Extract the **metrics** the client cares about and the **data fields** you can
   feed them (from Clay/Starbridge/HubSpot). Each metric → one criterion.
2. Pick a **type** per metric (numeric scale → `numeric_tiers`; text/enum →
   `categorical`; already-0-100 signal → `passthrough`).
3. Set **tiers/maps** from the brief's thresholds (e.g. "districts over 18k are
   ideal, proven customers run 1k–18k" → the enrollment tiers above).
4. Set **weights** reflecting the client's priorities; **make them sum to 1.0**.
5. Write the **reasoning prompt** (next section) and the **recommendation_bands**
   (contiguous, covering 0-100).
6. `PUT /config/:client_id`. If it `422`s, fix each `errors[].path` and re-PUT.
7. Validate with `POST /score` on a few known targets; sanity-check the numbers
   by hand (subscore × weight, summed, rounded).

## Writing the reasoning prompt

The prompt gets a structured context block (each metric's value, subscore,
weight, `missing` flag, optional label; plus the resolved recommendation). It
writes prose from that. It must NOT output numbers or do math. Reference example
(Hilight — calculation fully stripped out; store as `reasoning.prompt`):

```
You write a plain-English fit briefing for ONE K-12 district for a sales rep. The
final score and all subscores have ALREADY been computed for you — do not do any
math, do not mention numbers, do not output a score.
ABOUT HILIGHT: All-staff recognition & culture platform for K-12 districts.
Discretionary retention/culture buy; deal size scales with district size (more
staff = bigger contract). Bigger, funded, stable-to-growing districts fit best,
but proven customers range ~1,000 to ~18,000 students, and low-income districts
still buy via Title/state funds.
WRITE 2-4 SENTENCES. Brief a rep, not an analyst. No formulas, no math, no rubric
jargon, no numbers at all. Describe each metric in WORDS only:

Enrollment -> "large" / "mid-sized" / "small" district
Propensity -> "strong" / "moderate" / "weak" budget/spend signal
Income -> "high" / "moderate" / "lower" funding capacity
Trend -> "growing" / "stable" / "declining" enrollment
Translate those into meaning: what the district's size implies for deal size,
whether budget signals are strong or weak, and what income and enrollment trend
suggest.
If any metric is flagged as MISSING, say that metric's data was missing and that
it held the score down — do NOT call the district a poor fit because of missing
data.
Keep the tone consistent with the recommendation. End with the one-line
recommendation you are given, verbatim.
```

Note what's absent: no weights, no "multiply/sum/round", no `calc`. That logic is
the engine's. The prompt keeps only context + word rules + missing-data handling
+ "end with the recommendation verbatim".

## Enabling HubSpot push

1. Pre-create the two HubSpot properties in the client's portal (a number field
   for the score, a text/long-text field for the reasoning). The identity target
   properties (`name`, `domain`, `starbridge_id`) must also exist — `name`/`domain`
   are Company defaults; `starbridge_id` is custom (assumed to exist).
2. Set in config:
   ```json
   "hubspot_push": {
     "enabled": true,
     "score_field": "lead_fit_score",
     "reasoning_field": "lead_fit_score_reasoning",
     "object_type": "companies",
     "identity_fields": {
       "account_name": "name",
       "account_domain": "domain",
       "starbridge_id": "starbridge_id"
     }
   }
   ```
   The validator requires `score_field` + `reasoning_field` when `enabled`.
   `object_type` (default `"companies"`) and `identity_fields` (defaults shown) are
   optional — omit `identity_fields` to use the defaults.
3. Per call, pass `"push_to_hubspot": true` and `"hubspot_object_id": "<id>"`
   (the record to write onto). The score → `score_field`, reasoning →
   `reasoning_field`, and the three identity props → their mapped HubSpot fields,
   all PATCHed onto that record. The API resolves the client's HubSpot token
   server-side via the provisioner — **never pass a token**.
4. `422` if push is requested but `hubspot_push` isn't enabled/configured or
   `hubspot_object_id` is missing. The score is still computed and returned.

## Debugging with GET /config

- `GET /config/:client_id` to see exactly what's stored and the live
  `config_version`. Diff against what you intended.
- If `POST /score` returns `422 missing_keys`, the caller isn't sending those
  criterion keys — check the field mapping upstream (Clay/Starbridge), not the
  config.
- If a score looks wrong: read the `per_criterion` array in the `/score`
  response — it shows each `value`, `subscore`, `weight`, and `missing`. Recompute
  `Σ subscore×weight` by hand; if it matches `final_score`, the rubric is doing
  what it says and the fix is a tier/weight/map edit, not a bug.
- If reasoning is `null`: reasoning is non-fatal. Check `push_error`/logs — usually
  `reasoning.enabled=false`, a missing server `OPENAI_API_KEY`, or a model error.

## Never do

- Never let the model compute or alter the score or the recommendation.
- Never build nested boolean/rules logic in config — add a criterion type in code.
- Never accept an API key from a caller.
- Never auto-normalize invalid weights — surface the `422` and fix the weights.
