import { describe, it, expect } from "vitest";
import { identifyPatternsFromEmails } from "../../src/email-finder/providers/serper";

describe("identifyPatternsFromEmails", () => {
  it("returns empty for no emails", () => {
    expect(identifyPatternsFromEmails([])).toEqual([]);
  });

  it("detects first.last pattern from separator-based emails", () => {
    const emails = [
      "john.doe@acme.com",
      "jane.smith@acme.com",
      "bob.jones@acme.com",
    ];
    const result = identifyPatternsFromEmails(emails);
    expect(result[0].pattern).toBe("first.last");
    expect(result[0].count).toBe(3);
  });

  it("detects f.last pattern (short.long)", () => {
    const emails = [
      "j.doe@acme.com",
      "m.smith@acme.com",
      "a.garcia@acme.com",
    ];
    const result = identifyPatternsFromEmails(emails);
    expect(result[0].pattern).toBe("f.last");
    expect(result[0].count).toBe(3);
  });

  it("detects first_last pattern", () => {
    const emails = [
      "john_doe@acme.com",
      "jane_smith@acme.com",
    ];
    const result = identifyPatternsFromEmails(emails);
    expect(result[0].pattern).toBe("first_last");
  });

  it("detects first-last pattern", () => {
    const emails = [
      "john-doe@acme.com",
      "jane-smith@acme.com",
    ];
    const result = identifyPatternsFromEmails(emails);
    expect(result[0].pattern).toBe("first-last");
  });

  it("detects flast via cross-referencing no-separator emails", () => {
    const emails = [
      "jdoe@acme.com",
      "msmith@acme.com",
      "agarcia@acme.com",
    ];
    const result = identifyPatternsFromEmails(emails);
    const flastResult = result.find((r) => r.pattern === "flast");
    expect(flastResult).toBeDefined();
    expect(flastResult!.count).toBeGreaterThanOrEqual(2);
  });

  it("stores up to 3 examples per pattern", () => {
    const emails = [
      "a.one@acme.com",
      "b.two@acme.com",
      "c.three@acme.com",
      "d.four@acme.com",
      "e.five@acme.com",
    ];
    const result = identifyPatternsFromEmails(emails);
    expect(result[0].examples.length).toBeLessThanOrEqual(3);
  });

  it("sorts results by count descending", () => {
    const emails = [
      "john.doe@acme.com",
      "jane.smith@acme.com",
      "j.jones@acme.com", // f.last
    ];
    const result = identifyPatternsFromEmails(emails);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].count).toBeLessThanOrEqual(result[i - 1].count);
    }
  });

  it("handles mixed separator and no-separator emails", () => {
    const emails = [
      "john.doe@acme.com",
      "jane.smith@acme.com",
      "bjones@acme.com", // inferred from first.last context
    ];
    const result = identifyPatternsFromEmails(emails);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].pattern).toBe("first.last");
  });
});
