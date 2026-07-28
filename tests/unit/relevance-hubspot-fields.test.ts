import { describe, it, expect } from "vitest";
import { parseSignal } from "../../src/relevance/signal";
import {
  extractSignalFields,
  buildSignalProperties,
  resolveFieldMap,
  toHubspotDateTime,
  DEFAULT_FIELD_MAP,
  DEFAULT_CREATE_ONLY_FIELDS,
} from "../../src/relevance/hubspot-fields";

const SYNCED = "2026-07-28T12:00:00.000Z";

const signal = (over: any = {}) =>
  parseSignal({
    bridge: {
      bridgeId: "b-1",
      name: "Hilight: Cabinet & Academic Leader",
      filterType: "Meeting",
      columns: [
        { name: "Status", key: "common:status" },
        { name: "Buyer Name", key: "buyer:name" },
        { name: "Buyer State Name", key: "buyer:stateName" },
        { name: "Added", key: "op:added_date" },
        { name: "Contact First", key: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:firstName" },
        { name: "Contact Email", key: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:emailAddress" },
        { name: "Contact Title", key: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:jobTitle" },
      ],
    },
    row: {
      rowId: "row-123",
      name: "East Brunswick Board of Education Meeting",
      createdAt: "2026-07-27T04:38:58.148935331Z",
      updatedAt: "2026-07-27T07:48:11.503117106Z",
      status: "Processed",
      buyerId: "buyer-9",
      entity: { type: "Meeting", id: "ent-1" },
      columns: {
        Status: { value: "New" },
        "Buyer Name": { value: "East Brunswick Public Schools" },
        "Buyer State Name": { value: "New Jersey" },
        Added: { value: "2026-07-27T04:38:58.148935331Z" },
        "Contact First": { value: "Steven" },
        "Contact Email": { value: "dmeek@wynneschools.org" },
        "Contact Title": { value: "Principal" },
        ...over,
      },
    },
  });

const fieldsOf = (over?: any) => {
  const r = signal(over);
  if (!r.ok) throw new Error("parse failed");
  return extractSignalFields(r.signal, SYNCED);
};

describe("toHubspotDateTime", () => {
  it("truncates Starbridge's nanosecond precision to milliseconds", () => {
    // HubSpot rejects nanoseconds outright.
    expect(toHubspotDateTime("2026-07-27T04:38:58.148935331Z")).toBe("2026-07-27T04:38:58.148Z");
  });

  it("pads short fractional seconds", () => {
    expect(toHubspotDateTime("2026-07-27T04:38:58.1Z")).toBe("2026-07-27T04:38:58.100Z");
  });

  it("supplies milliseconds when absent", () => {
    expect(toHubspotDateTime("2026-07-27T04:38:58Z")).toBe("2026-07-27T04:38:58.000Z");
  });

  it("passes a bare date through", () => {
    expect(toHubspotDateTime("2026-07-23")).toBe("2026-07-23");
  });

  it("returns null for blanks and junk", () => {
    expect(toHubspotDateTime("")).toBeNull();
    expect(toHubspotDateTime(null)).toBeNull();
    expect(toHubspotDateTime("not a date")).toBeNull();
  });
});

describe("extractSignalFields", () => {
  it("projects identity, dates, buyer and contact", () => {
    const f = fieldsOf();
    expect(f.signal_id).toBe("row-123");
    expect(f.name).toBe("East Brunswick Board of Education Meeting");
    expect(f.bridge_id).toBe("b-1");
    expect(f.bridge_name).toBe("Hilight: Cabinet & Academic Leader");
    expect(f.entity_id).toBe("ent-1");
    expect(f.entity_type).toBe("Meeting");
    expect(f.filter_type).toBe("Meeting");
    expect(f.buyer_id).toBe("buyer-9");
    expect(f.buyer_name).toBe("East Brunswick Public Schools");
    expect(f.buyer_state).toBe("New Jersey");
    expect(f.signal_status).toBe("New");
    expect(f.contact_first_name).toBe("Steven");
    expect(f.contact_email).toBe("dmeek@wynneschools.org");
    expect(f.contact_title).toBe("Principal");
  });

  it("coerces every date to a HubSpot-safe timestamp", () => {
    const f = fieldsOf();
    expect(f.created_at).toBe("2026-07-27T04:38:58.148Z");
    expect(f.updated_at).toBe("2026-07-27T07:48:11.503Z");
    expect(f.added_date).toBe("2026-07-27T04:38:58.148Z");
    expect(f.synced_at).toBe(SYNCED);
  });

  it("leaves absent fields null so they are never written as blank", () => {
    const f = fieldsOf();
    expect(f.contact_phone).toBeNull();
    expect(f.contact_last_name).toBeNull();
  });

  it("drops enum values outside the HubSpot options instead of 400ing the push", () => {
    const r = parseSignal({
      bridge: { bridgeId: "b", filterType: "SomethingNew", columns: [{ name: "S", key: "common:status" }] },
      row: {
        rowId: "r",
        name: "n",
        entity: { type: "Wormhole", id: "e" },
        columns: { S: { value: "Snoozed" } },
      },
    });
    if (!r.ok) throw new Error("parse failed");
    const f = extractSignalFields(r.signal, SYNCED);
    expect(f.filter_type).toBeNull();
    expect(f.entity_type).toBeNull();
    expect(f.signal_status).toBeNull();
  });

  it("falls back for name so a created record is never unnamed", () => {
    // hs_name is required on the Signal object.
    const r = parseSignal({
      bridge: { bridgeId: "b", filterType: "Buyer", columns: [] },
      row: { rowId: "row-xyz", entity: { type: "Buyer", id: "e" }, columns: {} },
    });
    if (!r.ok) throw new Error("parse failed");
    expect(extractSignalFields(r.signal, SYNCED).name).toBe("Starbridge signal row-xyz");
  });

  it("reads contact attributes out of web_contact when there is no direct column", () => {
    const r = parseSignal({
      bridge: {
        bridgeId: "b",
        filterType: "Signal",
        columns: [{ name: "Web Contact", key: "op_template:web_contact" }],
      },
      row: {
        rowId: "r",
        name: "n",
        entity: { type: "Signal", id: "e" },
        columns: {
          "Web Contact": { value: { firstName: "Cali", lastName: "Binks", jobTitle: "superintendent" } },
        },
      },
    });
    if (!r.ok) throw new Error("parse failed");
    const f = extractSignalFields(r.signal, SYNCED);
    expect(f.contact_first_name).toBe("Cali");
    expect(f.contact_last_name).toBe("Binks");
    expect(f.contact_title).toBe("superintendent");
  });
});

describe("buildSignalProperties", () => {
  const map = DEFAULT_FIELD_MAP;
  const createOnly = new Set(DEFAULT_CREATE_ONLY_FIELDS);

  it("maps canonical fields to the sb_* properties on create", () => {
    const p = buildSignalProperties(fieldsOf(), map, createOnly, true);
    expect(p.sb_signal_id).toBe("row-123");
    expect(p.hs_name).toBe("East Brunswick Board of Education Meeting");
    expect(p.sb_buyer_name).toBe("East Brunswick Public Schools");
    expect(p.sb_row_created_at).toBe("2026-07-27T04:38:58.148Z");
    expect(p.sb_contact_email).toBe("dmeek@wynneschools.org");
  });

  it("writes signal_status on CREATE", () => {
    expect(buildSignalProperties(fieldsOf(), map, createOnly, true).sb_signal_status).toBe("New");
  });

  it("SKIPS signal_status on UPDATE so a rep's Actioned is never reset", () => {
    // Starbridge reports "New" forever; HubSpot is where the status actually moves.
    const p = buildSignalProperties(fieldsOf(), map, createOnly, false);
    expect(p).not.toHaveProperty("sb_signal_status");
    // …but the rest of the spine still refreshes.
    expect(p.sb_buyer_name).toBe("East Brunswick Public Schools");
    expect(p.sb_row_updated_at).toBe("2026-07-27T07:48:11.503Z");
  });

  it("never emits a property for a null value", () => {
    const p = buildSignalProperties(fieldsOf(), map, createOnly, true);
    expect(p).not.toHaveProperty("sb_contact_phone");
    expect(Object.values(p).every((v) => v !== "" && v !== null)).toBe(true);
  });

  it("honors an unmapped field (field_map entry removed)", () => {
    const trimmed = resolveFieldMap({ contact_email: "" });
    const p = buildSignalProperties(fieldsOf(), trimmed, createOnly, true);
    expect(p).not.toHaveProperty("sb_contact_email");
    expect(p).toHaveProperty("sb_signal_id");
  });
});

describe("resolveFieldMap", () => {
  it("defaults to the sb_* property names", () => {
    expect(resolveFieldMap()).toEqual(DEFAULT_FIELD_MAP);
    expect(resolveFieldMap().signal_id).toBe("sb_signal_id");
  });

  it("applies an override without dropping the rest", () => {
    const m = resolveFieldMap({ buyer_id: "starbridge_buyer_id" });
    expect(m.buyer_id).toBe("starbridge_buyer_id");
    expect(m.signal_id).toBe("sb_signal_id");
  });

  it('treats "" as "stop writing this field"', () => {
    expect(resolveFieldMap({ synced_at: "" })).not.toHaveProperty("synced_at");
  });
});
