import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/scoring/validator";
import type { ScoringConfigDoc } from "../../src/scoring/types";

const base = (): ScoringConfigDoc => ({
  client_id: "acme",
  criteria: [
    {
      key: "enrollment",
      type: "numeric_tiers",
      weight: 0.5,
      tiers: [
        { min: 0, max: 1000, score: 20 },
        { min: 1000, max: null, score: 100 },
      ],
    },
    {
      key: "trend",
      type: "categorical",
      weight: 0.5,
      map: { growing: 100, declining: 20 },
      default: 0,
    },
  ],
});

const paths = (r: ReturnType<typeof validateConfig>) => r.errors.map((e) => e.path);

describe("validateConfig — happy path", () => {
  it("accepts a well-formed config", () => {
    expect(validateConfig(base()).valid).toBe(true);
  });
});

describe("weights", () => {
  it("rejects weights that don't sum to 1.0 (no auto-normalize)", () => {
    const c = base();
    c.criteria[0].weight = 0.6; // sum 1.1
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(paths(r)).toContain("criteria");
  });
});

describe("numeric_tiers", () => {
  it("rejects a gap between tiers", () => {
    const c = base();
    (c.criteria[0] as any).tiers = [
      { min: 0, max: 1000, score: 20 },
      { min: 2000, max: null, score: 100 }, // gap 1000..2000
    ];
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /gap/.test(e.message))).toBe(true);
  });

  it("rejects overlapping tiers", () => {
    const c = base();
    (c.criteria[0] as any).tiers = [
      { min: 0, max: 1500, score: 20 },
      { min: 1000, max: null, score: 100 }, // overlap
    ];
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /overlap/.test(e.message))).toBe(true);
  });

  it("rejects max:null on a non-last tier", () => {
    const c = base();
    (c.criteria[0] as any).tiers = [
      { min: 0, max: null, score: 20 },
      { min: 1000, max: 2000, score: 100 },
    ];
    expect(validateConfig(c).valid).toBe(false);
  });
});

describe("categorical", () => {
  it("rejects a missing default", () => {
    const c = base();
    delete (c.criteria[1] as any).default;
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(paths(r)).toContain("criteria[1].default");
  });
});

describe("unique keys", () => {
  it("rejects duplicate criterion keys", () => {
    const c = base();
    c.criteria[1].key = "enrollment";
    expect(validateConfig(c).valid).toBe(false);
  });
});

describe("hubspot_push", () => {
  it("requires both field names when enabled", () => {
    const c = base();
    c.hubspot_push = { enabled: true, score_field: "lead_fit_score" };
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(paths(r)).toContain("hubspot_push.reasoning_field");
  });

  it("accepts optional object_type + identity_fields", () => {
    const c = base();
    c.hubspot_push = {
      enabled: true,
      score_field: "lead_fit_score",
      reasoning_field: "lead_fit_score_reasoning",
      object_type: "companies",
      identity_fields: { account_name: "name", account_domain: "domain", starbridge_id: "starbridge_id" },
    };
    expect(validateConfig(c).valid).toBe(true);
  });

  it("rejects an unknown identity key or non-string mapping", () => {
    const c = base();
    c.hubspot_push = {
      enabled: true,
      score_field: "s",
      reasoning_field: "r",
      identity_fields: { account_name: "name", bogus: "x" } as any,
    };
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(paths(r)).toContain("hubspot_push.identity_fields.bogus");
  });
});

describe("score bounds (0-100)", () => {
  it("rejects a tier score above 100", () => {
    const c = base();
    (c.criteria[0] as any).tiers[1].score = 1000;
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /0-100/.test(e.message))).toBe(true);
  });

  it("rejects a categorical map value or default outside 0-100", () => {
    const c = base();
    (c.criteria[1] as any).map.growing = 150;
    expect(validateConfig(c).valid).toBe(false);
    const c2 = base();
    (c2.criteria[1] as any).default = -5;
    expect(validateConfig(c2).valid).toBe(false);
  });
});

describe("recommendation bands validated regardless of reasoning.enabled", () => {
  it("rejects gapped bands even when reasoning is disabled (engine uses them unconditionally)", () => {
    const c = base();
    c.reasoning = {
      enabled: false,
      recommendation_bands: [
        { min: 0, max: 49, label: "low" },
        { min: 60, max: 100, label: "high" }, // gap 49..60
      ],
    };
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /contiguous|gap/.test(e.message))).toBe(true);
  });

  it("rejects fractional band boundaries (scores are integers)", () => {
    const c = base();
    c.reasoning = {
      enabled: false,
      recommendation_bands: [
        { min: 0, max: 49.5, label: "low" },
        { min: 50.5, max: 100, label: "high" }, // gap===1 but 50 uncovered
      ],
    };
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /integer/.test(e.message))).toBe(true);
  });
});

describe("reasoning bands", () => {
  it("requires prompt + bands when enabled", () => {
    const c = base();
    c.reasoning = { enabled: true };
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(paths(r)).toContain("reasoning.prompt");
  });

  it("rejects bands that don't cover 0-100 contiguously", () => {
    const c = base();
    c.reasoning = {
      enabled: true,
      prompt: "x",
      recommendation_bands: [
        { min: 0, max: 49, label: "low" },
        { min: 60, max: 100, label: "high" }, // gap 49..60
      ],
    };
    const r = validateConfig(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /contiguous|gap/.test(e.message))).toBe(true);
  });

  it("accepts contiguous bands covering 0-100", () => {
    const c = base();
    c.reasoning = {
      enabled: true,
      prompt: "x",
      recommendation_bands: [
        { min: 0, max: 49, label: "low" },
        { min: 50, max: 100, label: "high" },
      ],
    };
    expect(validateConfig(c).valid).toBe(true);
  });
});

describe("structural", () => {
  it("rejects a non-object", () => {
    expect(validateConfig(null).valid).toBe(false);
    expect(validateConfig([]).valid).toBe(false);
  });
  it("rejects empty criteria", () => {
    expect(validateConfig({ client_id: "x", criteria: [] }).valid).toBe(false);
  });
  it("rejects an unknown criterion type", () => {
    const c: any = base();
    c.criteria[0].type = "magic";
    expect(validateConfig(c).valid).toBe(false);
  });
});
