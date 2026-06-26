import { describe, it, expect } from "vitest";
import {
  normalizeEmail,
  normalizeLinkedIn,
  normalizePhone,
  normalizeDomain,
} from "../../src/services/normalization";

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  John@Example.COM  ")).toBe("john@example.com");
  });

  it("handles already normalized email", () => {
    expect(normalizeEmail("user@test.com")).toBe("user@test.com");
  });
});

describe("normalizeLinkedIn", () => {
  it("extracts slug from full profile URL", () => {
    expect(normalizeLinkedIn("https://www.linkedin.com/in/john-doe")).toBe("john-doe");
  });

  it("extracts slug from company URL", () => {
    expect(normalizeLinkedIn("https://www.linkedin.com/company/acme-corp")).toBe("acme-corp");
  });

  it("extracts slug from school URL", () => {
    expect(normalizeLinkedIn("https://linkedin.com/school/mit")).toBe("mit");
  });

  it("handles URL with query params", () => {
    expect(normalizeLinkedIn("https://linkedin.com/in/john-doe?trk=public")).toBe("john-doe");
  });

  it("handles URL with trailing slash", () => {
    expect(normalizeLinkedIn("https://linkedin.com/in/john-doe/")).toBe("john-doe");
  });

  it("handles plain slug (no URL)", () => {
    expect(normalizeLinkedIn("john-doe")).toBe("john-doe");
  });

  it("handles URL without protocol", () => {
    expect(normalizeLinkedIn("linkedin.com/in/john-doe")).toBe("john-doe");
  });

  it("handles www prefix without protocol", () => {
    expect(normalizeLinkedIn("www.linkedin.com/in/john-doe")).toBe("john-doe");
  });

  it("returns null for non-linkedin URL", () => {
    expect(normalizeLinkedIn("https://twitter.com/john")).toBeNull();
  });

  it("returns null for linkedin URL with no slug", () => {
    expect(normalizeLinkedIn("https://linkedin.com/in/")).toBeNull();
  });

  it("lowercases the slug", () => {
    expect(normalizeLinkedIn("https://linkedin.com/in/John-Doe")).toBe("john-doe");
  });
});

describe("normalizePhone", () => {
  it("converts Mexican number to E.164", () => {
    const result = normalizePhone("5512345678", "MX");
    expect(result).not.toBeNull();
    expect(result!.e164).toBe("+525512345678");
  });

  it("handles number already in E.164 format", () => {
    const result = normalizePhone("+525512345678");
    expect(result).not.toBeNull();
    expect(result!.e164).toBe("+525512345678");
  });

  it("returns null for invalid phone", () => {
    expect(normalizePhone("abc")).toBeNull();
  });

  it("returns null for empty-ish numbers", () => {
    expect(normalizePhone("123")).toBeNull();
  });

  it("parses US numbers", () => {
    const result = normalizePhone("+14155551234");
    expect(result).not.toBeNull();
    expect(result!.e164).toBe("+14155551234");
  });

  it("defaults a bare national number to US (+1), not MX", () => {
    const result = normalizePhone("7032283000");
    expect(result).not.toBeNull();
    expect(result!.e164).toBe("+17032283000");
  });
});

describe("normalizeDomain", () => {
  it("removes https protocol", () => {
    expect(normalizeDomain("https://google.com")).toBe("google.com");
  });

  it("removes http protocol", () => {
    expect(normalizeDomain("http://google.com")).toBe("google.com");
  });

  it("removes www prefix", () => {
    expect(normalizeDomain("www.google.com")).toBe("google.com");
  });

  it("removes trailing slash", () => {
    expect(normalizeDomain("google.com/")).toBe("google.com");
  });

  it("handles full URL with everything", () => {
    expect(normalizeDomain("https://www.google.com/")).toBe("google.com");
  });

  it("lowercases", () => {
    expect(normalizeDomain("GOOGLE.COM")).toBe("google.com");
  });

  it("returns null for domain without dot", () => {
    expect(normalizeDomain("localhost")).toBeNull();
  });

  it("handles subdomains", () => {
    expect(normalizeDomain("mail.google.com")).toBe("mail.google.com");
  });

  it("trims whitespace", () => {
    expect(normalizeDomain("  google.com  ")).toBe("google.com");
  });
});
