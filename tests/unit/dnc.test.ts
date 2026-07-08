import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    dncEntry: {
      findMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    client: {
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn((ops: Promise<any>[]) => Promise.all(ops)),
  },
}));

import {
  normalizeEntry,
  normalizeCheckIdentifiers,
  dncService,
  NormalizedDncEntry,
} from "../../src/services/dnc.service";
import prisma from "../../src/db/prisma";

const mockPrisma = prisma as any;

describe("normalizeEntry", () => {
  it("normalizes email, phone, and domain", () => {
    const entry = normalizeEntry({
      email: "  John@Example.COM ",
      phone: "+1 (415) 555-2671",
      domain: "https://www.Example.com/",
      reason: "  unsubscribed ",
    });
    expect(entry).not.toBeNull();
    expect(entry!.email).toBe("john@example.com");
    expect(entry!.phone_e164).toBe("+14155552671");
    expect(entry!.domain).toBe("example.com");
    expect(entry!.reason).toBe("unsubscribed");
  });

  it("returns null when no usable identifier is present", () => {
    expect(normalizeEntry({ email: "", phone: "", domain: "" })).toBeNull();
    expect(normalizeEntry({ reason: "just a reason" })).toBeNull();
  });

  it("keeps an entry with only a phone", () => {
    const entry = normalizeEntry({ phone: "+14155552671" });
    expect(entry).not.toBeNull();
    expect(entry!.email).toBeNull();
    expect(entry!.phone_e164).toBe("+14155552671");
  });
});

describe("normalizeCheckIdentifiers", () => {
  it("derives the email domain for company-level matching", () => {
    const ids = normalizeCheckIdentifiers({ email: "Jane@Acme.com" });
    expect(ids.email).toBe("jane@acme.com");
    expect(ids.email_domain).toBe("acme.com");
  });

  it("normalizes an explicit domain and phone", () => {
    const ids = normalizeCheckIdentifiers({
      domain: "https://www.acme.com",
      phone: "+1 415 555 2671",
    });
    expect(ids.domain).toBe("acme.com");
    expect(ids.phone_e164).toBe("+14155552671");
  });
});

const entry = (over: Partial<NormalizedDncEntry> = {}): NormalizedDncEntry => ({
  email: null,
  phone_e164: null,
  domain: null,
  reason: null,
  data: {},
  ...over,
});

describe("dncService.diffSourceEntries", () => {
  const CLIENT_ID = "client-1";
  const SOURCE_ID = "source-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.dncEntry.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.dncEntry.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.client.update.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((ops: Promise<any>[]) => Promise.all(ops));
  });

  it("inserts new entries and deletes vanished ones, leaving unchanged rows untouched", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { id: "e-keep", email: "a@b.com", phone_e164: null, domain: null },
      { id: "e-gone", email: "gone@b.com", phone_e164: null, domain: null },
    ]);

    const result = await dncService.diffSourceEntries(CLIENT_ID, SOURCE_ID, "hubspot_list", [
      entry({ email: "a@b.com" }), // unchanged — same identity key as e-keep
      entry({ email: "new@b.com" }), // new
    ]);

    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.count).toBe(2);

    // The unchanged row's id is never passed to deleteMany, and no row for it
    // is (re)created — its created_at is left alone.
    expect(mockPrisma.dncEntry.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dncEntry.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["e-gone"] } },
    });

    expect(mockPrisma.dncEntry.createMany).toHaveBeenCalledTimes(1);
    const createCall = mockPrisma.dncEntry.createMany.mock.calls[0][0];
    expect(createCall.data).toHaveLength(1);
    expect(createCall.data[0]).toMatchObject({ email: "new@b.com", source_id: SOURCE_ID, client_id: CLIENT_ID });

    // Diff writes go through a transaction.
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("dedupes incoming entries by identity key, keeping the first", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([]);

    const result = await dncService.diffSourceEntries(CLIENT_ID, SOURCE_ID, "hubspot_list", [
      entry({ email: "dup@b.com", reason: "first" }),
      entry({ email: "dup@b.com", reason: "second" }),
    ]);

    expect(result.added).toBe(1);
    expect(result.count).toBe(1);
    const createCall = mockPrisma.dncEntry.createMany.mock.calls[0][0];
    expect(createCall.data).toHaveLength(1);
    expect(createCall.data[0].reason).toBe("first");
  });

  it("clears all existing entries when given an empty entry list", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { id: "e1", email: "a@b.com", phone_e164: null, domain: null },
      { id: "e2", email: "c@b.com", phone_e164: null, domain: null },
    ]);

    const result = await dncService.diffSourceEntries(CLIENT_ID, SOURCE_ID, "hubspot_list", []);

    expect(result.added).toBe(0);
    expect(result.removed).toBe(2);
    expect(result.count).toBe(0);
    expect(result.changed).toBe(true);
    expect(mockPrisma.dncEntry.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.dncEntry.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["e1", "e2"] } },
    });
  });

  it("bumps client.dnc_changed_at only when something actually changed", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { id: "e1", email: "a@b.com", phone_e164: null, domain: null },
    ]);

    const unchanged = await dncService.diffSourceEntries(CLIENT_ID, SOURCE_ID, "hubspot_list", [
      entry({ email: "a@b.com" }),
    ]);

    expect(unchanged.changed).toBe(false);
    expect(mockPrisma.client.update).not.toHaveBeenCalled();
    // No inserts or deletes needed ⇒ no transaction call either.
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();

    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { id: "e1", email: "a@b.com", phone_e164: null, domain: null },
    ]);
    const changed = await dncService.diffSourceEntries(CLIENT_ID, SOURCE_ID, "hubspot_list", [
      entry({ email: "a@b.com" }),
      entry({ email: "b@b.com" }),
    ]);

    expect(changed.changed).toBe(true);
    expect(mockPrisma.client.update).toHaveBeenCalledWith({
      where: { id: CLIENT_ID },
      data: { dnc_changed_at: expect.any(Date) },
    });
  });

  it("chunks deletes at 1000 ids per call", async () => {
    const existing = Array.from({ length: 1500 }, (_, i) => ({
      id: `e${i}`,
      email: `e${i}@b.com`,
      phone_e164: null,
      domain: null,
    }));
    mockPrisma.dncEntry.findMany.mockResolvedValue(existing);

    const result = await dncService.diffSourceEntries(CLIENT_ID, SOURCE_ID, "hubspot_list", []);

    expect(result.removed).toBe(1500);
    expect(mockPrisma.dncEntry.deleteMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.dncEntry.deleteMany.mock.calls[0][0].where.id.in).toHaveLength(1000);
    expect(mockPrisma.dncEntry.deleteMany.mock.calls[1][0].where.id.in).toHaveLength(500);
  });
});

describe("dncService.replaceSourceEntries", () => {
  const CLIENT_ID = "client-1";
  const SOURCE_ID = "source-1";

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.dncEntry.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.dncEntry.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.client.update.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((ops: Promise<any>[]) => Promise.all(ops));
  });

  it("keeps the same external contract (returns the resulting count) while diffing under the hood", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { id: "e1", email: "a@b.com", phone_e164: null, domain: null },
    ]);

    const count = await dncService.replaceSourceEntries(CLIENT_ID, SOURCE_ID, "hubspot_list", [
      entry({ email: "a@b.com" }),
      entry({ email: "new@b.com" }),
    ]);

    expect(count).toBe(2);
    // Unchanged row not deleted+recreated.
    expect(mockPrisma.dncEntry.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.dncEntry.createMany).toHaveBeenCalledTimes(1);
  });
});
