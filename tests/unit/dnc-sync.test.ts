import { describe, it, expect, afterEach } from "vitest";
import { classifyDncList } from "../../src/services/hubspot-lists.service";
import { extractCorporateDomain, dncListOverrides } from "../../src/services/dnc-sync.service";
import { suggestSimilar } from "../../src/services/suggest";

describe("dncListOverrides", () => {
  afterEach(() => {
    delete process.env.DNC_LIST_OVERRIDES;
  });

  it("parses client-scoped id→level overrides", () => {
    process.env.DNC_LIST_OVERRIDES = '{"cybernut":{"1245":"individual"},"scantron":{"1356":"domain"}}';
    const o = dncListOverrides();
    expect(o.get("cybernut")?.get("1245")).toBe("individual");
    expect(o.get("scantron")?.get("1356")).toBe("domain");
  });

  it("drops invalid levels but keeps valid ones", () => {
    process.env.DNC_LIST_OVERRIDES = '{"cybernut":{"1245":"inbound","9":"domain"}}';
    const o = dncListOverrides();
    expect(o.get("cybernut")?.has("1245")).toBe(false);
    expect(o.get("cybernut")?.get("9")).toBe("domain");
  });

  it("returns an empty map for missing or invalid JSON (never throws)", () => {
    delete process.env.DNC_LIST_OVERRIDES;
    expect(dncListOverrides().size).toBe(0);
    process.env.DNC_LIST_OVERRIDES = "not json";
    expect(dncListOverrides().size).toBe(0);
  });
});

describe("classifyDncList", () => {
  it("classifies (Domain) lists, including client-suffixed names", () => {
    expect(classifyDncList("TAM - Do Not Contact (Domain)")).toBe("domain");
    expect(classifyDncList("TAM - Do Not Contact (Domain) | (Kaleidoscope)")).toBe("domain");
  });

  it("classifies (Individual) lists", () => {
    expect(classifyDncList("TAM - Do Not Contact (Individual)")).toBe("individual");
    expect(classifyDncList("TAM - Do Not Contact (Individual) | (CyberNut)")).toBe("individual");
  });

  it("returns null for unsuffixed / unknown variants", () => {
    expect(classifyDncList("TAM - Do Not Contact")).toBeNull();
    expect(classifyDncList("TAM - Do Not Contact (Inbound)")).toBeNull();
  });
});

describe("extractCorporateDomain", () => {
  const c = (over: Partial<Parameters<typeof extractCorporateDomain>[0]> = {}) => ({
    hubspot_id: "1",
    email: null,
    phone: null,
    email_domain: null,
    ...over,
  });

  it("prefers hs_email_domain, normalized", () => {
    expect(extractCorporateDomain(c({ email_domain: "Acme.COM", email: "x@other.com" }))).toBe("acme.com");
  });

  it("falls back to the email host", () => {
    expect(extractCorporateDomain(c({ email: "jane@acme.io" }))).toBe("acme.io");
  });

  it("excludes free providers so we never block a public domain", () => {
    expect(extractCorporateDomain(c({ email: "jane@gmail.com" }))).toBeNull();
    expect(extractCorporateDomain(c({ email_domain: "yahoo.com" }))).toBeNull();
  });

  it("returns null when there is no usable domain", () => {
    expect(extractCorporateDomain(c({ email: "not-an-email" }))).toBeNull();
    expect(extractCorporateDomain(c())).toBeNull();
  });
});

describe("suggestSimilar", () => {
  const candidates = [
    { id: "hilight", name: "Hilight" },
    { id: "awarded-software", name: "Awarded Software" },
    { id: "studentbridge", name: "StudentBridge" },
    { id: "stellic", name: "Stellic" },
  ];

  it("suggests the closest slug for a near miss", () => {
    expect(suggestSimilar("hilightt", candidates)).toContain("hilight");
    expect(suggestSimilar("hilite", candidates)).toContain("hilight");
  });

  it("matches on display name too", () => {
    expect(suggestSimilar("awarded", candidates)).toContain("awarded-software");
  });

  it("returns nothing for a totally unrelated query", () => {
    expect(suggestSimilar("zzzzzzzzzz", candidates)).toEqual([]);
  });
});
