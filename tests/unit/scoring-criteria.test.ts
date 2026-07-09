import { describe, it, expect } from "vitest";
import { evaluateCriterion, isBlank } from "../../src/scoring/criteria";
import type {
  NumericTiersCriterion,
  CategoricalCriterion,
  PassthroughCriterion,
} from "../../src/scoring/types";

describe("isBlank", () => {
  it("treats null/undefined/blank string as missing, 0 as present", () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank("  ")).toBe(true);
    expect(isBlank(0)).toBe(false);
    expect(isBlank("declining")).toBe(false);
  });
});

describe("numeric_tiers", () => {
  const c: NumericTiersCriterion = {
    key: "total_enrollment",
    type: "numeric_tiers",
    weight: 0.4,
    tiers: [
      { min: 0, max: 1000, score: 20 },
      { min: 1000, max: 5000, score: 60 },
      { min: 5000, max: 18000, score: 90 },
      { min: 18000, max: null, score: 100 },
    ],
  };

  it("selects the [min,max) band the value falls in", () => {
    expect(evaluateCriterion(500, c)).toEqual({ subscore: 20, missing: false });
    expect(evaluateCriterion(8200, c)).toEqual({ subscore: 90, missing: false });
  });

  it("is inclusive of min and exclusive of max at boundaries", () => {
    expect(evaluateCriterion(1000, c).subscore).toBe(60); // 1000 → second band
    expect(evaluateCriterion(5000, c).subscore).toBe(90); // 5000 → third band
    expect(evaluateCriterion(18000, c).subscore).toBe(100); // open-ended top
  });

  it("parses numeric strings with separators", () => {
    expect(evaluateCriterion("8,200", c).subscore).toBe(90);
  });

  it("flags missing for blank/unparseable values", () => {
    expect(evaluateCriterion(null, c)).toEqual({ subscore: 0, missing: true });
    expect(evaluateCriterion("n/a", c)).toEqual({ subscore: 0, missing: true });
  });
});

describe("categorical", () => {
  const c: CategoricalCriterion = {
    key: "enrollment_trend",
    type: "categorical",
    weight: 0.15,
    map: { growing: 100, stable: 60, declining: 20 },
    default: 0,
  };

  it("matches case-insensitively", () => {
    expect(evaluateCriterion("Growing", c).subscore).toBe(100);
    expect(evaluateCriterion("declining", c).subscore).toBe(20);
  });

  it("uses default for a present-but-unmatched value (not missing)", () => {
    expect(evaluateCriterion("volatile", c)).toEqual({ subscore: 0, missing: false });
  });

  it("flags missing only for blank", () => {
    expect(evaluateCriterion("", c)).toEqual({ subscore: 0, missing: true });
  });

  it("supports substring matching when contains:true", () => {
    const cc: CategoricalCriterion = { ...c, contains: true };
    expect(evaluateCriterion("rapidly growing district", cc).subscore).toBe(100);
  });
});

describe("passthrough", () => {
  const c: PassthroughCriterion = { key: "propensity_to_spend", type: "passthrough", weight: 0.3 };

  it("uses the value directly, clamped to 0-100", () => {
    expect(evaluateCriterion(72, c)).toEqual({ subscore: 72, missing: false });
    expect(evaluateCriterion(140, c).subscore).toBe(100);
    expect(evaluateCriterion(-5, c).subscore).toBe(0);
  });

  it("rescales when configured", () => {
    const cc: PassthroughCriterion = { ...c, rescale: { in_min: 0, in_max: 5 } };
    expect(evaluateCriterion(4, cc).subscore).toBe(80);
  });

  it("flags missing for blank", () => {
    expect(evaluateCriterion(null, c)).toEqual({ subscore: 0, missing: true });
  });
});
