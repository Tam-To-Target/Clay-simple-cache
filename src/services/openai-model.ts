/**
 * Shared OpenAI call conventions: the base URL, the default model, and the
 * per-model-family parameter quirks.
 *
 * Both AI callers — relevance classification (the model picks a tier) and
 * fit-score reasoning (the model writes prose) — hit the same
 * /chat/completions endpoint and resolve the same default model, so the
 * parameter rules have to agree between them. They used to be duplicated in
 * each service, which is exactly how a hardcoded `temperature: 0` would have
 * gone out to a model family that rejects it.
 *
 * The quirk that matters: the gpt-5.6 family (luna/terra/sol) and the o-series
 * reject any `temperature` other than 1, and instead expose `reasoning_effort`.
 * Older models (gpt-5.4-mini and earlier) are the opposite — they take
 * `temperature` and 400 on `reasoning_effort`. The two are mutually exclusive,
 * decided by the model string.
 */

export const OPENAI_BASE = () =>
  (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");

/**
 * Fallback model when a client config omits an explicit model. Overridable via
 * env so a model rename/deprecation is a config change, not a code deploy.
 *
 * gpt-5.6-luna is the cost pick for both callers: 3.75x cheaper than
 * gpt-5.4-mini on input, output AND cached input ($0.20/$1.20/$0.02 per M vs
 * $0.75/$4.50/$0.075), and positioned for exactly this workload — high-volume
 * classification with structured output.
 */
export const defaultModel = () => process.env.OPENAI_DEFAULT_MODEL || "gpt-5.6-luna";

/**
 * Model families that reject `temperature` and accept `reasoning_effort`.
 * Matched on prefix so point releases inherit the rule.
 *
 * Deliberately a narrow allowlist rather than a broad /^gpt-5/ match: gpt-5.4
 * and gpt-5.4-mini DO accept temperature, and guessing wrong in that direction
 * breaks a model that works today. Anything unlisted keeps legacy behavior.
 */
const REASONING_FAMILIES = [/^gpt-5\.[6-9](\b|[-.])/, /^gpt-[6-9](\b|[-.])/, /^o[1-9](\b|[-.])/];

/** True when `model` is in a family that fixes temperature at 1. */
export function isReasoningFamily(model: string): boolean {
  const m = model.trim().toLowerCase();
  return REASONING_FAMILIES.some((re) => re.test(m));
}

export type ReasoningEffort = "none" | "low" | "medium" | "high";

/**
 * Parameters to spread into a /chat/completions body, filtered to what `model`
 * actually accepts. Callers state intent for both families and this drops
 * whichever half would 400.
 *
 * `temperature: 0` expresses "stable run to run". A reasoning-family model
 * cannot be asked for that directly, so `effort` carries the intent instead:
 * "none" keeps latency and output-token spend down and is what OpenAI's own
 * error text points you at. It is NOT the same guarantee as temperature 0 —
 * verdicts can still drift between runs, which is why a model change wants an
 * agreement back-test, not just a green build.
 */
export function chatTuning(
  model: string,
  opts: { temperature?: number; effort?: ReasoningEffort } = {}
): Record<string, unknown> {
  if (isReasoningFamily(model)) {
    return opts.effort === undefined ? {} : { reasoning_effort: opts.effort };
  }
  return opts.temperature === undefined ? {} : { temperature: opts.temperature };
}
