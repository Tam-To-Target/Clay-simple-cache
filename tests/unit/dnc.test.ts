import { describe, it, expect } from "vitest";
import {
  normalizeEntry,
  normalizeCheckIdentifiers,
} from "../../src/services/dnc.service";

describe("normalizeEntry", () => {
  it("normalizes email, phone, and domain", () => {
    const entry = normalizeEntry({
      email: "  John@Example.COM ",
      phone: "+1 (415) 555-2671",
      domain: "https://www.Example.com/",
      reason: "  unsubscribed ",
    });
    expect(entry).not.toBeNull();
    expect(entry!.email).toBe("john@example.com");
    expect(entry!.phone_e164).toBe("+14155552671");
    expect(entry!.domain).toBe("example.com");
    expect(entry!.reason).toBe("unsubscribed");
  });

  it("returns null when no usable identifier is present", () => {
    expect(normalizeEntry({ email: "", phone: "", domain: "" })).toBeNull();
    expect(normalizeEntry({ reason: "just a reason" })).toBeNull();
  });

  it("keeps an entry with only a phone", () => {
    const entry = normalizeEntry({ phone: "+14155552671" });
    expect(entry).not.toBeNull();
    expect(entry!.email).toBeNull();
    expect(entry!.phone_e164).toBe("+14155552671");
  });
});

describe("normalizeCheckIdentifiers", () => {
  it("derives the email domain for company-level matching", () => {
    const ids = normalizeCheckIdentifiers({ email: "Jane@Acme.com" });
    expect(ids.email).toBe("jane@acme.com");
    expect(ids.email_domain).toBe("acme.com");
  });

  it("normalizes an explicit domain and phone", () => {
    const ids = normalizeCheckIdentifiers({
      domain: "https://www.acme.com",
      phone: "+1 415 555 2671",
    });
    expect(ids.domain).toBe("acme.com");
    expect(ids.phone_e164).toBe("+14155552671");
  });
});
