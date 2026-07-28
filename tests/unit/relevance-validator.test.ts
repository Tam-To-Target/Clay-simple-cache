import { describe, it, expect } from "vitest";
import { validateRelevanceConfig, resolveTiers } from "../../src/relevance/validator";
import { DEFAULT_TIERS } from "../../src/relevance/types";
import type { RelevanceConfigDoc } from "../../src/relevance/types";

const base = (): RelevanceConfigDoc => ({
  client_id: "hilight",
  ai: {
    enabled: true,
    business_context:
      "Hilight sells all-staff recognition and culture analytics to US K-12 school districts.",
    prompts: {
      Meeting: { prompt: "Tier 1 when the board approved funded staff-culture work. Tier 3 otherwise." },
    },
  },
});

const paths = (r: ReturnType<typeof validateRelevanceConfig>) => r.errors.map((e) => e.path);

describe("validateRelevanceConfig — happy path", () => {
  it("accepts a minimal well-formed config", () => {
    const r = validateRelevanceConfig(base());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("accepts include_keys / exclude_keys and a per-type model", () => {
    const c = base();
    c.ai.prompts.Purchase = {
      prompt: "Tier 1 for meaningful competitor spend. Gate on price; trivial POs are Tier 3.",
      model: "gpt-5.4",
      exclude_keys: ["op_template:meeting_sum_relevance"],
    };
    expect(validateRelevanceConfig(c).valid).toBe(true);
  });
});

describe("validateRelevanceConfig — structure", () => {
  it("rejects a non-object", () => {
    expect(validateRelevanceConfig("nope").valid).toBe(false);
    expect(paths(validateRelevanceConfig(null))).toEqual(["$"]);
  });

  it("requires the ai block", () => {
    expect(paths(validateRelevanceConfig({ client_id: "x" }))).toContain("ai");
  });

  it("requires at least one signal-type prompt", () => {
    const c: any = base();
    c.ai.prompts = {};
    expect(paths(validateRelevanceConfig(c))).toContain("ai.prompts");
  });

  it("requires a substantial business_context", () => {
    const c = base();
    c.ai.business_context = "k12";
    expect(paths(validateRelevanceConfig(c))).toContain("ai.business_context");
  });

  it("rejects a non-openai provider", () => {
    const c = base();
    c.ai.provider = "anthropic";
    expect(paths(validateRelevanceConfig(c))).toContain("ai.provider");
  });

  it("requires a non-trivial prompt string", () => {
    const c: any = base();
    c.ai.prompts.Meeting = { prompt: "score it" };
    expect(paths(validateRelevanceConfig(c))).toContain("ai.prompts.Meeting.prompt");
  });

  it("validates default_prompt when present", () => {
    const c: any = base();
    c.ai.default_prompt = { prompt: "hi" };
    expect(paths(validateRelevanceConfig(c))).toContain("ai.default_prompt.prompt");
  });
});

describe("validateRelevanceConfig — prompts must not own output or math", () => {
  // The service supplies a strict JSON schema and derives points from the tier.
  // A prompt that restates either fights the service and breaks parsing.
  it("rejects a prompt that redefines the output format", () => {
    const c = base();
    c.ai.prompts.Meeting.prompt = "Judge the signal and return JSON with your answer.";
    expect(paths(validateRelevanceConfig(c))).toContain("ai.prompts.Meeting.prompt");
  });

  it("rejects a prompt that sets points", () => {
    const c = base();
    c.ai.prompts.Meeting.prompt = 'Emit "points": 100 for the best signals, else fewer.';
    expect(paths(validateRelevanceConfig(c))).toContain("ai.prompts.Meeting.prompt");
  });

  it("rejects a prompt that restates the points ladder", () => {
    const c = base();
    c.ai.prompts.Meeting.prompt = "Use the 100/50/20 ladder to score this board meeting signal.";
    expect(paths(validateRelevanceConfig(c))).toContain("ai.prompts.Meeting.prompt");
  });

  it("rejects a prompt asking for arithmetic", () => {
    const c = base();
    c.ai.prompts.Meeting.prompt = "Sum the score across every relevant field and report the total.";
    expect(paths(validateRelevanceConfig(c))).toContain("ai.prompts.Meeting.prompt");
  });

  it("rejects include_keys together with exclude_keys", () => {
    const c = base();
    c.ai.prompts.Meeting.include_keys = ["confidenceReasoning"];
    c.ai.prompts.Meeting.exclude_keys = ["op:posted_date"];
    expect(paths(validateRelevanceConfig(c))).toContain("ai.prompts.Meeting.exclude_keys");
  });
});

describe("validateRelevanceConfig — tiers", () => {
  it("defaults to the 100/50/20 ladder when omitted", () => {
    expect(resolveTiers(base())).toEqual(DEFAULT_TIERS);
    expect(DEFAULT_TIERS.map((t) => t.points)).toEqual([100, 50, 20]);
  });

  it("accepts a custom descending ladder", () => {
    const c = base();
    c.tiers = [
      { tier: 1, points: 90, label: "Hot", meaning: "call now" },
      { tier: 2, points: 40, label: "Warm", meaning: "queue it" },
    ];
    expect(validateRelevanceConfig(c).valid).toBe(true);
    expect(resolveTiers(c)).toHaveLength(2);
  });

  it("rejects an ascending ladder (would invert sorting in HubSpot)", () => {
    const c = base();
    c.tiers = [
      { tier: 1, points: 20, label: "Tier 1", meaning: "act now" },
      { tier: 2, points: 100, label: "Tier 2", meaning: "later" },
    ];
    expect(paths(validateRelevanceConfig(c))).toContain("tiers[1].points");
  });

  it("rejects duplicate tier numbers", () => {
    const c = base();
    c.tiers = [
      { tier: 1, points: 100, label: "A", meaning: "x" },
      { tier: 1, points: 50, label: "B", meaning: "y" },
    ];
    expect(paths(validateRelevanceConfig(c))).toContain("tiers[1].tier");
  });

  it("requires label and meaning on every tier", () => {
    const c: any = base();
    c.tiers = [{ tier: 1, points: 100 }];
    const p = paths(validateRelevanceConfig(c));
    expect(p).toContain("tiers[0].label");
    expect(p).toContain("tiers[0].meaning");
  });
});

describe("validateRelevanceConfig — hubspot_push", () => {
  it("requires all three verdict fields when enabled", () => {
    const c: any = base();
    c.hubspot_push = { enabled: true };
    const p = paths(validateRelevanceConfig(c));
    expect(p).toContain("hubspot_push.tier_field");
    expect(p).toContain("hubspot_push.points_field");
    expect(p).toContain("hubspot_push.reasoning_field");
  });

  it("accepts a fully configured push block", () => {
    const c = base();
    c.hubspot_push = {
      enabled: true,
      object_type: "0-162",
      signal_id_field: "sb_signal_id",
      tier_field: "sb_tier",
      points_field: "sb_score_points",
      reasoning_field: "sb_ai_reasoning",
      pipeline: "ba9cdbd6-e220-45b2-a5a2-d67ebdcbade6",
      pipeline_stage: "8e2b21d0-7a90-4968-8f8c-a8525cc49c70",
    };
    expect(validateRelevanceConfig(c).valid).toBe(true);
  });

  it("ignores field requirements when push is disabled", () => {
    const c: any = base();
    c.hubspot_push = { enabled: false };
    expect(validateRelevanceConfig(c).valid).toBe(true);
  });

  // create_missing defaults to TRUE, and the Signal object declares
  // hs_pipeline_stage mandatory — so fail at config time, not on every create.
  it("requires pipeline_stage when create_missing defaults on", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      tier_field: "sb_tier",
      points_field: "sb_score_points",
      reasoning_field: "sb_ai_reasoning",
    };
    expect(paths(validateRelevanceConfig(c))).toContain("hubspot_push.pipeline_stage");
  });

  it("does not require pipeline_stage when create_missing is off", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      create_missing: false,
      tier_field: "sb_tier",
      points_field: "sb_score_points",
      reasoning_field: "sb_ai_reasoning",
    };
    expect(validateRelevanceConfig(c).valid).toBe(true);
  });

  it("rejects an unknown field_map key", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      create_missing: false,
      tier_field: "a",
      points_field: "b",
      reasoning_field: "c",
      field_map: { buyer_id: "starbridge_buyer_id", not_a_field: "x" },
    };
    expect(paths(validateRelevanceConfig(c))).toContain("hubspot_push.field_map.not_a_field");
  });

  it("rejects an unknown create_only_fields entry", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      create_missing: false,
      tier_field: "a",
      points_field: "b",
      reasoning_field: "c",
      create_only_fields: ["signal_status", "nope"],
    };
    expect(paths(validateRelevanceConfig(c))).toContain("hubspot_push.create_only_fields");
  });

  // If the written signal-id property differs from the searched one, no push ever
  // finds its record and every call creates a duplicate.
  it("rejects a field_map.signal_id that diverges from signal_id_field", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      create_missing: false,
      signal_id_field: "sb_signal_id",
      tier_field: "a",
      points_field: "b",
      reasoning_field: "c",
      field_map: { signal_id: "some_other_prop" },
    };
    expect(paths(validateRelevanceConfig(c))).toContain("hubspot_push.field_map.signal_id");
  });

  it("rejects disabling the signal_id mapping", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      create_missing: false,
      tier_field: "a",
      points_field: "b",
      reasoning_field: "c",
      field_map: { signal_id: "" },
    };
    expect(paths(validateRelevanceConfig(c))).toContain("hubspot_push.field_map.signal_id");
  });

  it("accepts a matching signal_id override on both sides", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      create_missing: false,
      signal_id_field: "starbridge_row_id",
      tier_field: "a",
      points_field: "b",
      reasoning_field: "c",
      field_map: { signal_id: "starbridge_row_id" },
    };
    expect(validateRelevanceConfig(c).valid).toBe(true);
  });

  it("rejects disabling name while creates are enabled (hs_name is required)", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      tier_field: "a",
      points_field: "b",
      reasoning_field: "c",
      pipeline_stage: "stage-1",
      field_map: { name: "" },
    };
    expect(paths(validateRelevanceConfig(c))).toContain("hubspot_push.field_map.name");
  });

  it("accepts a valid field_map override and create_only_fields", () => {
    const c: any = base();
    c.hubspot_push = {
      enabled: true,
      create_missing: false,
      tier_field: "sb_tier",
      points_field: "sb_score_points",
      reasoning_field: "sb_ai_reasoning",
      field_map: { buyer_id: "starbridge_buyer_id", synced_at: "" },
      create_only_fields: ["signal_status", "added_date"],
    };
    expect(validateRelevanceConfig(c).valid).toBe(true);
  });
});
