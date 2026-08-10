import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    client: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    dncEntry: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    dncSource: {
      findFirst: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    profile: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

// Pinning a list reads the list's metadata from HubSpot; only the token lookup
// is faked (the HTTP call itself is stubbed per-test via global fetch).
vi.mock("../../src/services/hubspot-token.service", async (importActual) => {
  const actual = await importActual<any>();
  return { ...actual, getValidToken: vi.fn().mockResolvedValue("tok") };
});

import app from "../../src/app";
import prisma from "../../src/db/prisma";
import { getValidToken } from "../../src/services/hubspot-token.service";

const mockPrisma = prisma as any;
const API_KEY = "test-dnc-key";
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${API_KEY}`);

const CLIENT = { id: "client-uuid", external_id: "cust_1", name: "Cust", active: true, hubspot_access_token: null };

describe("DNC API", () => {
  beforeAll(() => {
    process.env.API_KEY = API_KEY;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.dncEntry.findMany.mockResolvedValue([]);
    mockPrisma.dncEntry.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.dncEntry.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.dncSource.update.mockResolvedValue({});
    mockPrisma.client.update.mockResolvedValue({});
    mockPrisma.$transaction.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
  });

  describe("POST /dnc-check", () => {
    it("401 without auth", async () => {
      const res = await request(app).post("/dnc-check").send({ client_id: "cust_1", email: "a@b.com" });
      expect(res.status).toBe(401);
    });

    it("400 when client_id missing", async () => {
      const res = await auth(request(app).post("/dnc-check")).send({ email: "a@b.com" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("client_id");
    });

    it("400 when no identifiers", async () => {
      const res = await auth(request(app).post("/dnc-check")).send({ client_id: "cust_1" });
      expect(res.status).toBe(400);
    });

    it("404 for unknown client", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      const res = await auth(request(app).post("/dnc-check")).send({ client_id: "nope", email: "a@b.com" });
      expect(res.status).toBe(404);
    });

    it("returns contactable:false with reason + source when on DNC", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(CLIENT);
      mockPrisma.dncEntry.findFirst.mockResolvedValue({
        id: "e1",
        email: "a@b.com",
        phone_e164: null,
        domain: null,
        reason: "Unsubscribed",
        source_type: "hubspot_list",
        created_at: new Date("2026-01-01"),
        source: { type: "hubspot_list", label: "Suppression", hubspot_list_id: "42", last_synced_at: new Date("2026-06-01") },
      });

      const res = await auth(request(app).post("/dnc-check")).send({ client_id: "cust_1", email: "A@B.com" });
      expect(res.status).toBe(200);
      expect(res.body.contactable).toBe(false);
      expect(res.body.status).toBe("do_not_contact");
      expect(res.body.reason).toBe("Unsubscribed");
      expect(res.body.matched_on).toBe("email");
      expect(res.body.source.hubspot_list_id).toBe("42");
      // Must NOT leak contact enrichment data when suppressed.
      expect(res.body.contact).toBeUndefined();
    });

    it("matches a company-level domain entry from the email's domain", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(CLIENT);
      mockPrisma.dncEntry.findFirst.mockResolvedValue({
        id: "e2",
        email: null,
        phone_e164: null,
        domain: "b.com",
        reason: "Blocked company",
        source_type: "csv",
        created_at: new Date(),
        source: { type: "csv", label: "blocklist", hubspot_list_id: null, last_synced_at: null },
      });

      const res = await auth(request(app).post("/dnc-check")).send({ client_id: "cust_1", email: "anyone@b.com" });
      expect(res.body.contactable).toBe(false);
      expect(res.body.matched_on).toBe("domain");
    });

    it("returns contactable:true with profile data when not on DNC", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(CLIENT);
      mockPrisma.dncEntry.findFirst.mockResolvedValue(null);
      mockPrisma.profile.findUnique.mockResolvedValue({
        id: "p1",
        email: "a@b.com",
        linkedin_slug: "ab",
        phone_e164: null,
        data: { firstName: "Ann" },
        updated_at: new Date(),
      });

      const res = await auth(request(app).post("/dnc-check")).send({ client_id: "cust_1", email: "a@b.com" });
      expect(res.status).toBe(200);
      expect(res.body.contactable).toBe(true);
      expect(res.body.contact.email).toBe("a@b.com");
      expect(res.body.contact.firstName).toBe("Ann");
    });

    it("returns contactable:true with contact:null when no cached profile", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(CLIENT);
      mockPrisma.dncEntry.findFirst.mockResolvedValue(null);
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const res = await auth(request(app).post("/dnc-check")).send({ client_id: "cust_1", email: "x@y.com" });
      expect(res.body.contactable).toBe(true);
      expect(res.body.contact).toBeNull();
    });
  });

  describe("POST /admin/clients", () => {
    it("upserts a client; hubspot_connected reflects a mapped portal, no token stored", async () => {
      mockPrisma.client.upsert.mockResolvedValue({
        id: "client-uuid",
        external_id: "cust_1",
        name: "Cust",
        active: true,
        hubspot_portal_id: "111",
        created_at: new Date(),
        updated_at: new Date(),
      });

      const res = await auth(request(app).post("/admin/clients")).send({
        external_id: "cust_1",
        name: "Cust",
        hubspot_portal_id: "111",
      });
      expect(res.status).toBe(200);
      expect(res.body.client.external_id).toBe("cust_1");
      expect(res.body.client.hubspot_connected).toBe(true);
      // Tokens are never stored — column removed; resolved via the provisioner.
      expect(res.body.client.hubspot_access_token).toBeUndefined();
    });

    it("400 when external_id missing", async () => {
      const res = await auth(request(app).post("/admin/clients")).send({ name: "x" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /admin/dnc/import", () => {
    it("imports entries from CSV and skips rows with no identifier", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(CLIENT);
      mockPrisma.dncSource.findFirst.mockResolvedValue(null);
      mockPrisma.dncSource.create.mockResolvedValue({ id: "src1" });

      const csv = "email,reason\na@b.com,opted out\n,no identifier";
      const res = await auth(request(app).post("/admin/dnc/import")).send({
        client_id: "cust_1",
        source_label: "csv upload",
        csv,
      });

      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(1);
      expect(res.body.skipped).toBe(1);
      expect(res.body.mode).toBe("replace");
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it("400 when neither csv nor entries provided", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(CLIENT);
      const res = await auth(request(app).post("/admin/dnc/import")).send({ client_id: "cust_1" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /admin/dnc/lists (pin a list, any name)", () => {
    it("401 without auth", async () => {
      const res = await request(app)
        .post("/admin/dnc/lists")
        .send({ client_id: "cust_1", hubspot_list_id: "42", dnc_level: "individual" });
      expect(res.status).toBe(401);
    });

    it("400 when required fields are missing", async () => {
      const res = await auth(request(app).post("/admin/dnc/lists")).send({ client_id: "cust_1" });
      expect(res.status).toBe(400);
    });

    it("400 for an invalid dnc_level", async () => {
      const res = await auth(request(app).post("/admin/dnc/lists")).send({
        client_id: "cust_1",
        hubspot_list_id: "42",
        dnc_level: "inbound",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("dnc_level");
    });

    it("404 for an unknown client", async () => {
      mockPrisma.client.findUnique.mockResolvedValue(null);
      mockPrisma.client.findMany.mockResolvedValue([{ external_id: "cust_1", name: "Cust", active: true }]);
      const res = await auth(request(app).post("/admin/dnc/lists")).send({
        client_id: "nope",
        hubspot_list_id: "42",
        dnc_level: "domain",
      });
      expect(res.status).toBe(404);
    });

    it("400 when the client has no HubSpot portal", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ ...CLIENT, hubspot_portal_id: null });
      const res = await auth(request(app).post("/admin/dnc/lists")).send({
        client_id: "cust_1",
        hubspot_list_id: "42",
        dnc_level: "individual",
      });
      expect(res.status).toBe(400);
    });

    // A company list carries no email/phone, so pinning it as 'individual' would
    // import nothing — rejected up front rather than on the first sync.
    it("400 for a COMPANY list pinned as individual (and nothing is persisted)", async () => {
      mockPrisma.client.findUnique.mockResolvedValue({ ...CLIENT, hubspot_portal_id: "123" });
      (getValidToken as any).mockResolvedValue("tok");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ list: { listId: "894", name: "TAM Customers", objectTypeId: "0-2" } }),
          text: async () => "",
        })
      );

      const res = await auth(request(app).post("/admin/dnc/lists")).send({
        client_id: "cust_1",
        hubspot_list_id: "894",
        dnc_level: "individual",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/COMPANY list/i);
      expect(res.body.error).toMatch(/dnc_level='domain'/);
      expect(mockPrisma.dncSource.upsert).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  });

  describe("GET /admin/dnc/hubspot-lists (id lookup)", () => {
    it("400 without client_id", async () => {
      const res = await auth(request(app).get("/admin/dnc/hubspot-lists"));
      expect(res.status).toBe(400);
    });
  });
});
