import { describe, it, expect } from "vitest";
import {
  EmailStatus,
  VerificationMethod,
  ProviderType,
  CONCLUSIVE_STATUSES,
} from "../../src/email-finder/types";

describe("EmailStatus enum", () => {
  it("has all expected values", () => {
    expect(EmailStatus.valid).toBe("valid");
    expect(EmailStatus.invalid).toBe("invalid");
    expect(EmailStatus.catch_all).toBe("catch_all");
    expect(EmailStatus.unknown).toBe("unknown");
    expect(EmailStatus.risky).toBe("risky");
    expect(EmailStatus.disposable).toBe("disposable");
    expect(EmailStatus.no_mx).toBe("no_mx");
    expect(EmailStatus.role_account).toBe("role_account");
  });
});

describe("CONCLUSIVE_STATUSES", () => {
  it("includes valid, invalid, and catch_all", () => {
    expect(CONCLUSIVE_STATUSES).toContain(EmailStatus.valid);
    expect(CONCLUSIVE_STATUSES).toContain(EmailStatus.invalid);
    expect(CONCLUSIVE_STATUSES).toContain(EmailStatus.catch_all);
  });

  it("does not include risky or unknown", () => {
    expect(CONCLUSIVE_STATUSES).not.toContain(EmailStatus.risky);
    expect(CONCLUSIVE_STATUSES).not.toContain(EmailStatus.unknown);
  });
});

describe("VerificationMethod enum", () => {
  it("has all expected values", () => {
    expect(VerificationMethod.local_syntax).toBe("local_syntax");
    expect(VerificationMethod.emaillistverify).toBe("emaillistverify");
    expect(VerificationMethod.debounce).toBe("debounce");
    expect(VerificationMethod.serp_pattern).toBe("serp_pattern");
  });
});

describe("ProviderType enum", () => {
  it("has all expected values", () => {
    expect(ProviderType.google_workspace).toBe("google_workspace");
    expect(ProviderType.office365).toBe("office365");
    expect(ProviderType.yahoo).toBe("yahoo");
    expect(ProviderType.other).toBe("other");
  });
});
