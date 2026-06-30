import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/hubspot-contacts.service", () => {
  class HubspotApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return { upsertHubspotContact: vi.fn(), HubspotApiError };
});

import {
  upsertHubspotContact,
  HubspotApiError,
} from "../../src/services/hubspot-contacts.service";
import { contactToHubSpotProperties, hubSpotCrmAdapter } from "../../src/crm/hubspot.adapter";

const mUpsert = vi.mocked(upsertHubspotContact);

beforeEach(() => vi.clearAllMocks());

describe("contactToHubSpotProperties", () => {
  it("maps known fields and drops empties", () => {
    const p = contactToHubSpotProperties({ email: "a@b.com", firstName: "A", lastName: "", phone: null });
    expect(p).toEqual({ email: "a@b.com", firstname: "A" });
  });

  it("passes through and overrides via native properties", () => {
    const p = contactToHubSpotProperties({ email: "a@b.com", properties: { email: "x@b.com", custom: "1" } });
    expect(p.email).toBe("x@b.com");
    expect(p.custom).toBe("1");
  });

  it("preserves empty-string native properties (clear-by-empty PATCH) but drops null/undefined", () => {
    const p = contactToHubSpotProperties({
      email: "a@b.com",
      properties: { jobtitle: "", company: null as any, website: undefined as any },
    });
    expect(p.jobtitle).toBe(""); // intentional clear must reach HubSpot
    expect("company" in p).toBe(false);
    expect("website" in p).toBe(false);
  });
});

describe("hubSpotCrmAdapter.upsertContact", () => {
  it("rejects a contact with no email or phone (fatal)", async () => {
    const r = await hubSpotCrmAdapter.upsertContact({ firstName: "X" }, { accountId: "p1" });
    expect(r).toEqual({ ok: false, retryable: false, code: null, error: expect.any(String) });
    expect(mUpsert).not.toHaveBeenCalled();
  });

  it("maps a created result", async () => {
    mUpsert.mockResolvedValue({ created: true, id: "1", properties: {} });
    const r = await hubSpotCrmAdapter.upsertContact({ email: "a@b.com" }, { accountId: "p1" });
    expect(r).toEqual({ ok: true, action: "created", externalId: "1" });
  });

  it("maps an updated result", async () => {
    mUpsert.mockResolvedValue({ created: false, id: "2", properties: {} });
    const r = await hubSpotCrmAdapter.upsertContact({ email: "a@b.com" }, { accountId: "p1" });
    expect(r).toEqual({ ok: true, action: "updated", externalId: "2" });
  });

  it("classifies a 4xx HubspotApiError as fatal", async () => {
    mUpsert.mockRejectedValue(new HubspotApiError("bad property", 400));
    const r = await hubSpotCrmAdapter.upsertContact({ email: "a@b.com" }, { accountId: "p1" });
    expect(r).toMatchObject({ ok: false, retryable: false, code: 400 });
  });

  it("classifies a 5xx/429 HubspotApiError as retryable", async () => {
    mUpsert.mockRejectedValue(new HubspotApiError("rate limited", 429));
    const r = await hubSpotCrmAdapter.upsertContact({ email: "a@b.com" }, { accountId: "p1" });
    expect(r).toMatchObject({ ok: false, retryable: true, code: 429 });
  });
});
