import { describe, it, expect } from "vitest";
import { parseSignal, buildEvidence, normalizeColumnKey } from "../../src/relevance/signal";

/**
 * Fixtures mirror REAL Starbridge `top-signals` responses (Hilight org,
 * 2026-07-28). The awkward parts are load-bearing — see each test.
 */

/** A Meeting signal: has confidenceScore + a keyless AiAnalysis column. */
const meetingSignal = () => ({
  bridge: {
    bridgeId: "e8df49ce-0cd2-4d82-ba1d-0fd2177fb9cc",
    name: "Hilight: Cabinet & Academic Leader",
    filterType: "Meeting",
    columns: [
      { name: "Status", key: "common:status", type: "Input" },
      { name: "Match Score", key: "confidenceScore", type: "DataAttribute" },
      { name: "Match reasoning", key: "confidenceReasoning", type: "DataAttribute" },
      { name: "Buyer Name", key: "buyer:name", type: "DataAttribute" },
      { name: "Buyer State Name", key: "buyer:stateName", type: "DataAttribute" },
      { name: "Posted Date", key: "op:posted_date", type: "DataAttribute" },
      // AiAnalysis columns carry NO key at all — only a display name.
      { name: "Relevancy Check?", type: "AiAnalysis" },
    ],
  },
  row: {
    rowId: "7d725d78-4073-4f2f-8bd4-26a5e7b3921f",
    name: "East Brunswick Board of Education Meeting",
    bridgeId: "e8df49ce-0cd2-4d82-ba1d-0fd2177fb9cc",
    createdAt: "2026-07-27T04:38:58.148935331Z",
    updatedAt: "2026-07-27T04:38:58.148935331Z",
    status: "Processed",
    buyerId: "ab09050a-43f9-4e6e-bfff-2ca7bb00053d",
    entity: { type: "Meeting", id: "488b4fff-a31e-49b2-9791-8a58187c75eb" },
    columns: {
      Status: { value: "New", status: "Processed" },
      "Match Score": { value: 5, status: "Processed" },
      "Match reasoning": { value: "Approved the 2026-2030 District Strategic Plan.", status: "Processed" },
      "Buyer Name": { value: "East Brunswick Public Schools", status: "Processed" },
      "Buyer State Name": { value: "New Jersey", status: "Processed" },
      "Posted Date": { value: "2026-07-23", status: "Processed" },
      "Relevancy Check?": { value: "Relevant", status: "Processed" },
    },
  },
});

/** A Buyer signal: NO buyer:name, NO added_date, NO confidenceScore, and
 *  contact columns keyed with a per-bridge UUID prefix. */
const buyerSignal = () => ({
  bridge: {
    bridgeId: "19948a36-fb95-4921-954e-1f073f12f1b1",
    name: "Core values: Lived Daily (Personas)",
    filterType: "Buyer",
    columns: [
      { name: "Status", key: "common:status", type: "Input" },
      { name: "Buyer State Name", key: "buyer:stateName", type: "DataAttribute" },
      { name: "Parent", key: "buyer:parentName", type: "DataAttribute" },
      { name: "Contact First Name", key: "5c9c9c39-4ad7-4e43-88c3-061bbdff855d:firstName" },
      { name: "Contact Email", key: "5c9c9c39-4ad7-4e43-88c3-061bbdff855d:emailAddress" },
      { name: "Selection basis", key: "5c9c9c39-4ad7-4e43-88c3-061bbdff855d$basis:reasoning" },
      { name: "Main Phone", key: "buyer:mainPhoneNumber", type: "DataAttribute" },
    ],
  },
  row: {
    rowId: "aaa11111-2222-3333-4444-555566667777",
    name: "Wynne High School",
    createdAt: "2026-07-25T01:43:11.067115388Z",
    updatedAt: "2026-07-25T01:43:11.067115388Z",
    status: "Processed",
    buyerId: "7cd3762d-69fb-476a-91f0-34e679039a38",
    entity: { type: "Buyer", id: "bbb22222-3333-4444-5555-666677778888" },
    columns: {
      Status: { value: "New" },
      "Buyer State Name": { value: "Arkansas" },
      Parent: { value: "Wynne School District 9" },
      "Contact First Name": { value: "Steven" },
      "Contact Email": { value: "dmeek@wynneschools.org" },
      "Selection basis": { value: "Selected after comprehensive web research." },
      // Observed at 0% fill on this bridge type — empty cells must be dropped.
      "Main Phone": { value: "" },
    },
  },
});

describe("normalizeColumnKey", () => {
  it("strips the per-bridge UUID prefix, keeping the stable suffix", () => {
    expect(normalizeColumnKey("5c9c9c39-4ad7-4e43-88c3-061bbdff855d:firstName")).toBe("firstName");
    expect(normalizeColumnKey("317982c1-d559-4924-9cc8-3b53f2669f57:emailAddress")).toBe("emailAddress");
  });

  it("collapses the $basis variant to a single stable key", () => {
    expect(normalizeColumnKey("5c9c9c39-4ad7-4e43-88c3-061bbdff855d$basis:reasoning")).toBe(
      "$basis:reasoning"
    );
  });

  it("leaves normal namespaced keys untouched", () => {
    expect(normalizeColumnKey("buyer:stateName")).toBe("buyer:stateName");
    expect(normalizeColumnKey("confidenceScore")).toBe("confidenceScore");
  });
});

describe("parseSignal — rejects unusable payloads", () => {
  it("rejects a non-object", () => {
    expect(parseSignal("nope")).toMatchObject({ ok: false });
  });

  it("requires row", () => {
    const r = parseSignal({ bridge: { columns: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/signal\.row is required/);
  });

  it("requires row.rowId — the signal's identity", () => {
    const r = parseSignal({ bridge: { columns: [] }, row: { name: "x" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/rowId/);
  });

  it("requires bridge — without it row.columns cannot be interpreted", () => {
    const r = parseSignal({ row: { rowId: "abc" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/bridge is required/);
  });
});

describe("parseSignal — Meeting signal", () => {
  it("lifts identity out of the columns", () => {
    const r = parseSignal(meetingSignal());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.signal;
    expect(s.signalId).toBe("7d725d78-4073-4f2f-8bd4-26a5e7b3921f");
    expect(s.filterType).toBe("Meeting");
    expect(s.entityType).toBe("Meeting");
    expect(s.buyerId).toBe("ab09050a-43f9-4e6e-bfff-2ca7bb00053d");
    expect(s.buyerName).toBe("East Brunswick Public Schools");
    expect(s.buyerState).toBe("New Jersey");
    expect(s.signalStatus).toBe("New");
  });

  it("does not duplicate identity into the data columns", () => {
    const r = parseSignal(meetingSignal());
    if (!r.ok) throw new Error("parse failed");
    expect(r.signal.columns).not.toHaveProperty("buyer:name");
    expect(r.signal.columns).not.toHaveProperty("buyer:stateName");
    expect(r.signal.columns).not.toHaveProperty("common:status");
    expect(r.signal.columns).toHaveProperty("confidenceScore", 5);
  });

  it("routes keyless AiAnalysis columns to aiColumns by display name", () => {
    const r = parseSignal(meetingSignal());
    if (!r.ok) throw new Error("parse failed");
    expect(r.signal.aiColumns).toEqual({ "Relevancy Check?": "Relevant" });
  });
});

describe("parseSignal — Buyer signal (the awkward type)", () => {
  it("falls back to row.name because Buyer bridges have no buyer:name", () => {
    const r = parseSignal(buyerSignal());
    if (!r.ok) throw new Error("parse failed");
    // Without the fallback the model would be handed an unnamed account.
    expect(r.signal.buyerName).toBe("Wynne High School");
  });

  it("normalizes UUID-prefixed contact columns", () => {
    const r = parseSignal(buyerSignal());
    if (!r.ok) throw new Error("parse failed");
    expect(r.signal.columns).toHaveProperty("firstName", "Steven");
    expect(r.signal.columns).toHaveProperty("emailAddress", "dmeek@wynneschools.org");
    expect(r.signal.columns).toHaveProperty("$basis:reasoning");
    // The raw prefixed key must not survive — it differs per bridge, so a prompt
    // could never reference it.
    expect(Object.keys(r.signal.columns).some((k) => k.includes("5c9c9c39"))).toBe(false);
  });

  it("drops empty cells so absent evidence is absent, not blank", () => {
    const r = parseSignal(buyerSignal());
    if (!r.ok) throw new Error("parse failed");
    expect(r.signal.columns).not.toHaveProperty("buyer:mainPhoneNumber");
  });
});

describe("buildEvidence", () => {
  it("includes identity, fields, and labels prior AI opinions separately", () => {
    const r = parseSignal(meetingSignal());
    if (!r.ok) throw new Error("parse failed");
    const e = buildEvidence(r.signal) as any;
    expect(e.signal_type).toBe("Meeting");
    expect(e.buyer).toEqual({ name: "East Brunswick Public Schools", state: "New Jersey" });
    expect(e.fields).toHaveProperty("confidenceReasoning");
    expect(e.prior_ai_columns).toEqual({ "Relevancy Check?": "Relevant" });
  });

  it("omits prior_ai_columns entirely when there are none", () => {
    const r = parseSignal(buyerSignal());
    if (!r.ok) throw new Error("parse failed");
    expect(buildEvidence(r.signal)).not.toHaveProperty("prior_ai_columns");
  });

  it("exclude_keys drops a field (e.g. Purchase's literal 'N/A' relevance)", () => {
    const r = parseSignal(meetingSignal());
    if (!r.ok) throw new Error("parse failed");
    const e = buildEvidence(r.signal, { exclude_keys: ["op:posted_date"] }) as any;
    expect(e.fields).not.toHaveProperty("op:posted_date");
    expect(e.fields).toHaveProperty("confidenceScore");
  });

  it("include_keys restricts to a whitelist", () => {
    const r = parseSignal(meetingSignal());
    if (!r.ok) throw new Error("parse failed");
    const e = buildEvidence(r.signal, { include_keys: ["confidenceReasoning"] }) as any;
    expect(Object.keys(e.fields)).toEqual(["confidenceReasoning"]);
  });

  it("include_keys wins when both are supplied", () => {
    const r = parseSignal(meetingSignal());
    if (!r.ok) throw new Error("parse failed");
    const e = buildEvidence(r.signal, {
      include_keys: ["confidenceScore"],
      exclude_keys: ["confidenceScore"],
    }) as any;
    expect(Object.keys(e.fields)).toEqual(["confidenceScore"]);
  });
});
