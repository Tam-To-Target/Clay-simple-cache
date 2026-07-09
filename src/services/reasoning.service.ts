/**
 * Reasoning generation — the ONLY place the AI touches fit scoring, and it
 * touches text ONLY.
 *
 * The engine has already computed every subscore, the final score, and the
 * recommendation. We hand those to a cheap model as a structured context block
 * and ask it to write prose. The client's stored prompt contains NO calculation
 * instructions (business context + number→word rules + missing-data handling +
 * the recommendation, verbatim). We never trust the model for the score or the
 * recommendation — those are ours.
 *
 * The OpenAI key lives server-side (OPENAI_API_KEY); it is never accepted from
 * callers. A reasoning failure is non-fatal: the score is still returned, with
 * reasoning:null, and the caller can retry.
 */
import type { PerCriterion, ReasoningConfig } from "../scoring/types";

const OPENAI_BASE = () => (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
// Fallback model when a client config omits `reasoning.model`. Overridable via
// env so a model rename/deprecation is a config change, not a code deploy.
const defaultModel = () => process.env.OPENAI_DEFAULT_MODEL || "gpt-5.4-mini";

export interface ReasoningInput {
  reasoning: ReasoningConfig;
  finalScore: number;
  recommendation: string | null;
  perCriterion: PerCriterion[];
}

export interface ReasoningOutput {
  /** The narrative, or null if generation was skipped or failed. */
  reasoning: string | null;
  /** Present when generation failed (non-fatal); helps the caller/log. */
  error?: string;
}

/**
 * The structured context we inject into the client's prompt. Deliberately JSON,
 * not string-spliced into the prompt, so the prompt text stays the operator's
 * and the numbers stay the engine's. The model is told (by us, below) to write
 * words only and to end with the recommendation verbatim.
 */
export function buildContextBlock(input: ReasoningInput): string {
  const metrics = input.perCriterion.map((c) => ({
    metric: c.key,
    value: c.value,
    // subscore/weight are context for HOW STRONG each signal is; the prompt maps
    // these to words. They are NOT to be echoed as numbers.
    strength_0_100: c.subscore,
    weight: c.weight,
    label: c.label ?? undefined,
    missing: c.missing,
  }));
  return JSON.stringify(
    {
      note:
        "All scores are ALREADY computed. Do NOT do math, do NOT output numbers. " +
        "Translate each metric to words per your instructions. End with the recommendation verbatim.",
      metrics,
      recommendation: input.recommendation,
    },
    null,
    2
  );
}

/** Compose the messages for the chat completion. */
function buildMessages(input: ReasoningInput): Array<{ role: string; content: string }> {
  return [
    { role: "system", content: input.reasoning.prompt || "" },
    {
      role: "user",
      content:
        "Here is the computed scoring context for one target. Write the briefing.\n\n" +
        buildContextBlock(input),
    },
  ];
}

/**
 * Generate the reasoning string. Returns { reasoning: null } (never throws) when
 * disabled, unconfigured, or on any upstream failure — scoring must not fail
 * because the narrative couldn't be written.
 */
export async function generateReasoning(input: ReasoningInput): Promise<ReasoningOutput> {
  if (!input.reasoning?.enabled) return { reasoning: null };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { reasoning: null, error: "OPENAI_API_KEY is not configured on the server" };
  }

  const provider = (input.reasoning.provider || "openai").toLowerCase();
  if (provider !== "openai") {
    return { reasoning: null, error: `Unsupported reasoning provider: ${provider}` };
  }

  const model = input.reasoning.model || defaultModel();

  try {
    const res = await fetch(`${OPENAI_BASE()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(input),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { reasoning: null, error: `OpenAI ${res.status}: ${body.slice(0, 300)}` };
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return { reasoning: null, error: "OpenAI returned no content" };
    return { reasoning: text };
  } catch (e) {
    return { reasoning: null, error: e instanceof Error ? e.message : String(e) };
  }
}
