import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    client: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    dncEntry: {
      findFirst: vi.fn(),
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

import app from "../../src/app";
import prisma from "../../src/db/prisma";

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
    mockPrisma.dncEntry.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.dncEntry.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.dncSource.update.mockResolvedValue({});
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
});
