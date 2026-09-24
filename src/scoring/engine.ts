/**
 * The generic scoring engine — the single deterministic path all clients share.
 *
 * THE RULE: scoring is 100% deterministic here. Every subscore and the weighted
 * final score are computed in code. The AI (reasoning.service) never does
 * arithmetic and never decides a score or a recommendation — it only writes the
 * narrative from the numbers this engine hands it.
 */
import crypto from "crypto";
import { evaluateCriterion, clampSubscore } from "./criteria";
import type {
  Criterion,
  PerCriterion,
  RecommendationBand,
  ScoringConfigDoc,
} from "./types";

/** The ceiling every fit score lives under. Enforced here AND at every exit
 *  (response, cache read, HubSpot push) — see capScore. */
export const MAX_SCORE = 100;

/** Clamp a final score to an integer in [0, MAX_SCORE]. Non-finite → 0. Applied
 *  to every score we return or write, including ones read back from the cache,
 *  so no config, cached row or future bug can ever emit a score above 100. */
export function capScore(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.min(MAX_SCORE, Math.round(v))) : 0;
}

export type RubricResolution =
  | { ok: true; criteria: Criterion[]; rubric: string | null }
  | { ok: false; error: string; available?: string[] };

/**
 * Pick the criteria list a call scores against. Single-rubric configs ignore
 * `rubric` (null). Multi-rubric configs REQUIRE a known rubric name — a silent
 * fallback would score a university on the city rubric.
 */
export function resolveRubric(config: ScoringConfigDoc, rubric: unknown): RubricResolution {
  if (config.rubrics && Object.keys(config.rubrics).length) {
    const available = Object.keys(config.rubrics);
    if (typeof rubric !== "string" || !rubric.trim()) {
      return { ok: false, error: "This client has multiple rubrics — pass `rubric`.", available };
    }
    const r = config.rubrics[rubric.trim()];
    if (!r) return { ok: false, error: `Unknown rubric "${rubric}".`, available };
    return { ok: true, criteria: r.criteria, rubric: rubric.trim() };
  }
  return { ok: true, criteria: config.criteria || [], rubric: null };
}

/** A criterion is required unless it explicitly opts out with required:false. */
export function isRequired(c: Criterion): boolean {
  return c.required !== false;
}

/**
 * Keys the caller failed to send AT ALL for required criteria. This is a caller
 * integration bug (→ 422), distinct from a key that is present but null/blank
 * (→ scored with missing:true, "don't penalize fit"). See the build spec.
 */
export function findMissingRequiredKeys(
  configOrCriteria: ScoringConfigDoc | Criterion[],
  values: Record<string, unknown>
): string[] {
  const criteria = Array.isArray(configOrCriteria)
    ? configOrCriteria
    : configOrCriteria.criteria || [];
  return criteria
    .filter((c) => isRequired(c) && !(c.key in values))
    .map((c) => c.key);
}

/** Resolve a criterion's optional word-label from its subscore, else null. */
function resolveLabel(c: Criterion, subscore: number): string | null {
  if (!c.labels || !c.labels.length) return null;
  const band = c.labels.find((b) => subscore >= b.min && subscore <= b.max);
  return band ? band.label : null;
}

/** Resolve the recommendation label for a final score from the config bands. */
export function resolveRecommendation(
  bands: RecommendationBand[] | undefined,
  finalScore: number
): string | null {
  if (!bands || !bands.length) return null;
  const band = bands.find((b) => finalScore >= b.min && finalScore <= b.max);
  return band ? band.label : null;
}

export interface EngineResult {
  final_score: number;
  per_criterion: PerCriterion[];
  recommendation: string | null;
}

/**
 * Compute the deterministic score. Callers should first reject on
 * findMissingRequiredKeys() (→ 422); here, an absent OR blank value simply
 * scores 0 with missing:true so optional criteria and present-but-null values
 * are handled uniformly.
 *
 * final_score = round( Σ subscore_i * weight_i ), clamped to [0, 100].
 */
export function computeScore(
  config: ScoringConfigDoc,
  values: Record<string, unknown>,
  criteria: Criterion[] = config.criteria || []
): EngineResult {
  const per_criterion: PerCriterion[] = [];
  let weighted = 0;

  for (const c of criteria) {
    const value = c.key in values ? values[c.key] : undefined;
    const { subscore, missing } = evaluateCriterion(value, c, values);
    const weight = Number.isFinite(c.weight) && c.weight > 0 ? c.weight : 0;
    weighted += clampSubscore(subscore) * weight;
    per_criterion.push({
      key: c.key,
      value: value ?? null,
      subscore,
      weight,
      missing,
      label: resolveLabel(c, subscore),
    });
  }

  const final_score = capScore(weighted);
  const recommendation = resolveRecommendation(
    config.reasoning?.recommendation_bands,
    final_score
  );

  return { final_score, per_criterion, recommendation };
}

/** One criterion's contribution in points (subscore × weight). */
function points(c: PerCriterion): number {
  return Math.round(c.subscore * c.weight * 100) / 100;
}

/**
 * A deterministic one-line summary, built from the engine's numbers only. Used
 * as the narrative when AI reasoning is off or failed, so a push never blanks
 * the reasoning field and every number in the text is the engine's own.
 *   "High Fit (score 70): strongest population (20 pts), weakest procurement
 *    (2 pts); 2 of 8 inputs missing."
 */
export function buildSummary(
  finalScore: number,
  recommendation: string | null,
  perCriterion: PerCriterion[]
): string {
  const head = `${recommendation ?? "Fit"} (score ${capScore(finalScore)})`;
  const scored = perCriterion.filter((c) => c.weight > 0);
  if (!scored.length) return head + ".";
  // Ranked by points contributed (what a reader adds up), ties by share of max.
  const ranked = [...scored].sort((a, b) => points(a) - points(b) || a.subscore - b.subscore);
  const weakest = ranked[0];
  const strongest = ranked[ranked.length - 1];
  const missing = scored.filter((c) => c.missing).length;
  const pts = (c: PerCriterion) => `${points(c)} ${points(c) === 1 ? "pt" : "pts"}`;
  let out = `${head}: strongest ${strongest.key} (${pts(strongest)}), weakest ${weakest.key} (${pts(weakest)})`;
  if (missing) out += `; ${missing} of ${scored.length} inputs missing`;
  return out + ".";
}

/**
 * Recursively sort object keys so semantically identical inputs serialize
 * identically. Arrays keep their order (order is meaningful); objects are
 * key-sorted at every depth, so nested value objects hash consistently.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = canonicalize((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Canonical hash of the input values, used as the cache key together with
 * (client_id, config_version). Key order is normalized at every depth so
 * equivalent inputs — including reordered nested objects — collapse to one
 * cache entry and never re-bill the reasoning model.
 */
export function hashValues(values: Record<string, unknown>, rubric: string | null = null): string {
  // The rubric is part of the key — identical inputs scored on two rubrics are
  // two results. Single-rubric calls hash exactly as before (cache stays warm).
  const input = rubric ? { __rubric: rubric, values } : values;
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
}
