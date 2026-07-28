import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getValidToken, clearTokenCache } from "../../src/services/hubspot-token.service";

/**
 * The override exists because record-level access to some HubSpot objects is not
 * available to public OAuth apps at all. Verified against portal 22493085 on
 * 2026-07-28: GET /crm/v3/objects/0-162 and POST /crm/v3/objects/0-162/search both
 * return "The scope needed for this API call isn't available for public use",
 * while GET /crm/v3/properties/0-162 returns a normal missing-scope error. So the
 * schema is grantable and the records are not — a private app is the only path.
 */
const PORTAL = "22493085";
const ENV_KEY = `HUBSPOT_PRIVATE_APP_TOKEN_${PORTAL}`;

describe("getValidToken — private-app override", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of [ENV_KEY, "HUBSPOT_PROVISIONER_URL", "HUBSPOT_PROVISIONER_API_SECRET"]) {
      saved[k] = process.env[k];
    }
    clearTokenCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    clearTokenCache();
    vi.unstubAllGlobals();
  });

  it("returns the override without calling the provisioner", async () => {
    process.env[ENV_KEY] = "pat-na1-override";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as any);

    await expect(getValidToken(PORTAL)).resolves.toBe("pat-na1-override");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a numeric portal id", async () => {
    process.env[ENV_KEY] = "pat-na1-override";
    vi.stubGlobal("fetch", vi.fn() as any);
    await expect(getValidToken(Number(PORTAL))).resolves.toBe("pat-na1-override");
  });

  it("trims surrounding whitespace", async () => {
    process.env[ENV_KEY] = "  pat-na1-override  ";
    vi.stubGlobal("fetch", vi.fn() as any);
    await expect(getValidToken(PORTAL)).resolves.toBe("pat-na1-override");
  });

  it("ignores a blank override and falls through to the provisioner", async () => {
    process.env[ENV_KEY] = "   ";
    process.env.HUBSPOT_PROVISIONER_URL = "https://prov.example";
    process.env.HUBSPOT_PROVISIONER_API_SECRET = "s3cret";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ accessToken: "oauth-token", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
    }));
    vi.stubGlobal("fetch", fetchMock as any);

    await expect(getValidToken(PORTAL)).resolves.toBe("oauth-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not leak across portals", async () => {
    process.env[ENV_KEY] = "pat-na1-override";
    process.env.HUBSPOT_PROVISIONER_URL = "https://prov.example";
    process.env.HUBSPOT_PROVISIONER_API_SECRET = "s3cret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ accessToken: "oauth-other", expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }),
      })) as any
    );
    // A different portal must still go through OAuth.
    await expect(getValidToken("99999999")).resolves.toBe("oauth-other");
  });
});
