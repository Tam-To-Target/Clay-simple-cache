import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizePbContact,
  fetchMemberContacts,
  deletePbContact,
  PhoneburnerAccessError,
} from "../../src/services/phoneburner.service";

const getToken = async () => "member-token";

function jsonRes(status: number, body: any): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("normalizePbContact", () => {
  it("collects primary + array emails and phones (object and string shapes)", () => {
    const c = normalizePbContact({
      user_id: 555,
      primary_email: "a@corp.com",
      emails: [{ email_address: "a@corp.com" }, { email: "b@corp.com" }, "c@corp.com"],
      primary_phone: "(415) 555-1212",
      phones: [{ raw_phone: "415-555-1212" }, { phone_number: "212-000-0000" }],
      category: "Folder A",
      do_not_call: false,
    });
    expect(c.id).toBe("555");
    expect(c.emails).toContain("a@corp.com");
    expect(c.emails).toContain("b@corp.com");
    expect(c.emails).toContain("c@corp.com");
    expect(c.phones).toContain("(415) 555-1212");
    expect(c.phones).toContain("212-000-0000");
    expect(c.category).toBe("Folder A");
    expect(c.raw.user_id).toBe(555);
  });

  it("handles missing fields without throwing", () => {
    const c = normalizePbContact({ user_id: "1" });
    expect(c.id).toBe("1");
    expect(c.emails).toEqual([]);
    expect(c.phones).toEqual([]);
  });
});

describe("fetchMemberContacts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pages through all results", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(200, { contacts: { total_pages: 2, page: 1, contacts: [{ user_id: 1, primary_email: "x@a.com" }] } })
      )
      .mockResolvedValueOnce(
        jsonRes(200, { contacts: { total_pages: 2, page: 2, contacts: [{ user_id: 2, primary_email: "y@a.com" }] } })
      );
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchMemberContacts("m1", getToken);
    expect(out.map((c) => c.id)).toEqual(["1", "2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws PhoneburnerAccessError on 403 (API access off)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(403, "API Access not enabled")));
    await expect(fetchMemberContacts("m2", getToken)).rejects.toBeInstanceOf(PhoneburnerAccessError);
  });

  it("throws a generic error on other failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(400, "bad request")));
    await expect(fetchMemberContacts("m3", getToken)).rejects.toThrow(/HTTP 400/);
  });
});

describe("deletePbContact", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("treats 204 as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(204, "")));
    const r = await deletePbContact("99", getToken);
    expect(r.ok).toBe(true);
    expect(r.alreadyGone).toBe(false);
  });

  it("treats 404 as already-gone success (idempotent)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(404, "")));
    const r = await deletePbContact("99", getToken);
    expect(r.ok).toBe(true);
    expect(r.alreadyGone).toBe(true);
  });

  it("reports failure on 400", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonRes(400, "nope")));
    const r = await deletePbContact("99", getToken);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });
});
