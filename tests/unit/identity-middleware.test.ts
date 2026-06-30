import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/sdr-launch.service", () => ({
  introspectToken: vi.fn(),
}));

import { introspectToken } from "../../src/services/sdr-launch.service";
import { requireIdentity, canAccessSlug } from "../../src/middleware/identity.middleware";

const mIntrospect = vi.mocked(introspectToken);

function mockRes() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("canAccessSlug", () => {
  it("global identities can access any slug", () => {
    expect(canAccessSlug({ userId: "u", email: "", role: "admin", global: true, clientSlugs: [] }, "x")).toBe(true);
  });
  it("scoped identities only access granted slugs", () => {
    const id = { userId: "u", email: "", role: "user", global: false, clientSlugs: ["acme"] };
    expect(canAccessSlug(id, "acme")).toBe(true);
    expect(canAccessSlug(id, "other")).toBe(false);
  });
});

describe("requireIdentity", () => {
  it("401s when no X-User-Token is present", async () => {
    const req: any = { headers: {} };
    const res = mockRes();
    const next = vi.fn();
    await requireIdentity(req, res as any, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("401s when the token is invalid", async () => {
    mIntrospect.mockResolvedValue({ valid: false });
    const req: any = { headers: { "x-user-token": "bad" } };
    const res = mockRes();
    const next = vi.fn();
    await requireIdentity(req, res as any, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("attaches identity and calls next on a valid token", async () => {
    mIntrospect.mockResolvedValue({
      valid: true,
      global: false,
      user: { id: "u1", email: "a@b.com", role: "user", fullName: "A" },
      clientSlugs: ["acme"],
    });
    const req: any = { headers: { "x-user-token": "good" } };
    const res = mockRes();
    const next = vi.fn();
    await requireIdentity(req, res as any, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.identity).toMatchObject({ userId: "u1", clientSlugs: ["acme"], global: false });
  });

  it("502s when GTMOS introspection throws (does not pretend the token is bad)", async () => {
    mIntrospect.mockRejectedValue(new Error("gtmos down"));
    const req: any = { headers: { "x-user-token": "good" } };
    const res = mockRes();
    const next = vi.fn();
    await requireIdentity(req, res as any, next);
    expect(res.statusCode).toBe(502);
    expect(next).not.toHaveBeenCalled();
  });
});
