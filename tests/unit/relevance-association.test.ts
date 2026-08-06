import { describe, it, expect } from "vitest";
import {
  normalizeState,
  normalizeDomain,
  domainFromEmail,
  extractDomain,
  pickCompanies,
  resolveAssociationConfig,
  DEFAULT_ASSOCIATION_CONFIG,
} from "../../src/relevance/association";
import { validateRelevanceConfig } from "../../src/relevance/validator";

/**
 * The multi-hit fixtures are REAL collisions on Hilight's portal (22493085,
 * observed 2026-08-06). They are the whole reason this module exists — a
 * one-company-per-buyer world would not need a tie-break at all.
 */

const cfg = DEFAULT_ASSOCIATION_CONFIG;

describe("normalizeState", () => {
  it("maps Starbridge's full name onto HubSpot's abbreviation", () => {
    // Starbridge sends "New York"; HubSpot stores "NY". Comparing them raw
    // silently disables the only rule that separates two same-named districts.
    expect(normalizeState("New York")).toBe("NY");
    expect(normalizeState("new jersey")).toBe("NJ");
    expect(normalizeState("ny")).toBe("NY");
    expect(normalizeState("NC")).toBe("NC");
  });

  it("returns null for absent or unrecognizable values rather than guessing", () => {
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState("")).toBeNull();
    expect(normalizeState("Ontario")).toBeNull();
  });
});

describe("normalizeDomain / domainFromEmail", () => {
  it("strips scheme, www, path and port", () => {
    expect(normalizeDomain("https://www.Vineland.org/about?x=1")).toBe("vineland.org");
    expect(normalizeDomain("schenectady.k12.ny.us")).toBe("schenectady.k12.ny.us");
  });

  it("rejects free-mail domains, which identify a person and not an account", () => {
    // Matching a company on gmail.com would attach the signal to whatever junk
    // record happens to own that domain.
    expect(normalizeDomain("gmail.com")).toBeNull();
    expect(domainFromEmail("super@gmail.com")).toBeNull();
    expect(domainFromEmail("super@vineland.org")).toBe("vineland.org");
  });

  it("rejects non-domain junk", () => {
    expect(normalizeDomain("n/a")).toBeNull();
    expect(normalizeDomain("")).toBeNull();
    expect(domainFromEmail("not-an-email")).toBeNull();
  });
});

describe("extractDomain", () => {
  it("prefers an explicit buyer domain over a contact's email domain", () => {
    // A contact can be a consultant or vendor rep at a different entity, so the
    // buyer's own domain outranks their address.
    const d = extractDomain(
      { "buyer:domain": "district.k12.ca.us", emailAddress: "consultant@someagency.com" },
      null
    );
    expect(d).toBe("district.k12.ca.us");
  });

  it("digs the email out of op_template:web_contact", () => {
    const d = extractDomain({ "op_template:web_contact": { emailAddress: "j@wynneschools.org" } }, null);
    expect(d).toBe("wynneschools.org");
  });

  it("falls back to the spine contact email", () => {
    expect(extractDomain({}, "a@caldwellschools.com")).toBe("caldwellschools.com");
  });

  it("returns null when the signal carries no domain at all", () => {
    // The common case on Meeting bridges: buyer id and name only.
    expect(extractDomain({ "Match Score": 5 }, null)).toBeNull();
  });
});

describe("pickCompanies", () => {
  const c = (id: string, props: Record<string, any> = {}) => ({ id, properties: props });

  it("takes the single match without ceremony", () => {
    const r = pickCompanies([c("10858769764", { state: "NJ" })], {
      buyerState: "New Jersey",
      buyerId: "036b1398",
      config: cfg,
      strategy: "buyer_id",
    });
    expect(r.chosen).toEqual(["10858769764"]);
    expect(r.warning).toBeUndefined();
  });

  it("breaks a duplicate-record tie on state, and names the loser", () => {
    // REAL: Schenectady City School District has two company records under one
    // starbridge_buyer_id — schenectady.k12.ny.us (state NY) and
    // schenectadyschools.org (state blank).
    const r = pickCompanies(
      [c("29310427519", { state: "NY" }), c("46599467633", { state: null })],
      { buyerState: "New York", buyerId: "67f47780", config: cfg, strategy: "buyer_id" }
    );
    expect(r.chosen).toEqual(["29310427519"]);
    expect(r.warning).toContain("46599467633");
    expect(r.warning).toMatch(/dedupe/i);
  });

  it("separates two genuinely different districts sharing one buyer id", () => {
    // REAL: buyer id f663f78c-… is stamped on Cherokee County NC AND Cherokee
    // County SC. State is the only thing that tells them apart.
    const candidates = [c("10858769760", { state: "NC" }), c("21490956449", { state: "SC" })];
    const nc = pickCompanies(candidates, {
      buyerState: "North Carolina",
      buyerId: "f663f78c",
      config: cfg,
      strategy: "buyer_id",
    });
    const sc = pickCompanies(candidates, {
      buyerState: "South Carolina",
      buyerId: "f663f78c",
      config: cfg,
      strategy: "buyer_id",
    });
    expect(nc.chosen).toEqual(["10858769760"]);
    expect(sc.chosen).toEqual(["21490956449"]);
  });

  it("refuses a name match in the wrong state, even as the ONLY candidate", () => {
    // REAL near-miss: the North Carolina "Lincoln County School District" signal
    // exact-name-matched a MISSISSIPPI company (lincoln.k12.ms.us). District
    // names repeat across states, so a known-and-contradicting state is a wrong
    // match, not a weak one.
    const r = pickCompanies([c("10344953222", { state: "MS", name: "Lincoln County School District" })], {
      buyerState: "North Carolina",
      buyerId: "whatever",
      config: cfg,
      strategy: "name",
    });
    expect(r.chosen).toEqual([]);
    expect(r.warning).toContain("NC");
  });

  it("still accepts a name match when the company has no state on file", () => {
    // Blank state is missing data, not a contradiction — do not punish it.
    const r = pickCompanies([c("55", { state: null })], {
      buyerState: "North Carolina", buyerId: null, config: cfg, strategy: "name",
    });
    expect(r.chosen).toEqual(["55"]);
  });

  it("does NOT apply the state veto to buyer_id or domain matches", () => {
    // Both are authoritative identifiers; a state disagreement there means stale
    // CRM data, not the wrong district.
    for (const strategy of ["buyer_id", "domain"] as const) {
      const r = pickCompanies([c("77", { state: "MS" })], {
        buyerState: "North Carolina", buyerId: "abc", config: cfg, strategy,
      });
      expect(r.chosen).toEqual(["77"]);
    }
  });

  it("prefers the buyer-id-stamped record when the match came from a name search", () => {
    const r = pickCompanies(
      [c("999", {}), c("111", { starbridge_buyer_id: "abc" })],
      { buyerState: null, buyerId: "abc", config: cfg, strategy: "name" }
    );
    expect(r.chosen).toEqual(["111"]);
  });

  it("falls back to the oldest record so a signal is never silently dropped", () => {
    // No state, no buyer-id stamp — still terminates on a choice rather than
    // leaving the signal unassociated.
    const r = pickCompanies([c("300"), c("100"), c("200")], {
      buyerState: null,
      buyerId: null,
      config: cfg,
      strategy: "domain",
    });
    expect(r.chosen).toEqual(["100"]);
    expect(r.warning).toContain("300");
  });

  it('honours on_multiple:"all" and on_multiple:"skip"', () => {
    const candidates = [c("1"), c("2")];
    const all = pickCompanies(candidates, {
      buyerState: null, buyerId: null, config: { ...cfg, on_multiple: "all" }, strategy: "buyer_id",
    });
    expect(all.chosen).toEqual(["1", "2"]);

    const skip = pickCompanies(candidates, {
      buyerState: null, buyerId: null, config: { ...cfg, on_multiple: "skip" }, strategy: "buyer_id",
    });
    expect(skip.chosen).toEqual([]);
    expect(skip.warning).toMatch(/not associated/i);
  });

  it("returns nothing when there is nothing", () => {
    expect(pickCompanies([], { config: cfg, strategy: "buyer_id" }).chosen).toEqual([]);
  });
});

describe("resolveAssociationConfig", () => {
  it("defaults to on, buyer_id-first, and NEVER creating companies", () => {
    const r = resolveAssociationConfig(undefined);
    expect(r.enabled).toBe(true);
    expect(r.strategies[0]).toBe("buyer_id");
    // Starbridge emits district/school/program at one domain — blanket creation
    // measured 5 junk records out of 6, so this stays opt-in.
    expect(r.create_missing_company).toBe(false);
  });

  it("lets a portal override the buyer-id property name", () => {
    // The crosswalk property is client-installed, not a HubSpot standard, so its
    // name differs per portal.
    const r = resolveAssociationConfig({ buyer_id_property: "sb_buyer_uuid" });
    expect(r.buyer_id_property).toBe("sb_buyer_uuid");
    expect(r.domain_property).toBe("domain");
  });

  it("ignores an empty strategy list instead of disabling matching entirely", () => {
    expect(resolveAssociationConfig({ strategies: [] }).strategies.length).toBeGreaterThan(0);
  });
});

describe("validator — hubspot_push.association", () => {
  const base = (association: any) => ({
    client_id: "t",
    ai: {
      enabled: true,
      business_context: "x".repeat(80),
      prompts: { Meeting: { prompt: "Tier 1 — the board approved something budgeted." } },
    },
    hubspot_push: {
      enabled: true,
      tier_field: "sb_tier",
      points_field: "sb_score_points",
      reasoning_field: "sb_ai_reasoning",
      pipeline_stage: "stage-1",
      association,
    },
  });

  it("accepts a full valid block", () => {
    const r = validateRelevanceConfig(
      base({ enabled: true, strategies: ["buyer_id", "domain"], buyer_id_property: "sb_buyer_uuid", on_multiple: "primary" })
    );
    expect(r.valid).toBe(true);
  });

  it("rejects an unknown strategy", () => {
    const r = validateRelevanceConfig(base({ strategies: ["buyer_id", "telepathy"] }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.path.includes("strategies"))).toBe(true);
  });

  it("rejects a bad on_multiple and a non-integer association_type_id", () => {
    expect(validateRelevanceConfig(base({ on_multiple: "whatever" })).valid).toBe(false);
    expect(validateRelevanceConfig(base({ association_type_id: "792" })).valid).toBe(false);
    // null is meaningful: use HubSpot's default association type for the pair.
    expect(validateRelevanceConfig(base({ association_type_id: null })).valid).toBe(true);
  });
});
