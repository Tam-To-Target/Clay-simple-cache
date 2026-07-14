/**
 * Config-driven fit scoring — the shape of a client's stored rubric.
 *
 * Criterion `type`s map to CODE (see criteria.ts, tested + versioned). The JSON
 * below is DATA (per-client parameters). If a client needs logic that doesn't
 * fit an existing type, add a NEW type in code — never a rules DSL in config.
 *
 * Scoring is 100% deterministic in the engine. The `reasoning` block only drives
 * the narrative text; it can never move the score or the recommendation.
 */

/** A [min, max) band. `max: null` is allowed only on the last tier (open-ended). */
export interface Tier {
  min: number;
  max: number | null;
  score: number;
}

/** Optional per-criterion word-label bands over the resolved subscore (0-100).
 *  When present the engine resolves a word for the reasoning context block;
 *  when absent the model translates value+subscore per its prompt. */
export interface LabelBand {
  min: number;
  max: number;
  label: string;
}

interface CriterionBase {
  key: string;
  weight: number;
  /** Default true. When false, an absent value is treated as missing-value
   *  (subscore 0 + flag) rather than a hard 422. */
  required?: boolean;
  /** Optional subscore→word bands injected into the reasoning context. */
  labels?: LabelBand[];
}

export interface NumericTiersCriterion extends CriterionBase {
  type: "numeric_tiers";
  tiers: Tier[];
}

export interface CategoricalCriterion extends CriterionBase {
  type: "categorical";
  map: Record<string, number>;
  /** Substring matching against the map keys (case-insensitive) when true. */
  contains?: boolean;
  default: number;
}

export interface PassthroughCriterion extends CriterionBase {
  type: "passthrough";
  /** Optional linear rescale of an already-0-100 value: out = (v-in0)/(in1-in0)*100. */
  rescale?: { in_min: number; in_max: number };
}

export type Criterion =
  | NumericTiersCriterion
  | CategoricalCriterion
  | PassthroughCriterion;

export type CriterionType = Criterion["type"];

export interface RecommendationBand {
  min: number;
  max: number;
  label: string;
}

export interface ReasoningConfig {
  enabled: boolean;
  provider?: string; // "openai"
  model?: string; // e.g. "gpt-5.4-mini"
  prompt?: string;
  recommendation_bands?: RecommendationBand[];
}

/**
 * Maps the request's required account-identity properties to HubSpot property
 * names. Omitted keys fall back to HubSpot defaults (see DEFAULT_IDENTITY_MAP):
 * account_name → "name", account_domain → "domain", starbridge_id →
 * "starbridge_id". These are written to the record on push and are our primary
 * ID properties for locating it.
 */
export interface IdentityFieldMap {
  account_name?: string;
  account_domain?: string;
  starbridge_id?: string;
}

export interface HubspotPushConfig {
  enabled: boolean;
  score_field?: string;
  reasoning_field?: string;
  /** Per-client override of the identity → HubSpot property mapping. The score
   *  is always written to a Company (districts), located/deduped by domain. */
  identity_fields?: IdentityFieldMap;
}

export interface ScoringConfigDoc {
  client_id: string;
  config_version?: number;
  criteria: Criterion[];
  reasoning?: ReasoningConfig;
  hubspot_push?: HubspotPushConfig;
}

/** Result of evaluating ONE criterion against a raw value. */
export interface CriterionResult {
  /** 0-100 subscore contributed by this criterion (before weighting). */
  subscore: number;
  /** true when no usable value was present (value absent/null/unparseable). */
  missing: boolean;
}

/** Full per-criterion row returned by the engine and cached. */
export interface PerCriterion {
  key: string;
  value: unknown;
  subscore: number;
  weight: number;
  missing: boolean;
  /** Resolved word-label when the criterion defines `labels`; else null. */
  label?: string | null;
}
