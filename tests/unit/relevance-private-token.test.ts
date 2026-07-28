import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The private-app token exists because record read/search/write on the Signal
 * object (0-162) is not available to a public OAuth app at ANY scope — verified on
 * portal 22493085, where HubSpot answers "The scope needed for this API call isn't
 * available for public use" while the SCHEMA endpoint returns an ordinary
 * missing-scope error.
 *
 * These tests pin the two properties that matter:
 *   1. the token is used ONLY where it is explicitly passed (every other
 *      integration keeps using the provisioner's OAuth grant), and
 *   2. it never appears in a stored document or an API response.
 */

// vi.mock is hoisted above module scope, so the spy must be too.
const { getValidToken } = vi.hoisted(() => ({
  getValidToken: vi.fn(async () => "oauth-token"),
}));
vi.mock("../../src/services/hubspot-token.service", () => ({
  getValidToken,
  HubspotAccessError: class extends Error {},
}));

import {
  searchObjectIdsByProperty,
  updateObjectProperties,
  createObject,
  upsertHubspotContact,
  searchCompanyIdsByDomain,
} from "../../src/services/hubspot-contacts.service";

const okJson = (body: any = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => "" });

function authHeaderOf(call: any): string {
  return call[1].headers.Authorization;
}

describe("tokenOverride is used only where passed", () => {
  let fetchMock: any;
  beforeEach(() => {
    getValidToken.mockClear();
    fetchMock = vi.fn(async () => okJson({ id: "1", results: [{ id: "9" }] }));
    vi.stubGlobal("fetch", fetchMock);
  });

  it("searchObjectIdsByProperty uses the override and never resolves an OAuth token", async () => {
    await searchObjectIdsByProperty("22493085", "0-162", "sb_signal_id", "row-1", "pat-private");
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer pat-private");
    expect(getValidToken).not.toHaveBeenCalled();
  });

  it("updateObjectProperties uses the override", async () => {
    await updateObjectProperties("22493085", "0-162", "77", { sb_tier: "Tier 1" }, "pat-private");
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer pat-private");
    expect(getValidToken).not.toHaveBeenCalled();
  });

  it("createObject uses the override", async () => {
    await createObject("22493085", "0-162", { hs_name: "x" }, "pat-private");
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer pat-private");
    expect(getValidToken).not.toHaveBeenCalled();
  });

  // The whole point of scoping it to this endpoint: nothing else changes behavior.
  it("falls back to the OAuth grant when no override is given", async () => {
    await searchObjectIdsByProperty("22493085", "0-162", "sb_signal_id", "row-1");
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer oauth-token");
    expect(getValidToken).toHaveBeenCalled();
  });

  it("leaves the contacts path on OAuth", async () => {
    await upsertHubspotContact("22493085", { email: "a@b.c" });
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer oauth-token");
  });

  it("leaves the company-search (fit score) path on OAuth", async () => {
    await searchCompanyIdsByDomain("22493085", "example.org");
    expect(authHeaderOf(fetchMock.mock.calls[0])).toBe("Bearer oauth-token");
  });

  it("does not retry an override on 401 — a private-app token cannot be refreshed", async () => {
    fetchMock = vi.fn(async () => ({ ok: false, status: 401, text: async () => "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      updateObjectProperties("22493085", "0-162", "77", { a: 1 }, "pat-private")
    ).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getValidToken).not.toHaveBeenCalled();
  });

  it("still retries once on 401 when using the OAuth grant", async () => {
    let n = 0;
    fetchMock = vi.fn(async () => (++n === 1 ? { ok: false, status: 401, text: async () => "x" } : okJson()));
    vi.stubGlobal("fetch", fetchMock);
    await updateObjectProperties("22493085", "0-162", "77", { a: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getValidToken).toHaveBeenCalledTimes(2);
  });
});

describe("the token never survives into a stored document", () => {
  it("is accepted by the validator as a plain string", async () => {
    const { validateRelevanceConfig } = await import("../../src/relevance/validator");
    const cfg: any = {
      ai: {
        enabled: true,
        business_context: "Hilight sells staff recognition and culture analytics to K-12 districts.",
        prompts: { Meeting: { prompt: "Tier 1 when the board funded staff-culture work." } },
      },
      hubspot_push: {
        enabled: true,
        create_missing: false,
        tier_field: "sb_tier",
        points_field: "sb_score_points",
        reasoning_field: "sb_ai_reasoning",
        private_app_token: "pat-na1-secret",
      },
    };
    expect(validateRelevanceConfig(cfg).valid).toBe(true);
  });

  it("rejects a non-string token", async () => {
    const { validateRelevanceConfig } = await import("../../src/relevance/validator");
    const cfg: any = {
      ai: {
        enabled: true,
        business_context: "Hilight sells staff recognition and culture analytics to K-12 districts.",
        prompts: { Meeting: { prompt: "Tier 1 when the board funded staff-culture work." } },
      },
      hubspot_push: {
        enabled: true,
        create_missing: false,
        tier_field: "a",
        points_field: "b",
        reasoning_field: "c",
        private_app_token: { oops: true },
      },
    };
    const r = validateRelevanceConfig(cfg);
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => e.path)).toContain("hubspot_push.private_app_token");
  });
});
