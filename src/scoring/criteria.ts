/**
 * Criterion-type implementations — the extensibility boundary.
 *
 * Each type is a pure evaluator: (rawValue, criterion) -> { subscore, missing }.
 * Types are CODE (tested, versioned); their parameters are per-client DATA. To
 * support a client whose logic doesn't fit, add a new type here + register it —
 * do NOT grow a nested-conditional rules language in config.
 *
 * A value is "missing" when it is absent/null/undefined/blank, or (for numeric)
 * unparseable, or (for categorical, no default reachable). Missing => subscore
 * `missing_score` (default 0) + missing:true, which the reasoning layer uses to
 * say "data was missing, don't penalize fit" rather than treating a low score as
 * a genuine poor fit.
 *
 * Every subscore leaving this module is clamped to [0, 100], whatever the config
 * says — the validator rejects out-of-range scores too, but a stored config must
 * never be able to push a final score past 100.
 */
import type {
  Criterion,
  CriterionResult,
  CriterionType,
  NumericTiersCriterion,
  CategoricalCriterion,
  PassthroughCriterion,
} from "./types";

/** Clamp to [0, 100]; non-finite → 0. */
export function clampSubscore(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function missing(c: Criterion): CriterionResult {
  return { subscore: clampSubscore(c.missing_score ?? 0), missing: true };
}

/** True when a raw value carries no usable signal. */
export function isBlank(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/** Coerce to a finite number, or null. Accepts "8,200" / "8200" / 8200. */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (!v.trim()) return null;
    const n = Number(v.replace(/[, _$]/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** value in [min, max) → tier.score. Open-ended top tier has max === null. */
function evalNumericTiers(
  value: unknown,
  c: NumericTiersCriterion,
  values: Record<string, unknown>
): CriterionResult {
  if (isBlank(value)) return missing(c);
  const n = toNumber(value);
  if (n === null) return missing(c);
  if (c.override && n > 0) {
    const share = toNumber(values[c.override.share_key]);
    if (share !== null && share / n > c.override.above) {
      return { subscore: c.override.score, missing: false };
    }
  }
  for (const t of c.tiers) {
    const lo = n >= t.min;
    const hi = t.max === null ? true : n < t.max;
    if (lo && hi) return { subscore: t.score, missing: false };
  }
  // Below the first tier's min (or otherwise uncovered): no score, but the value
  // WAS provided, so this is not "missing" — it's a genuine out-of-domain 0.
  return { subscore: 0, missing: false };
}

/** value matched against {key: score}, optional substring match, then default. */
function evalCategorical(value: unknown, c: CategoricalCriterion): CriterionResult {
  if (isBlank(value)) return missing(c);
  const v = String(value).trim().toLowerCase();

  // Exact match (case-insensitive) first.
  for (const [key, score] of Object.entries(c.map)) {
    if (key.toLowerCase() === v) return { subscore: score, missing: false };
  }
  // Optional substring match: does the value contain a mapped key (or vice-versa)?
  if (c.contains) {
    for (const [key, score] of Object.entries(c.map)) {
      const k = key.toLowerCase();
      if (v.includes(k) || k.includes(v)) return { subscore: score, missing: false };
    }
  }
  // Value present but unmatched → default (a provided value, so not "missing").
  return { subscore: c.default, missing: false };
}

/** value is already 0-100; optional linear rescale, then clamp to [0, 100]. */
function evalPassthrough(value: unknown, c: PassthroughCriterion): CriterionResult {
  if (isBlank(value)) return missing(c);
  const n = toNumber(value);
  if (n === null) return missing(c);
  let out = n;
  if (c.rescale) {
    const { in_min, in_max } = c.rescale;
    out = in_max === in_min ? 0 : ((n - in_min) / (in_max - in_min)) * 100;
  }
  return { subscore: out, missing: false };
}

type Evaluator = (
  value: unknown,
  criterion: Criterion,
  values: Record<string, unknown>
) => CriterionResult;

/** The type registry. Adding a criterion type = one entry + one evaluator. */
const EVALUATORS: Record<CriterionType, Evaluator> = {
  numeric_tiers: (v, c, all) => evalNumericTiers(v, c as NumericTiersCriterion, all),
  categorical: (v, c) => evalCategorical(v, c as CategoricalCriterion),
  passthrough: (v, c) => evalPassthrough(v, c as PassthroughCriterion),
};

export const CRITERION_TYPES = Object.keys(EVALUATORS) as CriterionType[];

export function isKnownCriterionType(t: string): t is CriterionType {
  return t in EVALUATORS;
}

/** Evaluate a single criterion against its raw value. `values` is the whole
 *  input, for criteria that read a second key (numeric_tiers `override`). */
export function evaluateCriterion(
  value: unknown,
  criterion: Criterion,
  values: Record<string, unknown> = {}
): CriterionResult {
  const evaluator = EVALUATORS[criterion.type];
  if (!evaluator) {
    throw new Error(`Unknown criterion type: ${(criterion as { type: string }).type}`);
  }
  const r = evaluator(value, criterion, values);
  return { subscore: clampSubscore(r.subscore), missing: r.missing };
}
