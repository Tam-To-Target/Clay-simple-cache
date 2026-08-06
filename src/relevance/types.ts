/**
 * Config-driven RELEVANCE scoring — the shape of a client's stored signal rubric.
 *
 * Sibling of `src/scoring/types.ts` (fit scoring), with one fundamental
 * difference:
 *
 *   Fit score      = deterministic engine; AI writes prose only.
 *   Relevance score = AI *classifies*; there is no deterministic rubric.
 *
 * That difference is deliberate and bounded. The model returns ONE thing we
 * cannot compute ourselves — the tier. Everything downstream of the tier is
 * still ours: the point value is looked up from `tiers` in code, never taken
 * from the model. So the model has judgment, not arithmetic.
 *
 * Prompts are DATA (per-client, per-signal-type). If a signal type needs
 * different *handling* rather than different wording, add it in code.
 */
import type { AssociationConfig } from "./association";

/** Fixed tier → points mapping. Points are derived in code from the tier the
 *  model picks; the model's own numeric output is ignored. */
export interface TierDefinition {
  tier: number;
  points: number;
  /** Value written to the HubSpot enumeration property (e.g. "Tier 1"). */
  label: string;
  /** One-line meaning, injected into the prompt so wording stays in config. */
  meaning: string;
}

/** The default ladder: Tier 1 = act now, Tier 2 = strong intent, Tier 3 = context. */
export const DEFAULT_TIERS: TierDefinition[] = [
  { tier: 1, points: 100, label: "Tier 1", meaning: "so relevant that an SDR should contact this buyer immediately" },
  { tier: 2, points: 50, label: "Tier 2", meaning: "a good signal with strong intent, but no immediate action required" },
  { tier: 3, points: 20, label: "Tier 3", meaning: "somewhat relevant; useful context only" },
];

/**
 * Per-signal-type rubric. One entry per Starbridge `filterType`
 * (Meeting, RFP, Purchase, JobChange, Signal, Buyer, …).
 */
export interface RelevancePromptConfig {
  /** The tier rubric for this signal type. Anchors only — no output-format
   *  instructions (the service owns those) and no point arithmetic. */
  prompt: string;
  /** Optional per-type model override (e.g. a stronger model for RFP scope text). */
  model?: string;
  /** Whitelist of normalized column keys to send. When omitted, every column on
   *  the row is sent except `exclude_keys`. */
  include_keys?: string[];
  /** Blacklist of normalized column keys. Use for fields that are present but
   *  meaningless — e.g. on Purchase, `op_template:meeting_sum_relevance` returns
   *  the literal string "N/A" and would read as evidence. */
  exclude_keys?: string[];
}

export interface RelevanceAiConfig {
  enabled: boolean;
  /** Only "openai" is supported today (mirrors reasoning.service). */
  provider?: string;
  /** Fallback model for types with no override. Defaults to OPENAI_DEFAULT_MODEL. */
  model?: string;
  /**
   * Who the client is and what makes a signal relevant to them. Injected into
   * every prompt. This is the single highest-leverage field in the document —
   * every tier decision keys off it.
   */
  business_context: string;
  /** Keyed by Starbridge `filterType`, e.g. `{ "Meeting": { prompt: "…" } }`. */
  prompts: Record<string, RelevancePromptConfig>;
  /** Used when a signal's filterType has no entry in `prompts`. When absent, an
   *  unknown filterType is a 422 rather than a silently mis-scored signal. */
  default_prompt?: RelevancePromptConfig;
}

/**
 * Where the signal is written. The push UPSERTS the Signal record: the verdict
 * (tier/points/reasoning) plus the "spine" properties — identity, name, dates,
 * buyer, contact. It does NOT write the wider Starbridge payload; that stays
 * with the bulk sync.
 */
export interface RelevanceHubspotPushConfig {
  enabled: boolean;
  /** HubSpot objectTypeId of the Signal object. Default "0-162". */
  object_type?: string;
  /** Unique property holding the Starbridge rowId, used to locate the record.
   *  Default "sb_signal_id". */
  signal_id_field?: string;
  /** Enumeration property receiving the tier label. */
  tier_field?: string;
  /** Number property receiving the points. */
  points_field?: string;
  /** Textarea property receiving the AI reasoning. */
  reasoning_field?: string;
  /**
   * Create the Signal record when no match exists. Default TRUE — the endpoint
   * is a self-sufficient upsert. Set false to score only already-synced signals.
   */
  create_missing?: boolean;
  /** Pipeline stage id, written on CREATE. Required on objects that declare
   *  hs_pipeline_stage mandatory (the Signal object does). */
  pipeline_stage?: string;
  /** Pipeline id, written on CREATE alongside the stage. */
  pipeline?: string;
  /**
   * Canonical field → HubSpot property overrides, merged over DEFAULT_FIELD_MAP
   * (see relevance/hubspot-fields.ts). Map a field to "" to stop writing it.
   */
  field_map?: Record<string, string>;
  /**
   * Canonical fields written on CREATE but never overwritten on update.
   * Defaults to ["signal_status"] — Starbridge always reports "New", so
   * re-pushing it would reset a status a rep changed in HubSpot.
   */
  create_only_fields?: string[];
  /**
   * Company association. A signal with no company on it cannot roll up to an
   * account or reach the rep who owns it, so this is ON by default and runs on
   * both create and update. See relevance/association.ts for the match ladder
   * and why company CREATION is off by default.
   */
  association?: Partial<AssociationConfig>;
  /**
   * WRITE-ONLY. HubSpot private-app token used **only** by this endpoint's push
   * for this client. Required because record access to the Signal object is not
   * available to a public OAuth app at any scope; every other integration keeps
   * using the provisioner's OAuth grant.
   *
   * Supplied on PUT, stored in its own column, stripped from the stored document,
   * and never returned by GET (which reports `private_app_token_set` instead).
   * Omit it on a later PUT to keep the existing token; pass "" to clear it.
   */
  private_app_token?: string;
}

export interface RelevanceConfigDoc {
  client_id: string;
  config_version?: number;
  ai: RelevanceAiConfig;
  /** Override the tier ladder. Defaults to DEFAULT_TIERS (100/50/20). */
  tiers?: TierDefinition[];
  hubspot_push?: RelevanceHubspotPushConfig;
}

/**
 * The ONLY thing we accept from the model. `points` is intentionally absent —
 * it is derived from `tier` in code so the model can never alter the scale.
 */
export interface RelevanceVerdict {
  tier: number;
  reasoning: string;
}

/** A scored signal, as returned and cached. */
export interface RelevanceScoreResult {
  tier: number;
  points: number;
  tier_label: string;
  reasoning: string | null;
}
