import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/sdr-launch.service", () => ({
  fetchPhoneburnerTokens: vi.fn(),
}));

import { fetchPhoneburnerTokens } from "../../src/services/sdr-launch.service";
import {
  getMemberToken,
  getMemberUsername,
  clearMemberTokenCache,
} from "../../src/services/phoneburner-token.service";

const mFetch = fetchPhoneburnerTokens as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearMemberTokenCache();
});

describe("getMemberToken (GTMOS-backed)", () => {
  it("resolves a member's own token from GTMOS and caches it (one pull for two reads)", async () => {
    mFetch.mockResolvedValue([
      { pbMemberId: "111", token: "tok-111", email: "a@x.com", status: "active" },
      { pbMemberId: "222", token: "tok-222", email: "b@x.com", status: "active" },
    ]);
    expect(await getMemberToken("111")).toBe("tok-111");
    expect(await getMemberToken(222)).toBe("tok-222"); // number coerced to string
    expect(getMemberUsername("111")).toBe("a@x.com");
    expect(mFetch).toHaveBeenCalledTimes(1); // cached after first pull
  });

  it("returns null for a member GTMOS has no token for", async () => {
    mFetch.mockResolvedValue([{ pbMemberId: "111", token: "tok-111", email: null, status: "active" }]);
    expect(await getMemberToken("999")).toBeNull();
  });

  it("re-pulls from GTMOS when forced (e.g. after a 401)", async () => {
    mFetch.mockResolvedValueOnce([{ pbMemberId: "111", token: "old", email: null, status: "active" }]);
    expect(await getMemberToken("111")).toBe("old");
    mFetch.mockResolvedValueOnce([{ pbMemberId: "111", token: "new", email: null, status: "active" }]);
    expect(await getMemberToken("111", { force: true })).toBe("new");
    expect(mFetch).toHaveBeenCalledTimes(2);
  });
});
