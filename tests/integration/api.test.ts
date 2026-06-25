import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// Mock Prisma for all integration tests
vi.mock("../../src/db/prisma", () => ({
  default: {
    profile: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    company: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    domainIntel: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    verificationCache: {
      count: vi.fn().mockResolvedValue(0),
      groupBy: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import app from "../../src/app";
import prisma from "../../src/db/prisma";

const mockPrisma = prisma as any;

const API_KEY = "test-integration-key";

describe("API Integration Tests", () => {
  beforeAll(() => {
    process.env.API_KEY = API_KEY;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockPrisma.verificationCache.count.mockResolvedValue(0);
    mockPrisma.verificationCache.groupBy.mockResolvedValue([]);
    mockPrisma.domainIntel.count.mockResolvedValue(0);
  });

  describe("GET /health", () => {
    it("returns OK", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.text).toBe("OK");
    });
  });

  describe("GET /docs/api", () => {
    it("returns HTML documentation", async () => {
      const res = await request(app).get("/docs/api");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    });
  });

  describe("Authentication", () => {
    it("rejects requests without auth header", async () => {
      const res = await request(app).get("/profiles");
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await request(app)
        .get("/profiles")
        .set("Authorization", "Bearer wrong-key");
      expect(res.status).toBe(401);
    });

    it("accepts requests with valid token", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ email: "test@test.com" });
      expect(res.status).toBe(200);
    });
  });

  describe("POST /profiles", () => {
    it("returns 400 when no identity keys provided", async () => {
      const res = await request(app)
        .post("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ name: "John Doe" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("At least one identity key");
    });

    it("creates new profile with email", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      mockPrisma.profile.create.mockResolvedValue({
        id: "new-id",
        email: "john@test.com",
        data: { firstName: "John" },
      });

      const res = await request(app)
        .post("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ email: "John@Test.com", firstName: "John" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.resolved_by).toBe("new");
      expect(res.body.profile_id).toBe("new-id");
    });

    it("updates existing profile", async () => {
      const existing = {
        id: "existing-id",
        email: "john@test.com",
        linkedin_slug: null,
        linkedin_url: null,
        phone_e164: null,
        data: { firstName: "John" },
      };
      mockPrisma.profile.findUnique.mockResolvedValueOnce(existing);
      mockPrisma.profile.update.mockResolvedValue({ ...existing, data: { firstName: "John", company: "Acme" } });

      const res = await request(app)
        .post("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ email: "john@test.com", company: "Acme" });

      expect(res.status).toBe(200);
      expect(res.body.resolved_by).toBe("email");
    });

    it("normalizes email on creation", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);
      mockPrisma.profile.create.mockResolvedValue({ id: "id" });

      await request(app)
        .post("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ email: "  JOHN@TEST.COM  " });

      expect(mockPrisma.profile.findUnique).toHaveBeenCalledWith({
        where: { email: "john@test.com" },
      });
    });
  });

  describe("GET /profiles", () => {
    it("returns profile when found", async () => {
      const mockProfile = {
        id: "p1",
        email: "john@test.com",
        linkedin_slug: "john",
        phone_e164: "+5215551234567",
        data: { firstName: "John", company: "Acme" },
        updated_at: new Date(),
      };
      mockPrisma.profile.findUnique.mockResolvedValueOnce(mockProfile);

      const res = await request(app)
        .get("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ email: "john@test.com" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe(1);
      expect(res.body.email).toBe("john@test.com");
      expect(res.body.firstName).toBe("John");
    });

    it("returns null result when not found", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get("/profiles")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ email: "nobody@test.com" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeNull();
      expect(res.body.message).toBe("No records found");
    });
  });

  describe("POST /companies", () => {
    it("returns 400 when no identifiers provided", async () => {
      const res = await request(app)
        .post("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ name: "Acme" });
      expect(res.status).toBe(400);
    });

    it("creates new company with domain", async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);
      mockPrisma.company.create.mockResolvedValue({
        id: "c1",
        domain: "acme.com",
        data: {},
      });

      const res = await request(app)
        .post("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ domain: "https://www.acme.com" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.resolved_by).toBe("new");
    });

    it("normalizes domain", async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);
      mockPrisma.company.create.mockResolvedValue({ id: "c1" });

      await request(app)
        .post("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ domain: "HTTPS://WWW.ACME.COM/" });

      expect(mockPrisma.company.findUnique).toHaveBeenCalledWith({
        where: { domain: "acme.com" },
      });
    });
  });

  describe("GET /companies", () => {
    it("returns company when found", async () => {
      const mockCompany = {
        id: "c1",
        domain: "acme.com",
        linkedin_slug: "acme",
        data: { industry: "Tech" },
        updated_at: new Date(),
      };
      mockPrisma.company.findUnique.mockResolvedValueOnce(mockCompany);

      const res = await request(app)
        .get("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ domain: "acme.com" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBe(1);
      expect(res.body.domain).toBe("acme.com");
      expect(res.body.industry).toBe("Tech");
    });

    it("returns null result when not found", async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);

      const res = await request(app)
        .get("/companies")
        .set("Authorization", `Bearer ${API_KEY}`)
        .query({ domain: "nope.com" });

      expect(res.status).toBe(200);
      expect(res.body.result).toBeNull();
    });
  });

  describe("GET / (redirect)", () => {
    it("redirects to /docs/api", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/docs/api");
    });
  });
});
