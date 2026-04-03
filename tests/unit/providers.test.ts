import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EmailListVerifyProvider } from "../../src/email-finder/providers/emaillistverify";
import { DebounceProvider } from "../../src/email-finder/providers/debounce";
import { EmailStatus, VerificationMethod } from "../../src/email-finder/types";

// Mock config
vi.mock("../../src/email-finder/config", () => ({
  config: {
    emaillistverify_api_key: "test-key",
    debounce_api_key: "test-key",
    serper_api_key: "test-key",
    max_permutations_to_try: 15,
    domain_cache_ttl: 604800,
    verification_cache_ttl: 2592000,
  },
}));

describe("EmailListVerifyProvider", () => {
  let provider: EmailListVerifyProvider;

  beforeEach(() => {
    provider = new EmailListVerifyProvider();
    vi.restoreAllMocks();
  });

  it("has correct metadata", () => {
    expect(provider.name).toBe("emaillistverify");
    expect(provider.cost_per_email).toBe(0.0004);
    expect(provider.method).toBe(VerificationMethod.emaillistverify);
  });

  it("is_configured returns true when key is set", () => {
    expect(provider.is_configured()).toBe(true);
  });

  it("maps 'ok' to valid status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("ok"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.valid);
    expect(result.confidence).toBe(0.95);
    expect(result.cost_usd).toBe(0.0004);
  });

  it("maps 'fail' to invalid status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("fail"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.invalid);
    expect(result.confidence).toBe(0.95);
  });

  it("maps 'ok_for_all' to catch_all status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("ok_for_all"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.catch_all);
  });

  it("maps 'disposable' correctly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("disposable"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.disposable);
  });

  it("maps 'role' to role_account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("role"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.role_account);
  });

  it("returns unknown on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.unknown);
    expect(result.cost_usd).toBe(0);
  });

  it("handles 'email_disabled' response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      text: () => Promise.resolve("email_disabled"),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.invalid);
    expect(result.confidence).toBe(0.9);
  });
});

describe("DebounceProvider", () => {
  let provider: DebounceProvider;

  beforeEach(() => {
    provider = new DebounceProvider();
    vi.restoreAllMocks();
  });

  it("has correct metadata", () => {
    expect(provider.name).toBe("debounce");
    expect(provider.cost_per_email).toBe(0.0015);
    expect(provider.method).toBe(VerificationMethod.debounce);
  });

  it("maps 'Safe to Send' to valid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        debounce: { result: "Safe to Send", code: "5" },
      }),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.valid);
    expect(result.confidence).toBe(0.95);
    expect(result.cost_usd).toBe(0.0015);
  });

  it("maps code '4' to catch_all regardless of result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        debounce: { result: "Safe to Send", code: "4" },
      }),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.catch_all);
  });

  it("maps 'risky' result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        debounce: { result: "Risky", code: "3" },
      }),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.risky);
  });

  it("maps 'invalid' result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        debounce: { result: "Invalid", code: "1" },
      }),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.invalid);
  });

  it("returns unknown on fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.unknown);
    expect(result.cost_usd).toBe(0);
  });

  it("returns unknown when debounce field is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      json: () => Promise.resolve({}),
    }));

    const result = await provider.verify("test@example.com");
    expect(result.status).toBe(EmailStatus.unknown);
  });
});
