import { describe, it, expect } from "vitest";
import {
  normalizeName,
  parseFullName,
  generatePermutations,
  generatePermutationsFromFullName,
  prioritizePermutations,
  identifyPattern,
} from "../../src/email-finder/permutator";

describe("normalizeName", () => {
  it("removes accents", () => {
    expect(normalizeName("José")).toBe("jose");
  });

  it("removes accents from ñ", () => {
    expect(normalizeName("Muñoz")).toBe("munoz");
  });

  it("lowercases and trims", () => {
    expect(normalizeName("  JOHN  ")).toBe("john");
  });

  it("removes non-alphanumeric except hyphens", () => {
    expect(normalizeName("O'Brien")).toBe("obrien");
  });

  it("keeps hyphens", () => {
    expect(normalizeName("María-José")).toBe("maria-jose");
  });
});

describe("parseFullName", () => {
  it("handles single word", () => {
    expect(parseFullName("John")).toEqual(["John", ""]);
  });

  it("handles two words", () => {
    expect(parseFullName("John Doe")).toEqual(["John", "Doe"]);
  });

  it("handles three words (LATAM: first + second word)", () => {
    expect(parseFullName("Carlos García López")).toEqual(["Carlos", "García"]);
  });

  it("handles four words (LATAM: first + penultimate)", () => {
    expect(parseFullName("Carlos Eduardo García López")).toEqual(["Carlos", "García"]);
  });

  it("handles empty string", () => {
    expect(parseFullName("")).toEqual(["", ""]);
  });

  it("handles extra whitespace", () => {
    expect(parseFullName("  John   Doe  ")).toEqual(["John", "Doe"]);
  });
});

describe("generatePermutations", () => {
  it("generates emails for john doe at example.com", () => {
    const perms = generatePermutations("john", "doe", "example.com");
    expect(perms).toContain("john.doe@example.com");
    expect(perms).toContain("jdoe@example.com");
    expect(perms).toContain("john@example.com");
    expect(perms).toContain("johndoe@example.com");
    expect(perms).toContain("john_doe@example.com");
    expect(perms).toContain("doe@example.com");
    expect(perms).toContain("doej@example.com");
    expect(perms).toContain("doe.john@example.com");
    expect(perms).toContain("j.doe@example.com");
    expect(perms).toContain("john.d@example.com");
    expect(perms).toContain("johnd@example.com");
    expect(perms).toContain("john-doe@example.com");
    expect(perms).toContain("j_doe@example.com");
    expect(perms).toContain("doe_john@example.com");
    expect(perms).toContain("doe.j@example.com");
  });

  it("generates no duplicates", () => {
    const perms = generatePermutations("john", "doe", "example.com");
    const unique = new Set(perms);
    expect(perms.length).toBe(unique.size);
  });

  it("returns empty for no name", () => {
    expect(generatePermutations("", "", "example.com")).toEqual([]);
  });

  it("returns empty when only first name (no last)", () => {
    // The code requires last name for most patterns; "first" pattern requires !l check
    const perms = generatePermutations("john", "", "example.com");
    // With empty last name, only "first" pattern applies but code checks !["first"].includes
    // which means it skips when l is empty for all non-"first" patterns
    // Let's verify the actual behavior
    expect(perms).toEqual([]);
  });

  it("handles hyphenated first name variants", () => {
    const perms = generatePermutations("maria-jose", "garcia", "example.com");
    expect(perms).toContain("maria-jose.garcia@example.com");
    expect(perms).toContain("mariajose.garcia@example.com");
  });

  it("handles compound last names", () => {
    const perms = generatePermutations("carlos", "de la cruz", "example.com");
    expect(perms.some((p) => p.includes("delacruz"))).toBe(true);
    expect(perms.some((p) => p.includes("cruz"))).toBe(true);
  });
});

describe("generatePermutationsFromFullName", () => {
  it("generates extra permutations for multi-word names", () => {
    const perms = generatePermutationsFromFullName("Carlos García López", "example.com");
    expect(perms.length).toBeGreaterThan(0);
  });

  it("returns empty for two-word names", () => {
    expect(generatePermutationsFromFullName("John Doe", "example.com")).toEqual([]);
  });

  it("returns empty for single word", () => {
    expect(generatePermutationsFromFullName("John", "example.com")).toEqual([]);
  });
});

describe("identifyPattern", () => {
  it("identifies first.last pattern", () => {
    expect(identifyPattern("john.doe@example.com", "john", "doe")).toBe("first.last");
  });

  it("identifies flast pattern", () => {
    expect(identifyPattern("jdoe@example.com", "john", "doe")).toBe("flast");
  });

  it("identifies first pattern", () => {
    expect(identifyPattern("john@example.com", "john", "doe")).toBe("first");
  });

  it("identifies firstlast pattern", () => {
    expect(identifyPattern("johndoe@example.com", "john", "doe")).toBe("firstlast");
  });

  it("identifies first_last pattern", () => {
    expect(identifyPattern("john_doe@example.com", "john", "doe")).toBe("first_last");
  });

  it("identifies last.first pattern", () => {
    expect(identifyPattern("doe.john@example.com", "john", "doe")).toBe("last.first");
  });

  it("returns null for unrecognized pattern", () => {
    expect(identifyPattern("xyz123@example.com", "john", "doe")).toBeNull();
  });
});

describe("prioritizePermutations", () => {
  it("returns original order with no known patterns", () => {
    const perms = ["a@b.com", "c@b.com"];
    expect(prioritizePermutations(perms, [])).toEqual(perms);
  });

  it("preserves all permutations (no emails lost)", () => {
    const perms = generatePermutations("john", "doe", "example.com");
    const result = prioritizePermutations(perms, [
      { pattern: "flast", confidence: 0.9, sample_count: 5 },
    ]);
    expect(result.length).toBe(perms.length);
    expect(new Set(result)).toEqual(new Set(perms));
  });

  it("moves at least one email to prioritized section when pattern matches", () => {
    const perms = generatePermutations("john", "doe", "example.com");
    const result = prioritizePermutations(perms, [
      { pattern: "first.last", confidence: 0.9, sample_count: 5 },
    ]);
    // With a known pattern, the first email should be one from the prioritized set
    // (matchesPattern moves the first matching local part to front)
    expect(result.length).toBe(perms.length);
    expect(result[0]).toBe("john.doe@example.com");
  });
});
