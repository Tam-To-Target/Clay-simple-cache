import { describe, it, expect } from "vitest";
import {
  computeScore,
  findMissingRequiredKeys,
  resolveRecommendation,
  hashValues,
} from "../../src/scoring/engine";
import type { ScoringConfigDoc } from "../../src/scoring/types";

/**
 * Hilight's four-criterion rubric (from the build spec), with concrete income
 * tiers filled in. Used to check the engine's final score against hand-computed
 * arithmetic — the whole point is that this number is code's, never the model's.
 */
const HILIGHT: ScoringConfigDoc = {
  client_id: "hilight",
  config_version: 1,
  criteria: [
    {
      key: "total_enrollment",
      type: "numeric_tiers",
      weight: 0.4,
      tiers: [
        { min: 0, max: 1000, score: 20 },
        { min: 1000, max: 5000, score: 60 },
        { min: 5000, max: 18000, score: 90 },
        { min: 18000, max: null, score: 100 },
      ],
    },
    { key: "propensity_to_spend", type: "passthrough", weight: 0.3 },
    {
      key: "median_household_income",
      type: "numeric_tiers",
      weight: 0.15,
      tiers: [
        { min: 0, max: 50000, score: 40 },
        { min: 50000, max: 75000, score: 70 },
        { min: 75000, max: 100000, score: 90 },
        { min: 100000, max: null, score: 100 },
      ],
    },
    {
      key: "enrollment_trend",
      type: "categorical",
      weight: 0.15,
      map: { growing: 100, stable: 60, declining: 20 },
      default: 0,
    },
  ],
  reasoning: {
    enabled: false,
    recommendation_bands: [
      { min: 80, max: 100, label: "Prioritize now" },
      { min: 65, max: 79, label: "Worth a call" },
      { min: 50, max: 64, label: "Enrich first" },
      { min: 0, max: 49, label: "Deprioritize" },
    ],
  },
};

describe("computeScore — Hilight rubric (hand-computed)", () => {
  it("matches the hand-computed weighted final score", () => {
    // enrollment 8200 → 90 * 0.40 = 36.0
    // propensity  72  → 72 * 0.30 = 21.6
    // income   68000  → 70 * 0.15 = 10.5
    // trend "growing" → 100 * 0.15 = 15.0
    // Σ = 83.1 → round → 83
    const r = computeScore(HILIGHT, {
      total_enrollment: 8200,
      propensity_to_spend: 72,
      median_household_income: 68000,
      enrollment_trend: "growing",
    });
    expect(r.final_score).toBe(83);
    expect(r.recommendation).toBe("Prioritize now");

    const byKey = Object.fromEntries(r.per_criterion.map((c) => [c.key, c]));
    expect(byKey.total_enrollment.subscore).toBe(90);
    expect(byKey.propensity_to_spend.subscore).toBe(72);
    expect(byKey.median_household_income.subscore).toBe(70);
    expect(byKey.enrollment_trend.subscore).toBe(100);
    expect(r.per_criterion.every((c) => !c.missing)).toBe(true);
  });

  it("computes a small-district low-fit score", () => {
    // enrollment 400 → 20*0.4=8; propensity 30 → 9; income 40000 → 40*0.15=6;
    // trend declining → 20*0.15=3; Σ = 26 → "Deprioritize"
    const r = computeScore(HILIGHT, {
      total_enrollment: 400,
      propensity_to_spend: 30,
      median_household_income: 40000,
      enrollment_trend: "declining",
    });
    expect(r.final_score).toBe(26);
    expect(r.recommendation).toBe("Deprioritize");
  });

  it("flags a present-but-null value as missing with subscore 0 (no 422)", () => {
    const r = computeScore(HILIGHT, {
      total_enrollment: 18000, // 100*0.4 = 40
      propensity_to_spend: null, // missing → 0
      median_household_income: 120000, // 100*0.15 = 15
      enrollment_trend: "stable", // 60*0.15 = 9
    });
    // Σ = 40 + 0 + 15 + 9 = 64
    expect(r.final_score).toBe(64);
    const prop = r.per_criterion.find((c) => c.key === "propensity_to_spend")!;
    expect(prop.missing).toBe(true);
    expect(prop.subscore).toBe(0);
  });
});

describe("findMissingRequiredKeys", () => {
  it("lists required keys absent from values (drives 422)", () => {
    const missing = findMissingRequiredKeys(HILIGHT, { total_enrollment: 8200 });
    expect(missing.sort()).toEqual(
      ["enrollment_trend", "median_household_income", "propensity_to_spend"].sort()
    );
  });

  it("does not flag a key that is present but null", () => {
    const missing = findMissingRequiredKeys(HILIGHT, {
      total_enrollment: 8200,
      propensity_to_spend: null,
      median_household_income: 68000,
      enrollment_trend: "growing",
    });
    expect(missing).toEqual([]);
  });

  it("respects required:false", () => {
    const cfg: ScoringConfigDoc = {
      ...HILIGHT,
      criteria: HILIGHT.criteria.map((c) =>
        c.key === "propensity_to_spend" ? { ...c, required: false } : c
      ),
    };
    expect(findMissingRequiredKeys(cfg, { total_enrollment: 1 }).includes("propensity_to_spend")).toBe(false);
  });
});

describe("resolveRecommendation", () => {
  it("resolves inclusive bands", () => {
    const bands = HILIGHT.reasoning!.recommendation_bands!;
    expect(resolveRecommendation(bands, 80)).toBe("Prioritize now");
    expect(resolveRecommendation(bands, 79)).toBe("Worth a call");
    expect(resolveRecommendation(bands, 0)).toBe("Deprioritize");
  });
});

describe("hashValues", () => {
  it("is order-independent", () => {
    expect(hashValues({ a: 1, b: 2 })).toBe(hashValues({ b: 2, a: 1 }));
  });
  it("differs when a value changes", () => {
    expect(hashValues({ a: 1 })).not.toBe(hashValues({ a: 2 }));
  });
  it("normalizes NESTED object key order (no cache miss on reordered nesting)", () => {
    expect(hashValues({ signals: { a: 1, b: 2 } })).toBe(hashValues({ signals: { b: 2, a: 1 } }));
  });
  it("preserves array order (order is meaningful)", () => {
    expect(hashValues({ xs: [1, 2] })).not.toBe(hashValues({ xs: [2, 1] }));
  });
});
