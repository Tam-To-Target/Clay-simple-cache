import { describe, it, expect } from "vitest";
import { buildContextBlock } from "../../src/services/reasoning.service";
import { validateConfig } from "../../src/scoring/validator";

const BASE = {
  reasoning: { enabled: true },
  finalScore: 80,
  recommendation: "High Fit",
  perCriterion: [],
};

describe("buildContextBlock account_type", () => {
  it("tells the model what kind of account it is", () => {
    const ctx = JSON.parse(buildContextBlock({ ...BASE, accountType: "state department of transportation" }));
    expect(ctx.account_type).toBe("state department of transportation");
  });
  it("omits account_type for single-rubric configs", () => {
    const ctx = JSON.parse(buildContextBlock({ ...BASE, accountType: null }));
    expect("account_type" in ctx).toBe(false);
  });
});

describe("validateConfig account_type", () => {
  it("rejects a blank account_type", () => {
    const crit = { key: "x", label: "X", weight: 1, type: "numeric_tiers", tiers: [{ min: 0, score: 100 }] };
    const r = validateConfig({ client_id: "a", rubrics: { dots: { criteria: [crit], account_type: " " } } } as any);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.errors.some((e: any) => String(e.path ?? e).includes("account_type"))).toBe(true);
  });
});
