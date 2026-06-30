import { describe, it, expect } from "vitest";
import { publicContactData } from "../../src/services/contact-client.service";

describe("publicContactData", () => {
  it("strips cross-tenant provenance namespaces", () => {
    const out = publicContactData({
      jobtitle: "VP",
      industry: "edu",
      last_push: { client_id: "A", hubspot_portal_id: "111", hubspot_contact_id: "999" },
      last_dnc_check: { client_id: "A" },
    });
    expect(out).toEqual({ jobtitle: "VP", industry: "edu" });
    expect(out.last_push).toBeUndefined();
    expect(out.last_dnc_check).toBeUndefined();
  });

  it("handles null / non-object data safely", () => {
    expect(publicContactData(null)).toEqual({});
    expect(publicContactData(undefined)).toEqual({});
    expect(publicContactData("nope" as unknown)).toEqual({});
  });

  it("does not mutate the input", () => {
    const input = { a: 1, last_push: { x: 1 } };
    publicContactData(input);
    expect(input.last_push).toBeDefined();
  });
});
