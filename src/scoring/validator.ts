/**
 * Deterministic config validation — runs on PUT /config BEFORE persisting.
 *
 * This is where AI-assisted authoring is made safe: an agent may PROPOSE a
 * config from a natural-language brief, but this validator DISPOSES. An invalid
 * config is never stored; the caller gets a per-field error list to fix.
 *
 * Rules (from the build spec):
 *  - weights sum to 1.0 within a small tolerance (NEVER silently normalize).
 *  - numeric_tiers: sorted, no overlaps, no gaps, max:null only on the last tier.
 *  - categorical: keys unique, `default` present.
 *  - criterion `key`s unique across the config.
 *  - hubspot_push.enabled ⇒ both field names present.
 *  - reasoning.enabled ⇒ prompt + recommendation_bands present, bands contiguous
 *    and covering 0-100.
 */
import { isKnownCriterionType, CRITERION_TYPES } from "./criteria";
import type { ScoringConfigDoc } from "./types";

/** Weights may drift from 1.0 by at most this (floating-point + author slack). */
export const WEIGHT_TOLERANCE = 1e-6;

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateConfig(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });

  if (!isObject(input)) {
    return { valid: false, errors: [{ path: "$", message: "config must be a JSON object" }] };
  }
  const config = input as Partial<ScoringConfigDoc>;

  if (!Array.isArray(config.criteria) || config.criteria.length === 0) {
    err("criteria", "at least one criterion is required");
    // Without criteria the rest can't be checked meaningfully.
    return { valid: false, errors };
  }

  // ── Per-criterion structure + uniqueness ────────────────────────────────
  const seenKeys = new Set<string>();
  let weightSum = 0;

  config.criteria.forEach((c: any, i: number) => {
    const at = `criteria[${i}]`;
    if (!c || typeof c !== "object") {
      err(at, "criterion must be an object");
      return;
    }
    if (typeof c.key !== "string" || !c.key.trim()) {
      err(`${at}.key`, "key is required and must be a non-empty string");
    } else if (seenKeys.has(c.key)) {
      err(`${at}.key`, `duplicate criterion key "${c.key}" (keys must be unique)`);
    } else {
      seenKeys.add(c.key);
    }

    if (typeof c.type !== "string" || !isKnownCriterionType(c.type)) {
      err(`${at}.type`, `unknown type "${c.type}"; supported: ${CRITERION_TYPES.join(", ")}`);
    }

    if (typeof c.weight !== "number" || !Number.isFinite(c.weight) || c.weight < 0) {
      err(`${at}.weight`, "weight must be a non-negative number");
    } else {
      weightSum += c.weight;
    }

    if (c.labels !== undefined) validateLabels(c.labels, `${at}.labels`, err);

    if (c.type === "numeric_tiers") validateTiers(c.tiers, `${at}.tiers`, err);
    if (c.type === "categorical") validateCategorical(c, at, err);
    if (c.type === "passthrough") validateRescale(c.rescale, `${at}.rescale`, err);
  });

  // ── Weights sum to 1.0 (surface, do not normalize) ──────────────────────
  if (Math.abs(weightSum - 1) > WEIGHT_TOLERANCE) {
    err(
      "criteria",
      `weights must sum to 1.0; got ${weightSum} (off by ${(weightSum - 1).toFixed(6)}). Fix the weights — the engine does not normalize.`
    );
  }

  // ── reasoning ────────────────────────────────────────────────────────────
  // The engine resolves the recommendation from recommendation_bands
  // UNCONDITIONALLY (regardless of reasoning.enabled), so validate their 0-100
  // coverage whenever they are present — otherwise a config with bands but
  // reasoning disabled could pass with a gap and silently return a null
  // recommendation at score time.
  const bands = config.reasoning?.recommendation_bands;
  if (Array.isArray(bands) && bands.length) {
    validateBandsCover0to100(bands, "reasoning.recommendation_bands", err);
  }
  if (config.reasoning && config.reasoning.enabled) {
    const r = config.reasoning;
    if (!r.prompt || !String(r.prompt).trim()) {
      err("reasoning.prompt", "prompt is required when reasoning.enabled");
    }
    if (!Array.isArray(r.recommendation_bands) || r.recommendation_bands.length === 0) {
      err("reasoning.recommendation_bands", "recommendation_bands required when reasoning.enabled");
    }
  }

  // ── hubspot_push ──────────────────────────────────────────────────────────
  if (config.hubspot_push && config.hubspot_push.enabled) {
    const h = config.hubspot_push;
    if (!h.score_field || !String(h.score_field).trim()) {
      err("hubspot_push.score_field", "score_field required when hubspot_push.enabled");
    }
    if (!h.reasoning_field || !String(h.reasoning_field).trim()) {
      err("hubspot_push.reasoning_field", "reasoning_field required when hubspot_push.enabled");
    }
    // identity_fields is an optional { account_name?, account_domain?,
    // starbridge_id? } → HubSpot-property map; unset keys use defaults.
    if (h.identity_fields !== undefined) {
      const idf = h.identity_fields as Record<string, unknown>;
      if (typeof idf !== "object" || idf === null || Array.isArray(idf)) {
        err("hubspot_push.identity_fields", "identity_fields must be an object mapping identity keys to HubSpot property names");
      } else {
        for (const [k, v] of Object.entries(idf)) {
          if (!["account_name", "account_domain", "starbridge_id"].includes(k)) {
            err(`hubspot_push.identity_fields.${k}`, "unknown identity key (allowed: account_name, account_domain, starbridge_id)");
          } else if (typeof v !== "string" || !v.trim()) {
            err(`hubspot_push.identity_fields.${k}`, "mapped HubSpot property name must be a non-empty string");
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

type Err = (path: string, message: string) => void;

/** numeric_tiers: sorted ascending, contiguous (no gaps), no overlaps, one open top. */
function validateTiers(tiers: unknown, path: string, err: Err): void {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    err(path, "numeric_tiers requires a non-empty tiers array");
    return;
  }
  let prevMax: number | null = null;
  tiers.forEach((t: any, i: number) => {
    const at = `${path}[${i}]`;
    const isLast = i === tiers.length - 1;
    if (typeof t?.min !== "number" || !Number.isFinite(t.min)) {
      err(`${at}.min`, "min must be a finite number");
    }
    if (t?.max !== null && (typeof t?.max !== "number" || !Number.isFinite(t.max))) {
      err(`${at}.max`, "max must be a finite number, or null on the last tier only");
    }
    if (t?.max === null && !isLast) {
      err(`${at}.max`, "max:null is allowed only on the last tier");
    }
    if (typeof t?.score !== "number" || !Number.isFinite(t.score)) {
      err(`${at}.score`, "score must be a finite number");
    } else if (t.score < 0 || t.score > 100) {
      err(`${at}.score`, `score must be within 0-100 (got ${t.score}); subscores are 0-100 signals, the engine does not normalize`);
    }
    if (typeof t?.min === "number" && typeof t?.max === "number" && t.max <= t.min) {
      err(`${at}`, `empty/inverted range: max (${t.max}) must be > min (${t.min})`);
    }
    // Contiguity: each tier's min must equal the previous tier's max (no gap,
    // no overlap). First tier sets the domain floor.
    if (i > 0 && typeof t?.min === "number") {
      if (prevMax === null) {
        err(`${at}`, "a tier follows an open-ended (max:null) tier — max:null must be last");
      } else if (t.min !== prevMax) {
        err(
          `${at}.min`,
          `must equal previous tier's max (${prevMax}) — ${t.min > prevMax ? "gap" : "overlap"} detected`
        );
      }
    }
    prevMax = t?.max ?? null;
  });
}

function validateCategorical(c: any, at: string, err: Err): void {
  if (!c.map || typeof c.map !== "object" || Array.isArray(c.map)) {
    err(`${at}.map`, "categorical requires a { key: score } map object");
  } else {
    const keys = Object.keys(c.map);
    if (keys.length === 0) err(`${at}.map`, "map must have at least one entry");
    // JSON object keys are inherently unique; guard case-insensitive collisions.
    const lower = new Set<string>();
    for (const k of keys) {
      const lk = k.toLowerCase();
      if (lower.has(lk)) err(`${at}.map`, `case-insensitive duplicate map key "${k}"`);
      lower.add(lk);
      const v = c.map[k];
      if (typeof v !== "number") err(`${at}.map.${k}`, "map values must be numbers");
      else if (v < 0 || v > 100) err(`${at}.map.${k}`, `score must be within 0-100 (got ${v})`);
    }
  }
  if (typeof c.default !== "number" || !Number.isFinite(c.default)) {
    err(`${at}.default`, "categorical requires a numeric `default`");
  } else if (c.default < 0 || c.default > 100) {
    err(`${at}.default`, `default must be within 0-100 (got ${c.default})`);
  }
}

function validateRescale(rescale: any, path: string, err: Err): void {
  if (rescale === undefined) return;
  if (typeof rescale !== "object" || rescale === null) {
    err(path, "rescale must be an object { in_min, in_max }");
    return;
  }
  if (typeof rescale.in_min !== "number" || typeof rescale.in_max !== "number") {
    err(path, "rescale.in_min and rescale.in_max must be numbers");
  } else if (rescale.in_max === rescale.in_min) {
    err(path, "rescale.in_max must differ from in_min");
  }
}

function validateLabels(labels: any, path: string, err: Err): void {
  if (!Array.isArray(labels)) {
    err(path, "labels must be an array of { min, max, label }");
    return;
  }
  labels.forEach((b: any, i: number) => {
    if (typeof b?.min !== "number" || typeof b?.max !== "number") {
      err(`${path}[${i}]`, "label band needs numeric min and max");
    }
    if (typeof b?.label !== "string" || !b.label.trim()) {
      err(`${path}[${i}].label`, "label band needs a non-empty label");
    }
  });
}

/** Bands must be contiguous and cover 0-100 exactly (sorted by min). */
function validateBandsCover0to100(bands: any[], path: string, err: Err): void {
  const sorted = [...bands].sort((a, b) => (a?.min ?? 0) - (b?.min ?? 0));
  for (const b of sorted) {
    if (typeof b?.min !== "number" || typeof b?.max !== "number") {
      err(path, "each band needs numeric min and max");
      return;
    }
    // final_score is always an integer (Math.round). Fractional band boundaries
    // (e.g. 49.5 / 50.5) can pass the gap===1 contiguity check yet leave an
    // integer score uncovered → a silently-null recommendation. Require integers.
    if (!Number.isInteger(b.min) || !Number.isInteger(b.max)) {
      err(path, `band boundaries must be integers (got min ${b.min}, max ${b.max}); scores are integers`);
      return;
    }
    if (typeof b?.label !== "string" || !b.label.trim()) {
      err(path, "each band needs a non-empty label");
      return;
    }
  }
  if (sorted[0].min !== 0) err(path, `bands must start at 0 (first band min is ${sorted[0].min})`);
  const last = sorted[sorted.length - 1];
  if (last.max !== 100) err(path, `bands must end at 100 (last band max is ${last.max})`);
  // Contiguity: inclusive integer bands, so next.min must be prev.max + 1.
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].min - sorted[i - 1].max;
    if (gap !== 1) {
      err(
        path,
        `bands must be contiguous over 0-100: band starting at ${sorted[i].min} ${gap > 1 ? "leaves a gap after" : "overlaps"} ${sorted[i - 1].max}`
      );
    }
  }
}
