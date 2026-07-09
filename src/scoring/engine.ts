/**
 * The generic scoring engine — the single deterministic path all clients share.
 *
 * THE RULE: scoring is 100% deterministic here. Every subscore and the weighted
 * final score are computed in code. The AI (reasoning.service) never does
 * arithmetic and never decides a score or a recommendation — it only writes the
 * narrative from the numbers this engine hands it.
 */
import crypto from "crypto";
import { evaluateCriterion } from "./criteria";
import type {
  Criterion,
  PerCriterion,
  RecommendationBand,
  ScoringConfigDoc,
} from "./types";

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
  config: ScoringConfigDoc,
  values: Record<string, unknown>
): string[] {
  return config.criteria
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
  values: Record<string, unknown>
): EngineResult {
  const per_criterion: PerCriterion[] = [];
  let weighted = 0;

  for (const c of config.criteria) {
    const value = c.key in values ? values[c.key] : undefined;
    const { subscore, missing } = evaluateCriterion(value, c);
    weighted += subscore * c.weight;
    per_criterion.push({
      key: c.key,
      value: value ?? null,
      subscore,
      weight: c.weight,
      missing,
      label: resolveLabel(c, subscore),
    });
  }

  const final_score = Math.max(0, Math.min(100, Math.round(weighted)));
  const recommendation = resolveRecommendation(
    config.reasoning?.recommendation_bands,
    final_score
  );

  return { final_score, per_criterion, recommendation };
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
export function hashValues(values: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(values))).digest("hex");
}
