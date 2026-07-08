import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Keep the real classifyDncList/searchLists/etc — only the network-hitting
// fetchers used by dnc-sync.service are mocked.
vi.mock("../../src/services/hubspot-lists.service", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    searchDncLists: vi.fn(),
    fetchListContacts: vi.fn(),
    fetchListSize: vi.fn(),
  };
});

// Real HubspotAccessError class so `instanceof` checks inside the service work.
vi.mock("../../src/services/hubspot-token.service", () => {
  class HubspotAccessError extends Error {
    portalId: string;
    status: number;
    constructor(portalId: string, status: number, message: string) {
      super(message);
      this.name = "HubspotAccessError";
      this.portalId = portalId;
      this.status = status;
    }
  }
  return {
    getValidToken: vi.fn().mockResolvedValue("tok"),
    HubspotAccessError,
  };
});

// Keep normalizeEntry (used by buildEntries) real; only mock the DB-writing methods.
vi.mock("../../src/services/dnc.service", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    dncService: {
      ...actual.dncService,
      diffSourceEntries: vi.fn(),
      replaceSourceEntries: vi.fn(),
    },
  };
});

vi.mock("../../src/db/prisma", () => ({
  default: {
    dncSource: {
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    dncEntry: { findMany: vi.fn().mockResolvedValue([]) },
    client: { findMany: vi.fn() },
  },
}));

import { classifyDncList, searchDncLists, fetchListContacts, fetchListSize } from "../../src/services/hubspot-lists.service";
import { getValidToken, HubspotAccessError } from "../../src/services/hubspot-token.service";
import { dncService } from "../../src/services/dnc.service";
import { suggestSimilar } from "../../src/services/suggest";
import prisma from "../../src/db/prisma";
import {
  extractCorporateDomain,
  syncHubspotSource,
  syncClient,
  discoverClient,
  discoverAndSyncAll,
  detectAndSyncChangedClients,
} from "../../src/services/dnc-sync.service";

const mockPrisma = prisma as any;
const searchDncListsMock = searchDncLists as any;
const fetchListContactsMock = fetchListContacts as any;
const fetchListSizeMock = fetchListSize as any;
const diffSourceEntriesMock = dncService.diffSourceEntries as any;

describe("classifyDncList", () => {
  it("classifies (Domain) lists, including client-suffixed names", () => {
    expect(classifyDncList("TAM - Do Not Contact (Domain)")).toBe("domain");
    expect(classifyDncList("TAM - Do Not Contact (Domain) | (Kaleidoscope)")).toBe("domain");
  });

  it("classifies (Individual) lists", () => {
    expect(classifyDncList("TAM - Do Not Contact (Individual)")).toBe("individual");
    expect(classifyDncList("TAM - Do Not Contact (Individual) | (CyberNut)")).toBe("individual");
  });

  it("returns null for unsuffixed / unknown variants", () => {
    expect(classifyDncList("TAM - Do Not Contact")).toBeNull();
    expect(classifyDncList("TAM - Do Not Contact (Inbound)")).toBeNull();
  });
});

describe("extractCorporateDomain", () => {
  const c = (over: Partial<Parameters<typeof extractCorporateDomain>[0]> = {}) => ({
    hubspot_id: "1",
    email: null,
    phone: null,
    email_domain: null,
    ...over,
  });

  it("prefers hs_email_domain, normalized", () => {
    expect(extractCorporateDomain(c({ email_domain: "Acme.COM", email: "x@other.com" }))).toBe("acme.com");
  });

  it("falls back to the email host", () => {
    expect(extractCorporateDomain(c({ email: "jane@acme.io" }))).toBe("acme.io");
  });

  it("excludes free providers so we never block a public domain", () => {
    expect(extractCorporateDomain(c({ email: "jane@gmail.com" }))).toBeNull();
    expect(extractCorporateDomain(c({ email_domain: "yahoo.com" }))).toBeNull();
  });

  it("returns null when there is no usable domain", () => {
    expect(extractCorporateDomain(c({ email: "not-an-email" }))).toBeNull();
    expect(extractCorporateDomain(c())).toBeNull();
  });
});

describe("suggestSimilar", () => {
  const candidates = [
    { id: "hilight", name: "Hilight" },
    { id: "awarded-software", name: "Awarded Software" },
    { id: "studentbridge", name: "StudentBridge" },
    { id: "stellic", name: "Stellic" },
  ];

  it("suggests the closest slug for a near miss", () => {
    expect(suggestSimilar("hilightt", candidates)).toContain("hilight");
    expect(suggestSimilar("hilite", candidates)).toContain("hilight");
  });

  it("matches on display name too", () => {
    expect(suggestSimilar("awarded", candidates)).toContain("awarded-software");
  });

  it("returns nothing for a totally unrelated query", () => {
    expect(suggestSimilar("zzzzzzzzzz", candidates)).toEqual([]);
  });
});

// ─── syncHubspotSource / syncClient / discoverClient / detect ───────────────

const CLIENT = { id: "client-1", external_id: "acme", hubspot_portal_id: "999", active: true } as any;

function makeSource(over: Partial<any> = {}) {
  return {
    id: "src-1",
    client_id: "client-1",
    type: "hubspot_list",
    origin: "discovered",
    dnc_level: "individual",
    label: "TAM - Do Not Contact (Individual)",
    hubspot_list_id: "list-1",
    active: true,
    last_synced_at: null,
    last_sync_status: null,
    last_sync_error: null,
    last_entry_count: 0,
    last_list_size: null,
    last_full_sync_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (getValidToken as any).mockResolvedValue("tok");
  mockPrisma.dncSource.update.mockResolvedValue({});
  mockPrisma.dncSource.upsert.mockResolvedValue({});
  mockPrisma.dncEntry.findMany.mockResolvedValue([]);
  diffSourceEntriesMock.mockResolvedValue({ count: 0, added: 0, removed: 0, changed: false });
});

afterEach(() => {
  delete process.env.DNC_SYNC_CONCURRENCY;
  delete process.env.DNC_FULL_REFRESH_HOURS;
});

describe("syncHubspotSource — skip-unchanged", () => {
  it("makes zero API/diff calls when size+status+freshness all match, and only touches last_synced_at/status", async () => {
    const recentFullSync = new Date(Date.now() - 60_000); // 1 minute ago
    const source = makeSource({
      last_list_size: 5,
      last_entry_count: 5,
      last_sync_status: "ok",
      last_full_sync_at: recentFullSync,
    });

    const result = await syncHubspotSource(CLIENT, source, { currentSize: 5 });

    expect(result.status).toBe("skipped_unchanged");
    expect(result.entry_count).toBe(5);
    expect(fetchListContactsMock).not.toHaveBeenCalled();
    expect(diffSourceEntriesMock).not.toHaveBeenCalled();
    expect(mockPrisma.dncEntry.findMany).not.toHaveBeenCalled();

    expect(mockPrisma.dncSource.update).toHaveBeenCalledTimes(1);
    const call = mockPrisma.dncSource.update.mock.calls[0][0];
    expect(call.where).toEqual({ id: source.id });
    expect(call.data.last_sync_status).toBe("ok");
    expect(call.data).toHaveProperty("last_synced_at");
    // Must NOT clobber the fields that would imply a real re-read happened.
    expect(call.data).not.toHaveProperty("last_list_size");
    expect(call.data).not.toHaveProperty("last_full_sync_at");
    expect(call.data).not.toHaveProperty("last_entry_count");
  });

  it("does not skip when the last sync wasn't ok, even if size matches", async () => {
    const source = makeSource({
      last_list_size: 5,
      last_sync_status: "error",
      last_full_sync_at: new Date(),
    });
    fetchListContactsMock.mockResolvedValue([]);
    diffSourceEntriesMock.mockResolvedValue({ count: 0, added: 0, removed: 0, changed: false });

    const result = await syncHubspotSource(CLIENT, source, { currentSize: 5 });
    expect(result.status).toBe("ok");
    expect(fetchListContactsMock).toHaveBeenCalledTimes(1);
  });

  it("does not skip when currentSize is unknown (null)", async () => {
    const source = makeSource({ last_list_size: 5, last_sync_status: "ok", last_full_sync_at: new Date() });
    fetchListContactsMock.mockResolvedValue([]);

    const result = await syncHubspotSource(CLIENT, source, { currentSize: null });
    expect(result.status).toBe("ok");
    expect(fetchListContactsMock).toHaveBeenCalledTimes(1);
  });

  it("force bypasses the skip regardless of matching size/status", async () => {
    const source = makeSource({
      last_list_size: 5,
      last_sync_status: "ok",
      last_full_sync_at: new Date(),
    });
    fetchListContactsMock.mockResolvedValue([]);

    const result = await syncHubspotSource(CLIENT, source, { currentSize: 5, force: true });
    expect(result.status).toBe("ok");
    expect(fetchListContactsMock).toHaveBeenCalledTimes(1);
  });
});

describe("syncHubspotSource — full refresh forced by age", () => {
  it("forces a full (non-incremental) re-pull once last_full_sync_at is older than DNC_FULL_REFRESH_HOURS, even when size matches", async () => {
    process.env.DNC_FULL_REFRESH_HOURS = "1";
    const staleFullSync = new Date(Date.now() - 2 * 3_600_000); // 2 hours ago
    const source = makeSource({
      last_list_size: 5,
      last_sync_status: "ok",
      last_full_sync_at: staleFullSync,
    });
    const contacts = [{ hubspot_id: "1", email: "a@b.com", phone: null, email_domain: null }];
    fetchListContactsMock.mockResolvedValue(contacts);
    diffSourceEntriesMock.mockResolvedValue({ count: 1, added: 1, removed: 0, changed: true });

    const result = await syncHubspotSource(CLIENT, source, { currentSize: 5 });

    expect(result.status).toBe("ok");
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    // Full refresh: no `known` map is built/passed (every id must be re-read).
    expect(mockPrisma.dncEntry.findMany).not.toHaveBeenCalled();
    const [, , fetchOpts] = fetchListContactsMock.mock.calls[0];
    expect(fetchOpts.known).toBeUndefined();

    const updateCall = mockPrisma.dncSource.update.mock.calls[0][0];
    expect(updateCall.data.last_list_size).toBe(5);
    expect(updateCall.data.last_full_sync_at).toBeInstanceOf(Date);
  });

  it("also forces full refresh when last_full_sync_at has never been set", async () => {
    const source = makeSource({ last_list_size: null, last_sync_status: null, last_full_sync_at: null });
    fetchListContactsMock.mockResolvedValue([]);
    diffSourceEntriesMock.mockResolvedValue({ count: 0, added: 0, removed: 0, changed: false });

    await syncHubspotSource(CLIENT, source, { currentSize: null });
    const [, , fetchOpts] = fetchListContactsMock.mock.calls[0];
    expect(fetchOpts.known).toBeUndefined();
    const updateCall = mockPrisma.dncSource.update.mock.calls[0][0];
    expect(updateCall.data.last_full_sync_at).toBeInstanceOf(Date);
  });
});

describe("syncHubspotSource — incremental known-map reconstruction", () => {
  it("reconstructs the known-contacts map from cached dnc_entries and passes it through, skipping batch-reads for cached ids", async () => {
    const source = makeSource({
      last_list_size: 4, // differs from currentSize below -> not a skip
      last_sync_status: "ok",
      last_full_sync_at: new Date(), // fresh -> full refresh not due
    });
    mockPrisma.dncEntry.findMany.mockResolvedValue([
      {
        email: "cached@acme.com",
        phone_e164: "+15550001111",
        data: { hubspot_contact_id: "555", hubspot_list_id: "list-1", email_domain: "acme.com" },
      },
      // Domain-derived row: no hubspot_contact_id, must be excluded from the known map.
      { email: null, phone_e164: null, data: { hubspot_list_id: "list-1", derived_from: "email_domain" } },
    ]);
    fetchListContactsMock.mockResolvedValue([
      { hubspot_id: "555", email: "cached@acme.com", phone: "+15550001111", email_domain: "acme.com" },
      { hubspot_id: "999", email: "new@acme.com", phone: null, email_domain: "acme.com" },
    ]);
    diffSourceEntriesMock.mockResolvedValue({ count: 2, added: 1, removed: 0, changed: true });

    const result = await syncHubspotSource(CLIENT, source, { currentSize: 5 });

    expect(result.status).toBe("ok");
    expect(mockPrisma.dncEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { source_id: "src-1" } })
    );
    const [, , fetchOpts] = fetchListContactsMock.mock.calls[0];
    expect(fetchOpts.known).toBeInstanceOf(Map);
    expect(fetchOpts.known.size).toBe(1);
    expect(fetchOpts.known.get("555")).toEqual({
      hubspot_id: "555",
      email: "cached@acme.com",
      phone: "+15550001111",
      email_domain: "acme.com",
    });

    // last_full_sync_at must NOT be touched on an incremental (non-full) sync.
    const updateCall = mockPrisma.dncSource.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("last_full_sync_at");
    expect(updateCall.data.last_list_size).toBe(5);
  });

  it("carries email_domain into buildEntries' data payload so it can be reconstructed later", async () => {
    const source = makeSource({ last_list_size: null, last_sync_status: null, last_full_sync_at: null });
    fetchListContactsMock.mockResolvedValue([
      { hubspot_id: "1", email: "jane@acme.com", phone: null, email_domain: "acme.com" },
    ]);
    diffSourceEntriesMock.mockResolvedValue({ count: 1, added: 1, removed: 0, changed: true });

    await syncHubspotSource(CLIENT, source, { currentSize: null });

    const entries = diffSourceEntriesMock.mock.calls[0][3];
    expect(entries[0].data).toMatchObject({ hubspot_contact_id: "1", email_domain: "acme.com" });
  });
});

describe("syncClient — manual-origin size lookup", () => {
  it("fetches size via fetchListSize for a manual source not covered by sizeByListId", async () => {
    mockPrisma.dncSource.findMany.mockResolvedValue([
      makeSource({ id: "manual-1", origin: "manual", hubspot_list_id: "list-manual", last_list_size: 3, last_sync_status: "ok", last_full_sync_at: new Date() }),
    ]);
    fetchListSizeMock.mockResolvedValue(3);

    const results = await syncClient(CLIENT, { sizeByListId: new Map() });

    expect(fetchListSizeMock).toHaveBeenCalledWith(expect.any(Function), "list-manual", expect.objectContaining({ throttle: expect.any(Function) }));
    expect(results[0].status).toBe("skipped_unchanged");
  });

  it("still syncs a manual source when fetchListSize returns null (unknown)", async () => {
    mockPrisma.dncSource.findMany.mockResolvedValue([
      makeSource({ id: "manual-1", origin: "manual", hubspot_list_id: "list-manual", last_list_size: 3, last_sync_status: "ok", last_full_sync_at: new Date() }),
    ]);
    fetchListSizeMock.mockResolvedValue(null);
    fetchListContactsMock.mockResolvedValue([]);
    diffSourceEntriesMock.mockResolvedValue({ count: 0, added: 0, removed: 0, changed: false });

    const results = await syncClient(CLIENT, { sizeByListId: new Map() });
    expect(results[0].status).toBe("ok");
    expect(fetchListContactsMock).toHaveBeenCalledTimes(1);
  });

  it("does not call fetchListSize for a discovered source not present in sizeByListId", async () => {
    mockPrisma.dncSource.findMany.mockResolvedValue([makeSource({ origin: "discovered" })]);
    fetchListContactsMock.mockResolvedValue([]);
    diffSourceEntriesMock.mockResolvedValue({ count: 0, added: 0, removed: 0, changed: false });

    await syncClient(CLIENT, { sizeByListId: new Map() });
    expect(fetchListSizeMock).not.toHaveBeenCalled();
  });
});

describe("discoverClient — lists field", () => {
  it("returns classified lists with their sizes for the caller to feed into syncClient", async () => {
    searchDncListsMock.mockResolvedValue([
      { listId: "list-1", name: "TAM - Do Not Contact (Individual)", level: "individual", contact_count: 10 },
      { listId: "list-2", name: "TAM - Do Not Contact (Inbound)", level: null, contact_count: 2 },
    ]);
    mockPrisma.dncSource.findMany.mockResolvedValue([]); // manualIds lookup + existing-discovered lookup

    const result = await discoverClient(CLIENT);

    expect(result.status).toBe("ok");
    expect(result.lists).toEqual([
      { listId: "list-1", name: "TAM - Do Not Contact (Individual)", level: "individual", contact_count: 10 },
    ]);
    expect(result.unclassified).toHaveLength(1);
  });
});

describe("discoverAndSyncAll — concurrency pool", () => {
  it("bounds concurrent client processing to DNC_SYNC_CONCURRENCY, read at call time", async () => {
    process.env.DNC_SYNC_CONCURRENCY = "2";
    const clients = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      external_id: `client-${i}`,
      hubspot_portal_id: `p${i}`,
      active: true,
    }));
    mockPrisma.client.findMany.mockResolvedValue(clients);
    mockPrisma.dncSource.findMany.mockResolvedValue([]);

    let inFlight = 0;
    let maxInFlight = 0;
    searchDncListsMock.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return [];
    });

    await discoverAndSyncAll();

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it("isolates one client's failure — the rest of the run still completes", async () => {
    const clients = [
      { id: "c1", external_id: "good", hubspot_portal_id: "p1", active: true },
      { id: "c2", external_id: "bad", hubspot_portal_id: "p2", active: true },
    ];
    mockPrisma.client.findMany.mockResolvedValue(clients);
    mockPrisma.dncSource.findMany.mockResolvedValue([]);
    searchDncListsMock.mockImplementation(async (_tp: any, _prefix: any) => {
      throw new Error("boom");
    });

    const { discover } = await discoverAndSyncAll();
    expect(discover).toHaveLength(2);
    expect(discover.every((d) => d.status === "error")).toBe(true);
  });
});

describe("detectAndSyncChangedClients", () => {
  it("reports unchanged and makes no further calls when nothing moved", async () => {
    mockPrisma.client.findMany.mockResolvedValue([CLIENT]);
    searchDncListsMock.mockResolvedValue([
      { listId: "list-1", name: "TAM - Do Not Contact (Individual)", level: "individual", contact_count: 5 },
    ]);
    mockPrisma.dncSource.findMany.mockImplementation(async ({ where }: any) => {
      if (where.origin === "discovered") {
        return [makeSource({ hubspot_list_id: "list-1", label: "TAM - Do Not Contact (Individual)", last_list_size: 5 })];
      }
      return []; // manual
    });

    const result = await detectAndSyncChangedClients();

    expect(result.checked).toBe(1);
    expect(result.changed).toEqual([{ client_external_id: "acme", changed: false }]);
    expect(result.sync).toEqual([]);
    // Only the detector's own probe call — no second discoverClient-driven call.
    expect(searchDncListsMock).toHaveBeenCalledTimes(1);
  });

  it("detects a new list and triggers a resync for that client only", async () => {
    mockPrisma.client.findMany.mockResolvedValue([CLIENT]);
    searchDncListsMock.mockResolvedValue([
      { listId: "list-NEW", name: "TAM - Do Not Contact (Individual)", level: "individual", contact_count: 1 },
    ]);
    mockPrisma.dncSource.findMany.mockImplementation(async ({ where }: any) => {
      if (where.origin === "manual") return [];
      return []; // no discovered sources yet -> list-NEW is unseen
    });
    fetchListContactsMock.mockResolvedValue([]);
    diffSourceEntriesMock.mockResolvedValue({ count: 0, added: 0, removed: 0, changed: false });

    const result = await detectAndSyncChangedClients();

    expect(result.changed[0].changed).toBe(true);
    expect(result.changed[0].reason).toBe("new_list");
    // Detector's probe + discoverClient's own search inside discoverAndSyncClient.
    expect(searchDncListsMock).toHaveBeenCalledTimes(2);
  });

  it("treats no_access as unchanged-but-reported, never a hard failure", async () => {
    mockPrisma.client.findMany.mockResolvedValue([CLIENT]);
    searchDncListsMock.mockRejectedValue(new HubspotAccessError("999", 403, "revoked"));

    const result = await detectAndSyncChangedClients();
    expect(result.changed).toEqual([{ client_external_id: "acme", changed: false, reason: "no_access" }]);
  });

  it("treats a client with no portal id as skipped, never calling HubSpot", async () => {
    mockPrisma.client.findMany.mockResolvedValue([{ ...CLIENT, hubspot_portal_id: null }]);

    const result = await detectAndSyncChangedClients();
    expect(result.changed).toEqual([{ client_external_id: "acme", changed: false, reason: "no_portal" }]);
    expect(searchDncListsMock).not.toHaveBeenCalled();
  });

  it("treats a client with no active sources and no discovered lists as unchanged, not an error", async () => {
    mockPrisma.client.findMany.mockResolvedValue([CLIENT]);
    searchDncListsMock.mockResolvedValue([]);
    mockPrisma.dncSource.findMany.mockResolvedValue([]);

    const result = await detectAndSyncChangedClients();
    expect(result.changed).toEqual([{ client_external_id: "acme", changed: false, reason: "no_lists" }]);
  });
});
