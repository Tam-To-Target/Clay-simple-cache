import { describe, it, expect, afterEach } from "vitest";
import { OPENAI_BASE, defaultModel, isReasoningFamily, chatTuning } from "../../src/services/openai-model";

const OLD = { model: process.env.OPENAI_DEFAULT_MODEL, base: process.env.OPENAI_BASE_URL };
afterEach(() => {
  for (const [k, v] of [
    ["OPENAI_DEFAULT_MODEL", OLD.model],
    ["OPENAI_BASE_URL", OLD.base],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("defaultModel", () => {
  it("is gpt-5.6-luna", () => {
    delete process.env.OPENAI_DEFAULT_MODEL;
    expect(defaultModel()).toBe("gpt-5.6-luna");
  });

  it("is overridable by env so a rename is not a deploy", () => {
    process.env.OPENAI_DEFAULT_MODEL = "gpt-5.6-terra";
    expect(defaultModel()).toBe("gpt-5.6-terra");
  });
});

describe("OPENAI_BASE", () => {
  it("strips a trailing slash so path concatenation cannot double it", () => {
    process.env.OPENAI_BASE_URL = "https://proxy.internal/v1/";
    expect(OPENAI_BASE()).toBe("https://proxy.internal/v1");
  });
});

describe("isReasoningFamily", () => {
  it("matches the gpt-5.6 family and the o-series", () => {
    for (const m of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "GPT-5.6-Luna", "o3", "o4-mini"]) {
      expect(isReasoningFamily(m), m).toBe(true);
    }
  });

  // The narrow allowlist is the point: gpt-5.4-mini accepts temperature today
  // and a broad /^gpt-5/ match would have silently stopped sending it.
  it("does not match models that still accept temperature", () => {
    for (const m of ["gpt-5.4-mini", "gpt-5.4", "gpt-4o-mini", "gpt-4.1"]) {
      expect(isReasoningFamily(m), m).toBe(false);
    }
  });
});

describe("chatTuning", () => {
  it("keeps temperature for a legacy model and omits reasoning_effort", () => {
    // Legacy models 400 on reasoning_effort, so it must not leak through.
    expect(chatTuning("gpt-5.4-mini", { temperature: 0, effort: "none" })).toEqual({ temperature: 0 });
  });

  it("swaps temperature for reasoning_effort on a reasoning-family model", () => {
    // gpt-5.6-* rejects any temperature other than 1.
    expect(chatTuning("gpt-5.6-luna", { temperature: 0, effort: "none" })).toEqual({
      reasoning_effort: "none",
    });
  });

  it("emits nothing when the caller states no intent for this family", () => {
    expect(chatTuning("gpt-5.6-luna", {})).toEqual({});
    expect(chatTuning("gpt-5.4-mini", {})).toEqual({});
    expect(chatTuning("gpt-5.6-luna", { temperature: 0 })).toEqual({});
    expect(chatTuning("gpt-5.4-mini", { effort: "none" })).toEqual({});
  });
});
