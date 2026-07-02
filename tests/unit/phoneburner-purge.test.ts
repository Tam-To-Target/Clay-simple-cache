import { describe, it, expect, vi, beforeEach } from "vitest";

// Real PhoneburnerAccessError class so `instanceof` works in the service.
vi.mock("../../src/services/phoneburner.service", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    fetchMemberContacts: vi.fn(),
    deletePbContact: vi.fn(),
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
  purgeOptionsFromEnv,
  DncSets,
} from "../../src/services/phoneburner-purge.service";
import {
  fetchMemberContacts,
  deletePbContact,
  PhoneburnerAccessError,
} from "../../src/services/phoneburner.service";
import { getMemberToken } from "../../src/services/phoneburner-token.service";
import prisma from "../../src/db/prisma";

const mockPrisma = prisma as any;
const fetchMock = fetchMemberContacts as any;
const deleteMock = deletePbContact as any;
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

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.phoneburnerMember.update.mockResolvedValue({});
  mockPrisma.phoneburnerDeletion.create.mockResolvedValue({ id: "audit-1" });
  mockPrisma.phoneburnerDeletion.update.mockResolvedValue({});
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

describe("purgeMember", () => {
  const counters = () => ({ deletedThisRun: 0 });
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
    expect(deleteMock).toHaveBeenCalledWith("c1", expect.any(Function));
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
});
