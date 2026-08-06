/**
 * Deterministic validation of a relevance config — runs on PUT BEFORE persisting.
 *
 * Same contract as the fit-scoring validator: an agent may PROPOSE a config from
 * a brief, this validator DISPOSES. An invalid document is never stored and the
 * caller gets a per-field error list.
 *
 * Because relevance scoring is AI-only, the things worth validating are
 * different from fit scoring — there are no weights to sum. What matters:
 *  - business_context is present and substantial (every tier keys off it)
 *  - at least one signal-type prompt exists
 *  - prompts carry no output-format or arithmetic instructions (the service owns
 *    the JSON contract; a prompt that redefines it silently breaks parsing)
 *  - the tier ladder is complete, unique, and descending in points
 *  - hubspot_push.enabled ⇒ all three verdict fields present
 */
import { DEFAULT_TIERS } from "./types";
import { FIELD_NAMES } from "./hubspot-fields";
import { DEFAULT_STRATEGIES } from "./association";
import type { RelevanceConfigDoc, RelevancePromptConfig } from "./types";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** business_context shorter than this is almost certainly a placeholder. */
export const MIN_BUSINESS_CONTEXT = 40;

/**
 * Phrases that indicate a prompt is trying to own the output format or do
 * arithmetic. The service supplies a strict JSON schema and derives points from
 * the tier; a prompt that also specifies output shape fights it.
 */
const FORBIDDEN_PROMPT_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\breturn\s+json\b/i, why: "the service owns the JSON output contract — do not restate it" },
  { re: /\bresponse[_ ]format\b/i, why: "the service owns the JSON output contract" },
  { re: /"?\bpoints"?\s*[:=]/i, why: "points are derived in code from the tier — never set them in a prompt" },
  { re: /\b(sum|multiply|add up|average)\b.*\b(score|points)\b/i, why: "no arithmetic in prompts" },
  { re: /\b100\s*\/\s*50\s*\/\s*20\b/, why: "the tier→points ladder lives in `tiers`, not in prompt text" },
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Association strategies accepted in `hubspot_push.association.strategies`. */
const ALLOWED_STRATEGIES: string[] = DEFAULT_STRATEGIES;

function validatePrompt(
  p: unknown,
  at: string,
  err: (path: string, message: string) => void
): void {
  if (!isObject(p)) {
    err(at, "must be an object with a `prompt` string");
    return;
  }
  const cfg = p as Partial<RelevancePromptConfig>;
  if (typeof cfg.prompt !== "string" || cfg.prompt.trim().length < 20) {
    err(`${at}.prompt`, "a non-trivial prompt string is required (the tier rubric for this signal type)");
  } else {
    for (const { re, why } of FORBIDDEN_PROMPT_PATTERNS) {
      if (re.test(cfg.prompt)) err(`${at}.prompt`, `remove output-format/arithmetic instructions: ${why}`);
    }
  }
  for (const k of ["include_keys", "exclude_keys"] as const) {
    const v = cfg[k];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
      err(`${at}.${k}`, "must be an array of strings (normalized column keys)");
    }
  }
  if (cfg.include_keys?.length && cfg.exclude_keys?.length) {
    err(
      `${at}.exclude_keys`,
      "include_keys and exclude_keys are mutually exclusive — include_keys already restricts the payload"
    );
  }
  if (cfg.model !== undefined && typeof cfg.model !== "string") {
    err(`${at}.model`, "must be a string when present");
  }
}

export function validateRelevanceConfig(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  if (!isObject(input)) {
    return { valid: false, errors: [{ path: "$", message: "config must be a JSON object" }] };
  }
  const config = input as Partial<RelevanceConfigDoc>;

  // ── ai block ────────────────────────────────────────────────────────────
  if (!isObject(config.ai)) {
    err("ai", "an `ai` object is required (business_context + prompts)");
    return { valid: false, errors };
  }
  const ai = config.ai as any;

  if (typeof ai.enabled !== "boolean") err("ai.enabled", "must be a boolean");
  if (ai.provider !== undefined && String(ai.provider).toLowerCase() !== "openai") {
    err("ai.provider", 'only "openai" is supported');
  }
  if (typeof ai.business_context !== "string" || ai.business_context.trim().length < MIN_BUSINESS_CONTEXT) {
    err(
      "ai.business_context",
      `required, and must be at least ${MIN_BUSINESS_CONTEXT} chars — every tier decision keys off it`
    );
  }

  if (!isObject(ai.prompts) || Object.keys(ai.prompts).length === 0) {
    err("ai.prompts", "at least one signal-type prompt is required, keyed by Starbridge filterType");
  } else {
    for (const [type, p] of Object.entries(ai.prompts)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(type)) {
        err(`ai.prompts.${type}`, "key must be a Starbridge filterType (e.g. Meeting, RFP, JobChange)");
      }
      validatePrompt(p, `ai.prompts.${type}`, err);
    }
  }
  if (ai.default_prompt !== undefined) validatePrompt(ai.default_prompt, "ai.default_prompt", err);

  // ── tiers ───────────────────────────────────────────────────────────────
  if (config.tiers !== undefined) {
    if (!Array.isArray(config.tiers) || config.tiers.length === 0) {
      err("tiers", "must be a non-empty array when present (omit it to use the 100/50/20 default)");
    } else {
      const seen = new Set<number>();
      let prevPoints = Infinity;
      config.tiers.forEach((raw: unknown, i: number) => {
        const at = `tiers[${i}]`;
        if (!isObject(raw)) {
          err(at, "must be an object");
          return;
        }
        const t = raw as { tier?: number; points?: number; label?: string; meaning?: string };
        if (!Number.isInteger(t.tier) || (t.tier as number) < 1) {
          err(`${at}.tier`, "must be a positive integer");
        } else if (seen.has(t.tier as number)) {
          err(`${at}.tier`, `duplicate tier ${t.tier}`);
        } else {
          seen.add(t.tier as number);
        }

        if (typeof t.points !== "number" || !Number.isFinite(t.points)) {
          err(`${at}.points`, "must be a number");
        } else {
          // Descending points make the tier a usable sort key; an inverted
          // ladder would silently rank Tier 3 above Tier 1 in HubSpot.
          if (t.points > prevPoints) err(`${at}.points`, "tiers must be ordered by DESCENDING points");
          prevPoints = t.points;
        }
        if (typeof t.label !== "string" || !t.label.trim()) {
          err(`${at}.label`, "required — this exact string is written to the HubSpot tier property");
        }
        if (typeof t.meaning !== "string" || !t.meaning.trim()) {
          err(`${at}.meaning`, "required — it is injected into the prompt as the tier definition");
        }
      });
    }
  }

  // ── hubspot_push ────────────────────────────────────────────────────────
  if (config.hubspot_push !== undefined) {
    const push = config.hubspot_push as any;
    if (!isObject(push)) {
      err("hubspot_push", "must be an object");
    } else if (push.enabled) {
      for (const f of ["tier_field", "points_field", "reasoning_field"] as const) {
        if (typeof push[f] !== "string" || !push[f].trim()) {
          err(`hubspot_push.${f}`, "required when hubspot_push.enabled is true");
        }
      }
      for (const f of ["object_type", "signal_id_field", "pipeline", "pipeline_stage"] as const) {
        if (push[f] !== undefined && (typeof push[f] !== "string" || !push[f].trim())) {
          err(`hubspot_push.${f}`, "must be a non-empty string when present");
        }
      }
      // Creating a Signal record requires hs_pipeline_stage on the HubSpot side.
      // Fail here with an explanation rather than letting every create 400.
      if (push.create_missing !== false && (typeof push.pipeline_stage !== "string" || !push.pipeline_stage.trim())) {
        err(
          "hubspot_push.pipeline_stage",
          "required when create_missing is enabled (the default) — the Signal object declares " +
            "hs_pipeline_stage mandatory, so a create without it fails. Set create_missing:false " +
            "to only score already-synced signals."
        );
      }
      if (push.create_missing !== undefined && typeof push.create_missing !== "boolean") {
        err("hubspot_push.create_missing", "must be a boolean");
      }
      if (push.field_map !== undefined) {
        if (!isObject(push.field_map)) {
          err("hubspot_push.field_map", "must be an object of { canonical_field: hubspot_property }");
        } else {
          for (const [k, v] of Object.entries(push.field_map)) {
            if (!FIELD_NAMES.includes(k)) {
              err(`hubspot_push.field_map.${k}`, `unknown field (allowed: ${FIELD_NAMES.join(", ")})`);
            }
            if (typeof v !== "string") {
              err(`hubspot_push.field_map.${k}`, 'must be a string (use "" to stop writing this field)');
            }
          }
          // The upsert key must actually be written, and must be the SAME property
          // the push searches on. If these diverge, no push ever finds its record
          // and every call creates a duplicate.
          const mappedId = push.field_map.signal_id;
          if (mappedId === "") {
            err(
              "hubspot_push.field_map.signal_id",
              "cannot be disabled — it is the upsert key; without it every push creates a new record"
            );
          } else if (typeof mappedId === "string") {
            const searchField = push.signal_id_field || "sb_signal_id";
            if (mappedId !== searchField) {
              err(
                "hubspot_push.field_map.signal_id",
                `must equal hubspot_push.signal_id_field ("${searchField}") — the property written must be ` +
                  `the one searched on, or every push creates a duplicate record`
              );
            }
          }
          // hs_name is mandatory on the Signal object, so a create without it fails.
          if (push.field_map.name === "" && push.create_missing !== false) {
            err(
              "hubspot_push.field_map.name",
              "cannot be disabled while create_missing is enabled — hs_name is a required property on create"
            );
          }
        }
      }
      // ── association ──────────────────────────────────────────────────────
      // Misconfiguring this does not fail loudly at push time (association
      // errors are non-fatal by design), so it has to fail loudly here instead.
      if (push.association !== undefined) {
        const assoc = push.association as any;
        if (!isObject(assoc)) {
          err("hubspot_push.association", "must be an object");
        } else {
          if (assoc.enabled !== undefined && typeof assoc.enabled !== "boolean") {
            err("hubspot_push.association.enabled", "must be a boolean");
          }
          for (const f of [
            "object_type", "buyer_id_property", "domain_property", "name_property", "state_property",
          ] as const) {
            if (assoc[f] !== undefined && (typeof assoc[f] !== "string" || !assoc[f].trim())) {
              err(`hubspot_push.association.${f}`, "must be a non-empty string when present");
            }
          }
          if (assoc.strategies !== undefined) {
            if (!Array.isArray(assoc.strategies) || !assoc.strategies.length) {
              err(
                "hubspot_push.association.strategies",
                `must be a non-empty array ordered by preference (allowed: ${ALLOWED_STRATEGIES.join(", ")})`
              );
            } else {
              for (const s of assoc.strategies) {
                if (!ALLOWED_STRATEGIES.includes(s)) {
                  err(
                    "hubspot_push.association.strategies",
                    `unknown strategy "${s}" (allowed: ${ALLOWED_STRATEGIES.join(", ")})`
                  );
                }
              }
            }
          }
          if (assoc.on_multiple !== undefined && !["primary", "all", "skip"].includes(String(assoc.on_multiple))) {
            err("hubspot_push.association.on_multiple", 'must be one of "primary", "all", "skip"');
          }
          if (
            assoc.association_type_id !== undefined &&
            assoc.association_type_id !== null &&
            (typeof assoc.association_type_id !== "number" || !Number.isInteger(assoc.association_type_id))
          ) {
            err(
              "hubspot_push.association.association_type_id",
              "must be an integer, or null to use HubSpot's default association type for the pair"
            );
          }
          if (
            assoc.create_missing_company !== undefined &&
            typeof assoc.create_missing_company !== "boolean"
          ) {
            err("hubspot_push.association.create_missing_company", "must be a boolean");
          }
        }
      }
      // Write-only secret. Validate shape only; never echoed back anywhere.
      if (push.private_app_token !== undefined && typeof push.private_app_token !== "string") {
        err("hubspot_push.private_app_token", 'must be a string (use "" to clear the stored token)');
      }
      if (push.create_only_fields !== undefined) {
        if (!Array.isArray(push.create_only_fields) || push.create_only_fields.some((x: unknown) => typeof x !== "string")) {
          err("hubspot_push.create_only_fields", "must be an array of canonical field names");
        } else {
          for (const f of push.create_only_fields) {
            if (!FIELD_NAMES.includes(f)) {
              err("hubspot_push.create_only_fields", `unknown field "${f}" (allowed: ${FIELD_NAMES.join(", ")})`);
            }
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Resolve the effective tier ladder (config override or the 100/50/20 default). */
export function resolveTiers(config: RelevanceConfigDoc) {
  return config.tiers && config.tiers.length ? config.tiers : DEFAULT_TIERS;
}
