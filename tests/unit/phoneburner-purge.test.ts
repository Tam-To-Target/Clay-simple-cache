import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Real PhoneburnerAccessError class so `instanceof` works in the service.
vi.mock("../../src/services/phoneburner.service", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    fetchMemberContacts: vi.fn(),
    deletePbContact: vi.fn(),
    fetchPbContact: vi.fn(),
  };
});

vi.mock("../../src/services/phoneburner-token.service", () => ({
  getMemberToken: vi.fn(),
  getMemberUsername: vi.fn().mockReturnValue(null),
  phoneburnerApiBase: () => "https://pb.test/rest/1",
}));

vi.mock("../../src/db/prisma", () => ({
  default: {
    dncEntry: { findMany: vi.fn() },
    phoneburnerMember: { update: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
    phoneburnerContactIndex: {
      deleteMany: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    phoneburnerDeletion: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
    phoneburnerPurgeRun: { create: vi.fn(), update: vi.fn() },
    client: { findMany: vi.fn() },
  },
}));

import {
  collide,
  loadDncSets,
  purgeMember,
  targetedPurgeMember,
  purgeClient,
  needsFullScan,
  purgeOptionsFromEnv,
  DncSets,
  PurgeContext,
} from "../../src/services/phoneburner-purge.service";
import {
  fetchMemberContacts,
  deletePbContact,
  fetchPbContact,
  PhoneburnerAccessError,
} from "../../src/services/phoneburner.service";
import { getMemberToken } from "../../src/services/phoneburner-token.service";
import prisma from "../../src/db/prisma";

const mockPrisma = prisma as any;
const fetchMock = fetchMemberContacts as any;
const deleteMock = deletePbContact as any;
const fetchPbContactMock = fetchPbContact as any;
const tokenMock = getMemberToken as any;

const sets = (e: string[], p: string[], d: string[]): DncSets => ({
  emails: new Set(e),
  phones: new Set(p),
  domains: new Set(d),
});

const contact = (over: Partial<any> = {}) => ({
  id: "c1",
  emails: [],
  phones: [],
  category: null,
  do_not_call: false,
  raw: {},
  ...over,
});

const CLIENT = { id: "client-uuid", external_id: "cust" } as any;
const MEMBER = { id: "m-row", pb_member_id: "pb1", pb_username: "sdr@x.com", active: true } as any;
const OPTS = purgeOptionsFromEnv({ dryRun: true, maxRatio: 0.4, includeDomains: true, maxDeletesPerRun: null });

/** Minimal PurgeContext for targetedPurgeMember/purgeClient tests — bypasses
 * prisma entirely (sets are supplied directly) except for the calls the
 * function under test makes itself (dncEntry/phoneburnerContactIndex). */
function makeCtx(setsByClient: Record<string, DncSets>, serving: Record<string, string[]> = {}): PurgeContext {
  return {
    getSets: async (cid: string) => setsByClient[cid] ?? sets([], [], []),
    servingClientIds: (pid: string) => serving[pid] ?? [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.phoneburnerMember.update.mockResolvedValue({});
  mockPrisma.phoneburnerDeletion.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.phoneburnerDeletion.update.mockResolvedValue({});
  mockPrisma.phoneburnerContactIndex.deleteMany.mockResolvedValue({});
  mockPrisma.phoneburnerContactIndex.createMany.mockResolvedValue({});
  mockPrisma.phoneburnerContactIndex.findMany.mockResolvedValue([]);
  mockPrisma.phoneburnerContactIndex.count.mockResolvedValue(0);
});

describe("collide", () => {
  const s = sets(["a@corp.com"], ["+14155551212"], ["corp.com"]);

  it("matches on exact email", () => {
    expect(collide(contact({ emails: ["A@Corp.com"] }), s, true)).toEqual({ matched_on: "email", matched_value: "a@corp.com" });
  });

  it("matches on phone after E.164 normalization", () => {
    expect(collide(contact({ phones: ["(415) 555-1212"] }), s, true)?.matched_on).toBe("phone");
  });

  it("matches on corporate email domain when enabled", () => {
    expect(collide(contact({ emails: ["someone@corp.com"] }), sets([], [], ["corp.com"]), true)).toEqual({
      matched_on: "domain",
      matched_value: "corp.com",
    });
  });

  it("does NOT match a free-provider domain", () => {
    expect(collide(contact({ emails: ["x@gmail.com"] }), sets([], [], ["gmail.com"]), true)).toBeNull();
  });

  it("skips domain matching when includeDomains is false", () => {
    expect(collide(contact({ emails: ["someone@corp.com"] }), sets([], [], ["corp.com"]), false)).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(collide(contact({ emails: ["no@one.com"], phones: ["+10000000000"] }), s, true)).toBeNull();
  });
});

describe("loadDncSets", () => {
  it("builds email/phone/domain sets from dnc_entries", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "a@b.com", phone_e164: null, domain: null },
      { email: null, phone_e164: "+1222", domain: null },
      { email: null, phone_e164: null, domain: "b.com" },
    ]);
    const out = await loadDncSets("client-uuid");
    expect([...out.emails]).toEqual(["a@b.com"]);
    expect([...out.phones]).toEqual(["+1222"]);
    expect([...out.domains]).toEqual(["b.com"]);
  });
});

describe("purgeOptionsFromEnv", () => {
  it("defaults to dry-run unless explicitly disabled", () => {
    delete process.env.PB_PURGE_DRY_RUN;
    expect(purgeOptionsFromEnv().dryRun).toBe(true);
    process.env.PB_PURGE_DRY_RUN = "false";
    expect(purgeOptionsFromEnv().dryRun).toBe(false);
    delete process.env.PB_PURGE_DRY_RUN;
  });

  it("clamps maxRatio to the 0.30 hard ceiling — config can only tighten, never loosen", () => {
    delete process.env.PB_PURGE_MAX_RATIO;
    expect(purgeOptionsFromEnv().maxRatio).toBe(0.3); // default = ceiling
    expect(purgeOptionsFromEnv({ maxRatio: 0.9 }).maxRatio).toBe(0.3); // override can't loosen
    expect(purgeOptionsFromEnv({ maxRatio: 0.1 }).maxRatio).toBe(0.1); // override can tighten
    process.env.PB_PURGE_MAX_RATIO = "0.8";
    expect(purgeOptionsFromEnv().maxRatio).toBe(0.3); // env can't loosen
    process.env.PB_PURGE_MAX_RATIO = "0.15";
    expect(purgeOptionsFromEnv().maxRatio).toBe(0.15); // env can tighten
    delete process.env.PB_PURGE_MAX_RATIO;
  });
});

const counters = () => ({ deletedThisRun: 0 });

describe("purgeMember", () => {
  // Single-client member: guardSets is just [sets].
  const solo = (s: DncSets) => [s];

  it("skips when the member has no resolvable token", async () => {
    tokenMock.mockResolvedValue(null);
    const s = sets(["a@b.com"], [], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), OPTS, "run1", counters());
    expect(r.status).toBe("skipped_no_token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips when API access is disabled (403)", async () => {
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockRejectedValue(new PhoneburnerAccessError("pb1", "API access disabled"));
    const s = sets(["a@b.com"], [], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), OPTS, "run1", counters());
    expect(r.status).toBe("skipped_no_access");
  });

  it("dry-run: writes dry_run audit rows and does NOT delete", async () => {
    tokenMock.mockResolvedValue("tok");
    // 1 collision in 4 contacts → ratio 0.25, under the 0.30 gate.
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["a@b.com"] }),
      contact({ id: "c2", emails: ["safe@x.com"] }),
      contact({ id: "c3", emails: ["safe2@x.com"] }),
      contact({ id: "c4", emails: ["safe3@x.com"] }),
    ]);
    const s = sets(["a@b.com"], [], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), OPTS, "run1", counters());
    expect(r.status).toBe("ok");
    expect(r.contacts_scanned).toBe(4);
    expect(r.collisions).toBe(1);
    expect(r.deleted).toBe(1); // "would delete"
    expect(deleteMock).not.toHaveBeenCalled();
    expect(mockPrisma.phoneburnerDeletion.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.phoneburnerDeletion.create.mock.calls[0][0].data.status).toBe("dry_run");
  });

  it("live: backs up then deletes the colliding contact", async () => {
    const liveOpts = { ...OPTS, dryRun: false };
    tokenMock.mockResolvedValue("tok");
    // 1 collision in 4 → 0.25, under the 0.30 gate.
    fetchMock.mockResolvedValue([
      contact({ id: "c1", phones: ["(415) 555-1212"] }),
      contact({ id: "c2", phones: ["+19998887777"] }),
      contact({ id: "c3", emails: ["safe@x.com"] }),
      contact({ id: "c4", emails: ["safe2@x.com"] }),
    ]);
    deleteMock.mockResolvedValue({ ok: true, status: 204, alreadyGone: false });
    const c = counters();
    const s = sets([], ["+14155551212"], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), liveOpts, "run1", c);
    expect(r.deleted).toBe(1);
    expect(deleteMock).toHaveBeenCalledWith("c1", expect.any(Function), expect.objectContaining({ throttle: expect.any(Function) }));
    expect(mockPrisma.phoneburnerDeletion.create.mock.calls[0][0].data.status).toBe("pending");
    expect(mockPrisma.phoneburnerDeletion.update.mock.calls[0][0].data.status).toBe("deleted");
    expect(c.deletedThisRun).toBe(1);
  });

  it("aborts a member when collisions exceed the ratio gate", async () => {
    const liveOpts = { ...OPTS, dryRun: false, maxRatio: 0.4 };
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["a@b.com"] }),
      contact({ id: "c2", emails: ["a@b.com"] }),
    ]);
    const s = sets(["a@b.com"], [], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), liveOpts, "run1", counters());
    expect(r.status).toBe("aborted_ratio");
    expect(deleteMock).not.toHaveBeenCalled();
    expect(mockPrisma.phoneburnerDeletion.create).not.toHaveBeenCalled();
  });

  it("records a failed delete without throwing", async () => {
    const liveOpts = { ...OPTS, dryRun: false };
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["a@b.com"] }),
      contact({ id: "c2", emails: ["safe@x.com"] }),
      contact({ id: "c3", emails: ["safe2@x.com"] }),
      contact({ id: "c4", emails: ["safe3@x.com"] }),
    ]);
    deleteMock.mockResolvedValue({ ok: false, status: 500, alreadyGone: false });
    const s = sets(["a@b.com"], [], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), liveOpts, "run1", counters());
    expect(r.deleted).toBe(0);
    expect(r.failed).toBe(1);
    expect(mockPrisma.phoneburnerDeletion.update.mock.calls[0][0].data.status).toBe("failed");
  });

  it("multi-client shared book: does NOT delete a contact another client still wants", async () => {
    const liveOpts = { ...OPTS, dryRun: false };
    tokenMock.mockResolvedValue("tok");
    // c1 is on client A's DNC but NOT on client B's; member dials for both.
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["dnc-for-a@b.com"] }),
      contact({ id: "c2", emails: ["safe@x.com"] }),
      contact({ id: "c3", emails: ["safe2@x.com"] }),
    ]);
    const clientA = sets(["dnc-for-a@b.com"], [], []);
    const clientB = sets(["someone-else@b.com"], [], []); // does not suppress c1
    const r = await purgeMember(CLIENT, MEMBER, clientA, [clientA, clientB], liveOpts, "run1", counters());
    expect(r.collisions).toBe(0);
    expect(r.protected_other_client).toBe(1);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("multi-client shared book: DELETES a contact suppressed by all serving clients", async () => {
    const liveOpts = { ...OPTS, dryRun: false };
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["dnc-everywhere@b.com"] }),
      contact({ id: "c2", emails: ["safe@x.com"] }),
      contact({ id: "c3", emails: ["safe2@x.com"] }),
      contact({ id: "c4", emails: ["safe3@x.com"] }),
    ]);
    deleteMock.mockResolvedValue({ ok: true, status: 204, alreadyGone: false });
    const clientA = sets(["dnc-everywhere@b.com"], [], []);
    const clientB = sets(["dnc-everywhere@b.com"], [], []); // both suppress c1
    const r = await purgeMember(CLIENT, MEMBER, clientA, [clientA, clientB], liveOpts, "run1", counters());
    expect(r.collisions).toBe(1);
    expect(r.deleted).toBe(1);
  });

  // ── Identity index + watermark (Agent D) ──────────────────────────────────

  it("rebuilds the identity index after a successful scan (one row per identifier, deduped, corp domains only)", async () => {
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["A@Corp.com", "a@corp.com"], phones: ["(415) 555-1212"] }), // dup email
      contact({ id: "c2", emails: ["safe@gmail.com"] }), // free provider -> no domain row
      contact({ id: "c3", emails: [], phones: [] }), // no identifiers -> skipped entirely
    ]);
    const s = sets([], [], []);
    await purgeMember(CLIENT, MEMBER, s, solo(s), OPTS, "run1", counters());

    expect(mockPrisma.phoneburnerContactIndex.deleteMany).toHaveBeenCalledWith({ where: { pb_member_id: "pb1" } });
    expect(mockPrisma.phoneburnerContactIndex.createMany).toHaveBeenCalledTimes(1);
    const rows: any[] = mockPrisma.phoneburnerContactIndex.createMany.mock.calls[0][0].data;

    // c1: one email row (deduped), one phone row, one domain row.
    expect(rows.filter((r) => r.pb_contact_id === "c1")).toHaveLength(3);
    expect(rows).toContainEqual({ pb_member_id: "pb1", pb_contact_id: "c1", email: "a@corp.com", phone_e164: null, domain: null });
    expect(rows).toContainEqual({ pb_member_id: "pb1", pb_contact_id: "c1", email: null, phone_e164: "+14155551212", domain: null });
    expect(rows).toContainEqual({ pb_member_id: "pb1", pb_contact_id: "c1", email: null, phone_e164: null, domain: "corp.com" });

    // c2: email row only, no domain row (gmail.com is a free provider).
    expect(rows.filter((r) => r.pb_contact_id === "c2")).toHaveLength(1);
    expect(rows).toContainEqual({ pb_member_id: "pb1", pb_contact_id: "c2", email: "safe@gmail.com", phone_e164: null, domain: null });

    // c3: no identifiers at all -> not indexed.
    expect(rows.some((r) => r.pb_contact_id === "c3")).toBe(false);
  });

  it("dry-run: sets last_full_scan_at but does NOT advance dnc_processed_through", async () => {
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([contact({ id: "c1", emails: ["a@b.com"] })]);
    const s = sets(["a@b.com"], [], []);
    await purgeMember(CLIENT, MEMBER, s, solo(s), OPTS, "run1", counters()); // OPTS.dryRun === true
    const data = mockPrisma.phoneburnerMember.update.mock.calls[0][0].data;
    expect(data.last_full_scan_at).toBeInstanceOf(Date);
    expect(data.dnc_processed_through).toBeUndefined();
  });

  it("live clean completion: advances both last_full_scan_at and dnc_processed_through", async () => {
    const liveOpts = { ...OPTS, dryRun: false };
    tokenMock.mockResolvedValue("tok");
    // 1 collision in 4 contacts → ratio 0.25, under the 0.4 gate.
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["a@b.com"] }),
      contact({ id: "c2", emails: ["safe@x.com"] }),
      contact({ id: "c3", emails: ["safe2@x.com"] }),
      contact({ id: "c4", emails: ["safe3@x.com"] }),
    ]);
    deleteMock.mockResolvedValue({ ok: true, status: 204, alreadyGone: false });
    const s = sets(["a@b.com"], [], []);
    await purgeMember(CLIENT, MEMBER, s, solo(s), liveOpts, "run1", counters());
    const data = mockPrisma.phoneburnerMember.update.mock.calls[0][0].data;
    expect(data.last_full_scan_at).toBeInstanceOf(Date);
    expect(data.dnc_processed_through).toBeInstanceOf(Date);
  });

  it("failed delete: does NOT advance dnc_processed_through (failure must self-retry next run)", async () => {
    const liveOpts = { ...OPTS, dryRun: false };
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["a@b.com"] }),
      contact({ id: "c2", emails: ["safe@x.com"] }),
      contact({ id: "c3", emails: ["safe2@x.com"] }),
      contact({ id: "c4", emails: ["safe3@x.com"] }),
    ]);
    deleteMock.mockResolvedValue({ ok: false, status: 500, alreadyGone: false });
    const s = sets(["a@b.com"], [], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), liveOpts, "run1", counters());
    expect(r.status).toBe("ok");
    expect(r.failed).toBe(1);
    const data = mockPrisma.phoneburnerMember.update.mock.calls[0][0].data;
    expect(data.last_full_scan_at).toBeInstanceOf(Date);
    expect(data.dnc_processed_through).toBeUndefined();
  });

  it("aborted_ratio: still rebuilds the index and sets last_full_scan_at, but does NOT advance dnc_processed_through", async () => {
    const liveOpts = { ...OPTS, dryRun: false, maxRatio: 0.4 };
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["a@b.com"] }),
      contact({ id: "c2", emails: ["a@b.com"] }),
    ]);
    const s = sets(["a@b.com"], [], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), liveOpts, "run1", counters());
    expect(r.status).toBe("aborted_ratio");
    expect(mockPrisma.phoneburnerContactIndex.deleteMany).toHaveBeenCalled();
    expect(mockPrisma.phoneburnerContactIndex.createMany).toHaveBeenCalled();
    const data = mockPrisma.phoneburnerMember.update.mock.calls[0][0].data;
    expect(data.last_full_scan_at).toBeInstanceOf(Date);
    expect(data.dnc_processed_through).toBeUndefined();
  });

  it("capped: does NOT advance dnc_processed_through", async () => {
    const liveOpts = { ...OPTS, dryRun: false, maxDeletesPerRun: 0 };
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([
      contact({ id: "c1", emails: ["a@b.com"] }),
      contact({ id: "c2", emails: ["safe@x.com"] }),
      contact({ id: "c3", emails: ["safe2@x.com"] }),
      contact({ id: "c4", emails: ["safe3@x.com"] }),
    ]);
    const s = sets(["a@b.com"], [], []);
    const r = await purgeMember(CLIENT, MEMBER, s, solo(s), liveOpts, "run1", counters());
    expect(r.status).toBe("capped");
    const data = mockPrisma.phoneburnerMember.update.mock.calls[0][0].data;
    expect(data.last_full_scan_at).toBeInstanceOf(Date);
    expect(data.dnc_processed_through).toBeUndefined();
  });
});

describe("needsFullScan", () => {
  afterEach(() => {
    delete process.env.PB_FULL_SCAN_MAX_AGE_HOURS;
  });

  it("true when the member has never been scanned", () => {
    expect(needsFullScan({ ...MEMBER, last_full_scan_at: null } as any)).toBe(true);
  });

  it("false when scanned recently (within the default 168h)", () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    expect(needsFullScan({ ...MEMBER, last_full_scan_at: recent } as any)).toBe(false);
  });

  it("true when the last scan is older than the default max age", () => {
    const old = new Date(Date.now() - 200 * 60 * 60 * 1000); // ~8.3 days ago
    expect(needsFullScan({ ...MEMBER, last_full_scan_at: old } as any)).toBe(true);
  });

  it("respects PB_FULL_SCAN_MAX_AGE_HOURS at call time", () => {
    process.env.PB_FULL_SCAN_MAX_AGE_HOURS = "1";
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(needsFullScan({ ...MEMBER, last_full_scan_at: twoHoursAgo } as any)).toBe(true);
  });
});

describe("targetedPurgeMember", () => {
  const memberWithWatermark = (wm: Date | null) =>
    ({ ...MEMBER, dnc_processed_through: wm, last_full_scan_at: new Date(), api_access_ok: true } as any);

  // Index findMany is called for three different purposes in sequence: the
  // distinct-contact-count query (`args.distinct`), the per-identifier
  // candidate lookup (`args.where.email` / `.phone_e164` / `.domain`), and the
  // full-profile reload for the candidate ids (`args.where.pb_contact_id`).
  function mockIndex(opts: { indexedContactIds?: string[]; emailHits?: string[]; profiles?: any[] }) {
    mockPrisma.phoneburnerContactIndex.findMany.mockImplementation(async (args: any) => {
      if (args.distinct) return (opts.indexedContactIds ?? []).map((id) => ({ pb_contact_id: id }));
      if (args.where?.email) return (opts.emailHits ?? []).map((id) => ({ pb_contact_id: id }));
      if (args.where?.pb_contact_id) return opts.profiles ?? [];
      return [];
    });
  }

  it("no new entries since the watermark: skips, zero API calls, advances the watermark to now", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([]);
    const ctx = makeCtx({ [CLIENT.id]: sets(["a@b.com"], [], []) });
    const m = memberWithWatermark(new Date("2026-01-01"));
    const r = await targetedPurgeMember(CLIENT, m, OPTS, "run1", counters(), ctx);
    expect(r.status).toBe("skipped_no_new_dnc");
    expect(r.mode).toBe("targeted");
    expect(fetchPbContactMock).not.toHaveBeenCalled();
    expect(mockPrisma.phoneburnerContactIndex.findMany).not.toHaveBeenCalled();
    const data = mockPrisma.phoneburnerMember.update.mock.calls[0][0].data;
    expect(data.dnc_processed_through).toBeInstanceOf(Date);
  });

  it("no index rows for this member: skipped_no_index (caller must fall back to a full scan)", async () => {
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "new@b.com", phone_e164: null, domain: null, created_at: new Date() },
    ]);
    mockIndex({ indexedContactIds: [] });
    const ctx = makeCtx({ [CLIENT.id]: sets(["new@b.com"], [], []) });
    const m = memberWithWatermark(new Date("2026-01-01"));
    const r = await targetedPurgeMember(CLIENT, m, OPTS, "run1", counters(), ctx);
    expect(r.status).toBe("skipped_no_index");
    expect(fetchPbContactMock).not.toHaveBeenCalled();
  });

  it("index hit -> live fetch -> guard passes -> deletes and cleans up the index row; advances watermark", async () => {
    const liveOpts = { ...OPTS, dryRun: false, maxRatio: 0.4 };
    const createdAt = new Date("2026-07-01T00:00:00Z");
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "new@b.com", phone_e164: null, domain: null, created_at: createdAt },
    ]);
    mockIndex({
      indexedContactIds: ["x1", "x2", "x3", "x4", "x5"], // book of 5 -> ratio 1/5 = 0.2, under 0.4
      emailHits: ["c1"],
      profiles: [{ pb_contact_id: "c1", email: "new@b.com", phone_e164: null, domain: null }],
    });
    tokenMock.mockResolvedValue("tok");
    fetchPbContactMock.mockResolvedValue(contact({ id: "c1", emails: ["new@b.com"] }));
    deleteMock.mockResolvedValue({ ok: true, status: 204, alreadyGone: false });

    const ctx = makeCtx({ [CLIENT.id]: sets(["new@b.com"], [], []) });
    const m = memberWithWatermark(new Date("2026-01-01"));
    const c = counters();
    const r = await targetedPurgeMember(CLIENT, m, liveOpts, "run1", c, ctx);

    expect(r.status).toBe("ok");
    expect(r.mode).toBe("targeted");
    expect(r.collisions).toBe(1);
    expect(r.deleted).toBe(1);
    expect(fetchPbContactMock).toHaveBeenCalledWith("c1", expect.any(Function), expect.objectContaining({ throttle: expect.any(Function) }));
    expect(deleteMock).toHaveBeenCalledWith("c1", expect.any(Function), expect.any(Object));
    expect(mockPrisma.phoneburnerDeletion.create.mock.calls[0][0].data.status).toBe("pending");
    expect(mockPrisma.phoneburnerContactIndex.deleteMany).toHaveBeenCalledWith({ where: { pb_member_id: "pb1", pb_contact_id: "c1" } });
    expect(c.deletedThisRun).toBe(1);
    const data = mockPrisma.phoneburnerMember.update.mock.calls.at(-1)[0].data;
    expect(data.dnc_processed_through).toEqual(createdAt);
  });

  it("dry-run: writes a dry_run audit row, does NOT delete or touch the index, and does NOT advance the watermark", async () => {
    const dryOpts = { ...OPTS, dryRun: true, maxRatio: 0.4 };
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "new@b.com", phone_e164: null, domain: null, created_at: new Date("2026-07-01T00:00:00Z") },
    ]);
    mockIndex({
      indexedContactIds: ["x1", "x2", "x3", "x4", "x5"],
      emailHits: ["c1"],
      profiles: [{ pb_contact_id: "c1", email: "new@b.com", phone_e164: null, domain: null }],
    });
    tokenMock.mockResolvedValue("tok");
    fetchPbContactMock.mockResolvedValue(contact({ id: "c1", emails: ["new@b.com"] }));

    const ctx = makeCtx({ [CLIENT.id]: sets(["new@b.com"], [], []) });
    const m = memberWithWatermark(new Date("2026-01-01"));
    const r = await targetedPurgeMember(CLIENT, m, dryOpts, "run1", counters(), ctx);

    expect(r.deleted).toBe(1); // "would delete"
    expect(deleteMock).not.toHaveBeenCalled();
    expect(mockPrisma.phoneburnerDeletion.create.mock.calls[0][0].data.status).toBe("dry_run");
    expect(mockPrisma.phoneburnerContactIndex.deleteMany).not.toHaveBeenCalledWith({ where: { pb_member_id: "pb1", pb_contact_id: "c1" } });
    const data = mockPrisma.phoneburnerMember.update.mock.calls.at(-1)[0].data;
    expect(data.dnc_processed_through).toBeUndefined();
  });

  it("live fetch 404 (already gone): cleans the stale index row, not counted as a delete or failure; watermark still advances", async () => {
    const liveOpts = { ...OPTS, dryRun: false, maxRatio: 0.4 };
    const createdAt = new Date("2026-07-01T00:00:00Z");
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "new@b.com", phone_e164: null, domain: null, created_at: createdAt },
    ]);
    mockIndex({
      indexedContactIds: ["x1", "x2", "x3", "x4", "x5"],
      emailHits: ["c1"],
      profiles: [{ pb_contact_id: "c1", email: "new@b.com", phone_e164: null, domain: null }],
    });
    tokenMock.mockResolvedValue("tok");
    fetchPbContactMock.mockResolvedValue(null);

    const ctx = makeCtx({ [CLIENT.id]: sets(["new@b.com"], [], []) });
    const m = memberWithWatermark(new Date("2026-01-01"));
    const r = await targetedPurgeMember(CLIENT, m, liveOpts, "run1", counters(), ctx);

    expect(r.status).toBe("ok");
    expect(r.deleted).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.stale_index).toBe(1);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(mockPrisma.phoneburnerContactIndex.deleteMany).toHaveBeenCalledWith({ where: { pb_member_id: "pb1", pb_contact_id: "c1" } });
    const data = mockPrisma.phoneburnerMember.update.mock.calls.at(-1)[0].data;
    expect(data.dnc_processed_through).toEqual(createdAt);
  });

  it("live record no longer collides with the client's DNC: skips deletion and refreshes the index from the live record", async () => {
    const liveOpts = { ...OPTS, dryRun: false, maxRatio: 0.4 };
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "new@b.com", phone_e164: null, domain: null, created_at: new Date("2026-07-01T00:00:00Z") },
    ]);
    mockIndex({
      indexedContactIds: ["x1", "x2", "x3", "x4", "x5"],
      emailHits: ["c1"],
      profiles: [{ pb_contact_id: "c1", email: "new@b.com", phone_e164: null, domain: null }],
    });
    tokenMock.mockResolvedValue("tok");
    fetchPbContactMock.mockResolvedValue(contact({ id: "c1", emails: ["different@nomatch.com"] }));

    const ctx = makeCtx({ [CLIENT.id]: sets(["new@b.com"], [], []) });
    const m = memberWithWatermark(new Date("2026-01-01"));
    const r = await targetedPurgeMember(CLIENT, m, liveOpts, "run1", counters(), ctx);

    expect(r.status).toBe("ok");
    expect(r.deleted).toBe(0);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(mockPrisma.phoneburnerDeletion.create).not.toHaveBeenCalled();
    expect(mockPrisma.phoneburnerContactIndex.deleteMany).toHaveBeenCalledWith({ where: { pb_member_id: "pb1", pb_contact_id: "c1" } });
    expect(mockPrisma.phoneburnerContactIndex.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([expect.objectContaining({ pb_contact_id: "c1", email: "different@nomatch.com" })]),
    });
  });

  it("ratio gate: candidates-after-guard vs. total indexed contact count aborts with no deletes and no watermark advance", async () => {
    const liveOpts = { ...OPTS, dryRun: false, maxRatio: 0.4 };
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "new@b.com", phone_e164: null, domain: null, created_at: new Date() },
    ]);
    mockIndex({
      indexedContactIds: ["c1"], // book of 1 -> ratio 1/1 = 1.0, over 0.4
      emailHits: ["c1"],
      profiles: [{ pb_contact_id: "c1", email: "new@b.com", phone_e164: null, domain: null }],
    });
    const ctx = makeCtx({ [CLIENT.id]: sets(["new@b.com"], [], []) });
    const m = memberWithWatermark(new Date("2026-01-01"));
    const r = await targetedPurgeMember(CLIENT, m, liveOpts, "run1", counters(), ctx);
    expect(r.status).toBe("aborted_ratio");
    expect(fetchPbContactMock).not.toHaveBeenCalled();
    expect(mockPrisma.phoneburnerDeletion.create).not.toHaveBeenCalled();
    const data = mockPrisma.phoneburnerMember.update.mock.calls[0][0].data;
    expect(data.dnc_processed_through).toBeUndefined();
  });

  it("shared-book guard: does not treat a contact as a candidate when another serving client doesn't suppress it", async () => {
    const liveOpts = { ...OPTS, dryRun: false, maxRatio: 0.9 };
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "shared@b.com", phone_e164: null, domain: null, created_at: new Date() },
    ]);
    mockIndex({
      indexedContactIds: ["x1", "x2"],
      emailHits: ["c1"],
      profiles: [{ pb_contact_id: "c1", email: "shared@b.com", phone_e164: null, domain: null }],
    });
    const clientA = sets(["shared@b.com"], [], []);
    const clientB = sets(["someone-else@b.com"], [], []); // does not suppress it
    const ctx = makeCtx({ [CLIENT.id]: clientA, "client-b": clientB }, { pb1: [CLIENT.id, "client-b"] });
    const m = memberWithWatermark(new Date("2026-01-01"));
    const r = await targetedPurgeMember(CLIENT, m, liveOpts, "run1", counters(), ctx);
    expect(r.collisions).toBe(0);
    expect(r.protected_other_client).toBe(1);
    expect(fetchPbContactMock).not.toHaveBeenCalled();
  });
});

describe("purgeClient — auto-mode dispatch", () => {
  it("full-scans a member that has never been scanned", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([{ ...MEMBER, last_full_scan_at: null }]);
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([]);
    const ctx = makeCtx({ [CLIENT.id]: sets(["a@b.com"], [], []) });
    const autoOpts = { ...OPTS, dryRun: true, mode: "auto" as const };
    const r = await purgeClient(CLIENT, autoOpts, "run1", counters(), ctx);
    expect(fetchMock).toHaveBeenCalled();
    expect(r.members[0].mode).toBe("full");
  });

  it("stays in targeted mode for a recently-scanned member with an index (no fallback)", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([
      { ...MEMBER, last_full_scan_at: new Date(), dnc_processed_through: new Date("2026-01-01"), api_access_ok: true },
    ]);
    mockPrisma.dncEntry.findMany.mockResolvedValue([]); // no new entries -> skipped_no_new_dnc
    const ctx = makeCtx({ [CLIENT.id]: sets(["a@b.com"], [], []) });
    const autoOpts = { ...OPTS, dryRun: true, mode: "auto" as const };
    const r = await purgeClient(CLIENT, autoOpts, "run1", counters(), ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.members[0].mode).toBe("targeted");
    expect(r.members[0].status).toBe("skipped_no_new_dnc");
  });

  it("falls back to a full scan when targeted mode reports skipped_no_index", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([
      { ...MEMBER, last_full_scan_at: new Date(), dnc_processed_through: new Date("2026-01-01"), api_access_ok: true },
    ]);
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "new@b.com", phone_e164: null, domain: null, created_at: new Date() },
    ]);
    mockPrisma.phoneburnerContactIndex.findMany.mockResolvedValue([]); // distinct query -> empty -> skipped_no_index
    tokenMock.mockResolvedValue("tok");
    fetchMock.mockResolvedValue([]);
    const ctx = makeCtx({ [CLIENT.id]: sets(["a@b.com", "new@b.com"], [], []) });
    const autoOpts = { ...OPTS, dryRun: true, mode: "auto" as const };
    const r = await purgeClient(CLIENT, autoOpts, "run1", counters(), ctx);
    expect(fetchMock).toHaveBeenCalled(); // fell back to a full scan
    expect(r.members[0].mode).toBe("full");
  });

  it("explicit mode='targeted' does NOT fall back on skipped_no_index", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([
      { ...MEMBER, last_full_scan_at: null, dnc_processed_through: null, api_access_ok: true },
    ]);
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      { email: "new@b.com", phone_e164: null, domain: null, created_at: new Date() },
    ]);
    mockPrisma.phoneburnerContactIndex.findMany.mockResolvedValue([]); // no index
    const ctx = makeCtx({ [CLIENT.id]: sets(["a@b.com", "new@b.com"], [], []) });
    const targetedOpts = { ...OPTS, dryRun: true, mode: "targeted" as const };
    const r = await purgeClient(CLIENT, targetedOpts, "run1", counters(), ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.members[0].mode).toBe("targeted");
    expect(r.members[0].status).toBe("skipped_no_index");
  });

  it("isolates one member's thrown error without failing the others (status 'error')", async () => {
    mockPrisma.phoneburnerMember.findMany.mockResolvedValue([
      { ...MEMBER, pb_member_id: "pb1", last_full_scan_at: null },
      { ...MEMBER, pb_member_id: "pb2", last_full_scan_at: null },
    ]);
    tokenMock.mockImplementation(async (id: string) => (id === "pb1" ? null : "tok")); // pb1 -> skipped_no_token (not an error)
    fetchMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    const ctx = makeCtx({ [CLIENT.id]: sets(["a@b.com"], [], []) });
    const autoOpts = { ...OPTS, dryRun: true, mode: "full" as const };
    const r = await purgeClient(CLIENT, autoOpts, "run1", counters(), ctx);
    const byId = Object.fromEntries(r.members.map((m) => [m.pb_member_id, m]));
    expect(byId.pb1.status).toBe("skipped_no_token");
    expect(byId.pb2.status).toBe("error");
  });
});
