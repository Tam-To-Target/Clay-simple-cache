/**
 * Relevance classification — the ONE place the AI makes a decision we cannot
 * compute ourselves.
 *
 * Contrast with reasoning.service (fit scoring), where the model only writes
 * prose. Here the model chooses the TIER. That is the whole point: signal
 * relevance has no deterministic rubric. But the blast radius is bounded:
 *
 *   - The model returns ONLY { tier, reasoning }. It never returns points.
 *   - Points are looked up from the client's tier ladder in the controller.
 *   - A tier outside the configured ladder is rejected, not clamped — a model
 *     inventing "Tier 4" is a prompt bug we want surfaced, not silently coerced.
 *
 * Output shape is enforced with a strict JSON schema at the API layer, so the
 * client's prompt never has to describe the format (and the validator rejects
 * prompts that try to).
 *
 * The OpenAI key lives server-side (OPENAI_API_KEY); never accepted from callers.
 * Unlike fit-score reasoning, a failure here IS fatal to the call — there is no
 * score without the model, so we return an error rather than a null verdict.
 */
import type { RelevanceVerdict, TierDefinition } from "../relevance/types";

const OPENAI_BASE = () => (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const defaultModel = () => process.env.OPENAI_DEFAULT_MODEL || "gpt-5.4-mini";

export interface ClassifyInput {
  businessContext: string;
  /** The signal-type rubric (tier anchors) from the client's config. */
  rubric: string;
  /** Evidence block built by buildEvidence(). */
  evidence: Record<string, unknown>;
  tiers: TierDefinition[];
  model?: string;
  provider?: string;
}

export type ClassifyOutput =
  | { ok: true; verdict: RelevanceVerdict; model: string }
  | { ok: false; error: string };

/** Build the tier ladder description injected into the system prompt. */
function tierLadder(tiers: TierDefinition[]): string {
  return tiers.map((t) => `Tier ${t.tier} — ${t.meaning}`).join("\n");
}

/**
 * The system prompt. Structure is ours; the two substantive blocks
 * (business context, rubric) are the client's config. The universal guardrails
 * live here so every signal type inherits them and no prompt can forget them.
 */
export function buildSystemPrompt(input: ClassifyInput): string {
  const allowed = input.tiers.map((t) => t.tier).join(" | ");
  return [
    "You classify go-to-market signals by how urgently a sales rep should act on them.",
    "",
    "<business_context>",
    input.businessContext.trim(),
    "</business_context>",
    "",
    "Assign exactly one tier:",
    tierLadder(input.tiers),
    "",
    "<rubric>",
    input.rubric.trim(),
    "</rubric>",
    "",
    "Rules that always apply:",
    "- Judge ONLY on the evidence provided. Never assume facts that are not present.",
    '- An absent field, or one reading "N/A", is missing evidence — not negative evidence.',
    "- Default DOWN when uncertain. The top tier must be defensible to a skeptical rep.",
    "- `prior_ai_columns`, when present, is another model's opinion: corroborating context,",
    "  not primary evidence. Disagree with it when the evidence warrants.",
    "- Recency matters: a stale signal is rarely urgent even when its topic is a perfect fit.",
    "- reasoning: 2-3 sentences citing the SPECIFIC evidence that set the tier. No score talk,",
    "  no restating the rubric, no hedging boilerplate.",
    "",
    `tier must be one of: ${allowed}.`,
  ].join("\n");
}

/** Strict schema — the model physically cannot return a different shape. */
function responseFormat(tiers: TierDefinition[]) {
  return {
    type: "json_schema",
    json_schema: {
      name: "relevance_verdict",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["tier", "reasoning"],
        properties: {
          tier: { type: "integer", enum: tiers.map((t) => t.tier) },
          reasoning: { type: "string" },
        },
      },
    },
  };
}

export async function classifySignal(input: ClassifyInput): Promise<ClassifyOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "OPENAI_API_KEY is not configured on the server" };

  const provider = (input.provider || "openai").toLowerCase();
  if (provider !== "openai") return { ok: false, error: `Unsupported provider: ${provider}` };
  if (!input.tiers.length) return { ok: false, error: "no tiers configured" };

  const model = input.model || defaultModel();

  let res: Response;
  try {
    res = await fetch(`${OPENAI_BASE()}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        // Classification wants stability, not creativity: the same signal under
        // the same prompt should not drift between tiers run to run.
        temperature: 0,
        response_format: responseFormat(input.tiers),
        messages: [
          { role: "system", content: buildSystemPrompt(input) },
          {
            role: "user",
            content:
              "Classify this signal.\n\n" + JSON.stringify(input.evidence, null, 2),
          },
        ],
      }),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `OpenAI ${res.status}: ${body.slice(0, 300)}` };
  }

  let json: { choices?: Array<{ message?: { content?: string; refusal?: string } }> };
  try {
    json = (await res.json()) as typeof json;
  } catch (e) {
    return { ok: false, error: "OpenAI returned a non-JSON body" };
  }

  const msg = json.choices?.[0]?.message;
  if (msg?.refusal) return { ok: false, error: `Model refused: ${msg.refusal.slice(0, 200)}` };
  const text = msg?.content?.trim();
  if (!text) return { ok: false, error: "OpenAI returned no content" };

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: `Model returned unparseable JSON: ${text.slice(0, 200)}` };
  }

  // Re-validate even though the schema is strict — a base-URL override or a
  // model without json_schema support would otherwise let junk through.
  const tier = parsed?.tier;
  const reasoning = parsed?.reasoning;
  if (!Number.isInteger(tier) || !input.tiers.some((t) => t.tier === tier)) {
    return { ok: false, error: `Model returned an unknown tier: ${JSON.stringify(tier)}` };
  }
  if (typeof reasoning !== "string" || !reasoning.trim()) {
    return { ok: false, error: "Model returned an empty reasoning" };
  }

  return { ok: true, verdict: { tier, reasoning: reasoning.trim() }, model };
}
