import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildSystemPrompt, classifySignal } from "../../src/services/relevance-ai.service";
import { DEFAULT_TIERS } from "../../src/relevance/types";

const input = () => ({
  businessContext: "Hilight sells staff recognition and culture analytics to K-12 districts.",
  rubric: "Tier 1 when the board approved funded staff-culture work.",
  evidence: { signal_type: "Meeting", fields: { confidenceScore: 5 } },
  tiers: DEFAULT_TIERS,
});

describe("buildSystemPrompt", () => {
  it("embeds business context and rubric in delimited blocks", () => {
    const p = buildSystemPrompt(input());
    expect(p).toContain("<business_context>");
    expect(p).toContain("Hilight sells staff recognition");
    expect(p).toContain("<rubric>");
    expect(p).toContain("Tier 1 when the board approved");
  });

  it("states the tier ladder from config, not hardcoded text", () => {
    const p = buildSystemPrompt({
      ...input(),
      tiers: [
        { tier: 1, points: 90, label: "Hot", meaning: "call immediately" },
        { tier: 2, points: 10, label: "Cold", meaning: "ignore for now" },
      ],
    });
    expect(p).toContain("Tier 1 — call immediately");
    expect(p).toContain("Tier 2 — ignore for now");
    expect(p).toContain("tier must be one of: 1 | 2");
  });

  it("never mentions points — the model must not see the scale", () => {
    // Points are derived in code. If the model saw them it could rationalize a
    // tier from a desired score instead of from the evidence.
    const p = buildSystemPrompt(input());
    expect(p).not.toMatch(/\b100\b/);
    expect(p).not.toMatch(/\bpoints\b/i);
  });

  it("carries the universal guardrails every signal type inherits", () => {
    const p = buildSystemPrompt(input());
    expect(p).toMatch(/only on the evidence/i);
    expect(p).toMatch(/N\/A/); // missing != negative evidence
    expect(p).toMatch(/default down/i);
    expect(p).toMatch(/prior_ai_columns/);
  });
});

describe("classifySignal — guards", () => {
  const OLD = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "sk-test";
    vi.restoreAllMocks();
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = OLD;
  });

  it("fails closed when the server has no API key", async () => {
    delete process.env.OPENAI_API_KEY;
    const r = await classifySignal(input());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/OPENAI_API_KEY/);
  });

  it("rejects a non-openai provider", async () => {
    const r = await classifySignal({ ...input(), provider: "anthropic" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unsupported provider/);
  });

  it("requests a strict json_schema and temperature 0", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"tier":1,"reasoning":"Board funded it."}' } }] }),
    }));
    vi.stubGlobal("fetch", fetchMock as any);

    const r = await classifySignal(input());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.verdict).toEqual({ tier: 1, reasoning: "Board funded it." });

    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body.temperature).toBe(0);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.response_format.json_schema.schema.properties.tier.enum).toEqual([1, 2, 3]);
    // `points` must not be requestable — the schema forbids extra keys.
    expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
    expect(Object.keys(body.response_format.json_schema.schema.properties)).toEqual(["tier", "reasoning"]);
  });

  it("rejects a tier outside the ladder rather than clamping it", async () => {
    // A model inventing "Tier 4" is a prompt bug we want surfaced.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"tier":4,"reasoning":"x"}' } }] }),
      })) as any
    );
    const r = await classifySignal(input());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown tier/i);
  });

  it("rejects empty reasoning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"tier":2,"reasoning":"   "}' } }] }),
      })) as any
    );
    const r = await classifySignal(input());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty reasoning/i);
  });

  it("surfaces unparseable model output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "Tier 1, obviously" } }] }),
      })) as any
    );
    const r = await classifySignal(input());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unparseable JSON/);
  });

  it("surfaces a model refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { refusal: "I can't help with that." } }] }),
      })) as any
    );
    const r = await classifySignal(input());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/refused/i);
  });

  it("surfaces an upstream HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 429, text: async () => "rate limited" })) as any
    );
    const r = await classifySignal(input());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/OpenAI 429/);
  });
});
