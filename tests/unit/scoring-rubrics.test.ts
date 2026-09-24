import { describe, it, expect } from "vitest";
import {
  computeScore,
  capScore,
  resolveRubric,
  buildSummary,
  hashValues,
  findMissingRequiredKeys,
} from "../../src/scoring/engine";
import { evaluateCriterion } from "../../src/scoring/criteria";
import { validateConfig } from "../../src/scoring/validator";
import type { Criterion, ScoringConfigDoc } from "../../src/scoring/types";

/**
 * A points-style rubric (Starbridge-shaped): each criterion's max points is its
 * weight × 100, and each tier's points are expressed as a 0-100 share of that
 * max. Population: 20 pts max; IT spend: 80 pts max.
 */
const POP: Criterion = {
  key: "population",
  type: "numeric_tiers",
  weight: 0.2,
  missing_score: 15, // 3 of 20 pts
  tiers: [
    { min: 0, max: 25000, score: 40 }, // 8 pts
    { min: 25000, max: 50000, score: 75 }, // 15
    { min: 50000, max: 500001, score: 100 }, // 20
    { min: 500001, max: null, score: 70 }, // 14
  ],
};
const SPEND: Criterion = {
  key: "it_spend",
  type: "numeric_tiers",
  weight: 0.8,
  missing_score: 12.5, // 10 of 80 pts
  tiers: [
    { min: 0, max: 100000, score: 50 },
    { min: 100000, max: null, score: 100 },
  ],
};

const MULTI: ScoringConfigDoc = {
  client_id: "acme",
  rubrics: {
    cities: { criteria: [POP, SPEND] },
    ports: { criteria: [{ ...SPEND, weight: 1 }] },
  },
  reasoning: {
    enabled: false,
    recommendation_bands: [
      { min: 70, max: 100, label: "High Fit" },
      { min: 40, max: 69, label: "Medium Fit" },
      { min: 0, max: 39, label: "Low Fit" },
    ],
  },
};

describe("capScore — the 100 ceiling", () => {
  it("clamps above 100, below 0, rounds, and zeroes garbage", () => {
    expect(capScore(138)).toBe(100);
    expect(capScore(100.4)).toBe(100);
    expect(capScore(-5)).toBe(0);
    expect(capScore(69.6)).toBe(70);
    expect(capScore("103")).toBe(100);
    expect(capScore(NaN)).toBe(0);
    expect(capScore(undefined)).toBe(0);
  });

  it("a config that sneaks out-of-range numbers past validation still cannot exceed 100", () => {
    // Weights summing to 2 and a tier worth 500 — the validator would reject
    // this, but a stored/legacy doc must still never produce > 100.
    const bad = {
      client_id: "x",
      criteria: [
        { key: "a", type: "numeric_tiers", weight: 1.5, tiers: [{ min: 0, max: null, score: 500 }] },
        { key: "b", type: "passthrough", weight: 0.5 },
      ],
    } as unknown as ScoringConfigDoc;
    const r = computeScore(bad, { a: 10, b: 9999 });
    expect(r.final_score).toBe(100);
    expect(r.per_criterion.every((c) => c.subscore <= 100)).toBe(true);
  });
});

describe("missing_score (grace points)", () => {
  it("awards missing_score for an absent value and flags it missing", () => {
    expect(evaluateCriterion(null, POP)).toEqual({ subscore: 15, missing: true });
    expect(evaluateCriterion("", POP)).toEqual({ subscore: 15, missing: true });
  });
  it("defaults to 0 when not set", () => {
    const { missing_score, ...noGrace } = POP as any;
    expect(evaluateCriterion(undefined, noGrace)).toEqual({ subscore: 0, missing: true });
  });
  it("points add up the way the rubric says: no data anywhere = 3 + 10 = 13", () => {
    const r = computeScore(MULTI, { population: null, it_spend: null }, MULTI.rubrics!.cities.criteria);
    expect(r.final_score).toBe(13);
    expect(r.recommendation).toBe("Low Fit");
  });
});

describe("numeric_tiers override (share of value)", () => {
  const ENROLL: Criterion = {
    key: "total_enrollment",
    type: "numeric_tiers",
    weight: 1,
    tiers: [
      { min: 0, max: 15000, score: 50 },
      { min: 15000, max: null, score: 100 },
    ],
    override: { share_key: "online_enrollment", above: 0.5, score: 15 },
  };
  it("applies when the share is above the threshold", () => {
    expect(evaluateCriterion(20000, ENROLL, { online_enrollment: 15000 }).subscore).toBe(15);
  });
  it("does not apply at or below the threshold, or when the share is absent", () => {
    expect(evaluateCriterion(20000, ENROLL, { online_enrollment: 10000 }).subscore).toBe(100);
    expect(evaluateCriterion(20000, ENROLL, {}).subscore).toBe(100);
  });
});

describe("resolveRubric", () => {
  it("requires a rubric name on multi-rubric configs", () => {
    const r = resolveRubric(MULTI, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.available).toEqual(["cities", "ports"]);
  });
  it("rejects an unknown rubric", () => {
    expect(resolveRubric(MULTI, "counties").ok).toBe(false);
  });
  it("selects the named rubric", () => {
    const r = resolveRubric(MULTI, "ports");
    expect(r.ok && r.criteria.length).toBe(1);
  });
  it("ignores rubric on single-rubric configs", () => {
    const single = { client_id: "s", criteria: [{ ...SPEND, weight: 1 }] } as ScoringConfigDoc;
    const r = resolveRubric(single, "anything");
    expect(r.ok && r.rubric).toBe(null);
  });
  it("findMissingRequiredKeys works against a rubric's criteria", () => {
    expect(findMissingRequiredKeys(MULTI.rubrics!.cities.criteria, { population: 1 })).toEqual(["it_spend"]);
  });
});

describe("hashValues with rubric", () => {
  it("single-rubric hashes are unchanged; rubric-scoped hashes differ per rubric", () => {
    const v = { a: 1 };
    expect(hashValues(v)).toBe(hashValues(v, null));
    expect(hashValues(v, "cities")).not.toBe(hashValues(v, "ports"));
    expect(hashValues(v, "cities")).not.toBe(hashValues(v));
  });
});

describe("buildSummary", () => {
  it("names the band, strongest/weakest in points, and missing inputs", () => {
    const r = computeScore(MULTI, { population: 60000, it_spend: null }, MULTI.rubrics!.cities.criteria);
    expect(r.final_score).toBe(30); // 20 + 10
    const s = buildSummary(r.final_score, r.recommendation, r.per_criterion);
    expect(s).toBe("Low Fit (score 30): strongest population (20 pts), weakest it_spend (10 pts); 1 of 2 inputs missing.");
  });
});

describe("validateConfig — rubrics", () => {
  it("accepts a valid multi-rubric config", () => {
    const v = validateConfig(MULTI);
    expect(v.errors).toEqual([]);
  });
  it("rejects criteria + rubrics together", () => {
    const v = validateConfig({ ...MULTI, criteria: [SPEND] });
    expect(v.valid).toBe(false);
  });
  it("checks weights per rubric", () => {
    const v = validateConfig({ ...MULTI, rubrics: { cities: { criteria: [POP] } } });
    expect(v.valid).toBe(false);
    expect(v.errors[0].path).toBe("rubrics.cities.criteria");
  });
  it("rejects a non-slug rubric name", () => {
    const v = validateConfig({ ...MULTI, rubrics: { Cities: { criteria: [{ ...SPEND, weight: 1 }] } } });
    expect(v.valid).toBe(false);
  });
  it("rejects missing_score and override out of range", () => {
    const v = validateConfig({
      client_id: "x",
      criteria: [
        {
          ...POP,
          weight: 1,
          missing_score: 140,
          override: { share_key: "", above: -1, score: 200 },
        },
      ],
    });
    const paths = v.errors.map((e) => e.path);
    expect(paths).toContain("criteria[0].missing_score");
    expect(paths).toContain("criteria[0].override.share_key");
    expect(paths).toContain("criteria[0].override.above");
    expect(paths).toContain("criteria[0].override.score");
  });
});
