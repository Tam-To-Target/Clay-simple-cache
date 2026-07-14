import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Stub token resolution so the helpers don't hit the provisioner.
vi.mock("../../src/services/hubspot-token.service", () => {
  class HubspotAccessError extends Error {}
  return { getValidToken: vi.fn().mockResolvedValue("tok"), HubspotAccessError };
});

import {
  searchCompanyIdsByDomain,
  createObject,
  HubspotApiError,
} from "../../src/services/hubspot-contacts.service";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.clearAllMocks();
});

function mockFetch(status: number, json: any) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }) as any;
}

describe("searchCompanyIdsByDomain", () => {
  it("returns all matching company ids", async () => {
    mockFetch(200, { results: [{ id: "101" }, { id: "102" }] });
    const ids = await searchCompanyIdsByDomain("p1", "elks.net");
    expect(ids).toEqual(["101", "102"]);
  });

  it("returns [] when no match", async () => {
    mockFetch(200, { results: [] });
    expect(await searchCompanyIdsByDomain("p1", "nope.org")).toEqual([]);
  });

  it("throws HubspotApiError on a non-ok response", async () => {
    mockFetch(500, { message: "boom" });
    await expect(searchCompanyIdsByDomain("p1", "x.org")).rejects.toBeInstanceOf(HubspotApiError);
  });
});

describe("createObject", () => {
  it("returns the new object id", async () => {
    mockFetch(201, { id: "999" });
    expect(await createObject("p1", "companies", { name: "X" })).toBe("999");
  });

  it("throws HubspotApiError on failure", async () => {
    mockFetch(400, { message: "bad" });
    await expect(createObject("p1", "companies", {})).rejects.toBeInstanceOf(HubspotApiError);
  });
});
