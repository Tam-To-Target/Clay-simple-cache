import { describe, it, expect } from "vitest";
import {
  normalizeCampaignType,
  CAMPAIGN_TYPE_OPTIONS,
} from "../../src/services/hubspot-contacts.service";

describe("normalizeCampaignType", () => {
  it("accepts every canonical option", () => {
    for (const opt of CAMPAIGN_TYPE_OPTIONS) {
      expect(normalizeCampaignType(opt)).toBe(opt);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    expect(normalizeCampaignType("icp fit")).toBe("ICP Fit");
    expect(normalizeCampaignType("  TARGETED LIST ")).toBe("Targeted List");
    expect(normalizeCampaignType("signal")).toBe("Signal");
  });

  it("rejects unknown values", () => {
    expect(normalizeCampaignType("Bogus")).toBeNull();
    expect(normalizeCampaignType("")).toBeNull();
  });
});
