import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchClients, introspectToken } from "../../src/services/sdr-launch.service";

const ORIG_URL = process.env.SDR_LAUNCH_INTERNAL_URL;
const ORIG_SECRET = process.env.SDR_LAUNCH_INTERNAL_SECRET;

beforeEach(() => {
  process.env.SDR_LAUNCH_INTERNAL_URL = "https://gtmos.example";
  process.env.SDR_LAUNCH_INTERNAL_SECRET = "secret";
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.SDR_LAUNCH_INTERNAL_URL = ORIG_URL;
  process.env.SDR_LAUNCH_INTERNAL_SECRET = ORIG_SECRET;
});

describe("fetchClients", () => {
  it("sends the internal secret and returns the clients array", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ clients: [{ id: "1", slug: "acme", name: "Acme" }] }),
    })) as any;
    vi.stubGlobal("fetch", fetchMock);

    const clients = await fetchClients({ pbMembers: true, windowDays: 90 });
    expect(clients).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/internal/clients?pb_members=1&pb_window_days=90");
    expect(init.headers["X-Internal-Secret"]).toBe("secret");
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" })) as any);
    await expect(fetchClients()).rejects.toThrow(/HTTP 500/);
  });

  it("throws when not configured", async () => {
    delete process.env.SDR_LAUNCH_INTERNAL_URL;
    await expect(fetchClients()).rejects.toThrow(/must be set/);
  });
});

describe("introspectToken", () => {
  it("returns the introspection payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ valid: true, global: false, user: { id: "u1" }, clientSlugs: ["acme"] }),
      })) as any
    );
    const r = await introspectToken("sdr_live_x");
    expect(r.valid).toBe(true);
    expect(r.clientSlugs).toEqual(["acme"]);
  });

  it("throws on transport failure (not a silent invalid)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, text: async () => "down" })) as any);
    await expect(introspectToken("sdr_live_x")).rejects.toThrow(/HTTP 502/);
  });
});
