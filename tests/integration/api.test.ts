import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";

// Mock Prisma for all integration tests
vi.mock("../../src/services/tech-detector.service", () => ({
  detectTechnologies: vi.fn(),
}));

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
    searchLog: {
      count: vi.fn().mockResolvedValue(0),
      aggregate: vi.fn().mockResolvedValue({ _sum: { cost_usd: 0 } }),
      groupBy: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    domainIntel: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    domainPattern: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    verificationCache: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  },
}));

import app from "../../src/app";
import prisma from "../../src/db/prisma";
import { detectTechnologies } from "../../src/services/tech-detector.service";

const mockPrisma = prisma as any;
const mockDetect = detectTechnologies as any;

const API_KEY = "test-integration-key";

describe("API Integration Tests", () => {
  beforeAll(() => {
    process.env.API_KEY = API_KEY;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    mockPrisma.searchLog.count.mockResolvedValue(0);
    mockPrisma.searchLog.aggregate.mockResolvedValue({ _sum: { cost_usd: 0 } });
    mockPrisma.searchLog.groupBy.mockResolvedValue([]);
    mockPrisma.domainIntel.count.mockResolvedValue(0);
    mockPrisma.domainPattern.count.mockResolvedValue(0);
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

  describe("POST /find", () => {
    it("returns 400 when domain is missing", async () => {
      const res = await request(app)
        .post("/find")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ first_name: "John" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("domain is required");
    });

    it("returns 400 when no name provided", async () => {
      const res = await request(app)
        .post("/find")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ domain: "acme.com" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("first_name");
    });
  });

  describe("POST /verify", () => {
    it("returns 400 when email is missing", async () => {
      const res = await request(app)
        .post("/verify")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("email is required");
    });
  });

  describe("GET /stats", () => {
    it("returns stats with all fields", async () => {
      const res = await request(app)
        .get("/stats")
        .set("Authorization", `Bearer ${API_KEY}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("total_searches");
      expect(res.body).toHaveProperty("total_valid_found");
      expect(res.body).toHaveProperty("success_rate");
      expect(res.body).toHaveProperty("methods_breakdown");
      expect(res.body).toHaveProperty("total_cost_usd");
      expect(res.body).toHaveProperty("avg_cost_per_email");
      expect(res.body).toHaveProperty("domains_in_cache");
      expect(res.body).toHaveProperty("patterns_learned");
      expect(res.body).toHaveProperty("catch_all_domains");
    });

    it("calculates success_rate correctly", async () => {
      mockPrisma.searchLog.count
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(75); // valid

      const res = await request(app)
        .get("/stats")
        .set("Authorization", `Bearer ${API_KEY}`);

      expect(res.body.success_rate).toBe(0.75);
    });
  });

  describe("GET / (redirect)", () => {
    it("redirects to /docs/api", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/docs/api");
    });
  });

  describe("POST /detect-tech", () => {
    beforeEach(() => {
      mockDetect.mockReset();
    });

    it("returns 401 without auth header", async () => {
      const res = await request(app)
        .post("/detect-tech")
        .send({ url: "https://example.com" });
      expect(res.status).toBe(401);
    });

    it("returns 400 when url is missing", async () => {
      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("url is required");
    });

    it("returns 400 for invalid URL format", async () => {
      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url: "://invalid url with spaces" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid URL format");
    });

    it("returns 200 with full TechResult on success", async () => {
      const mockResult = {
        technologies: "WordPress 6.4, Google Tag Manager",
        scripts: ["https://googletagmanager.com/gtm.js?id=GTM-XXX"],
        links: [],
        meta: [{ name: "generator", content: "WordPress 6.4" }],
      };
      mockDetect.mockResolvedValue(mockResult);

      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url: "https://example.com" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.url).toBe("https://example.com");
      expect(res.body.technologies).toBe("WordPress 6.4, Google Tag Manager");
      expect(res.body.scripts).toContain("https://googletagmanager.com/gtm.js?id=GTM-XXX");
      expect(res.body.links).toEqual([]);
      expect(res.body.meta).toContainEqual({ name: "generator", content: "WordPress 6.4" });
    });

    it("returns 504 when service throws a Timeout error", async () => {
      mockDetect.mockRejectedValue(new Error("Timeout al obtener la URL"));

      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url: "https://example.com" });

      expect(res.status).toBe(504);
      expect(res.body.error).toContain("Timeout");
    });

    it("returns 502 when service throws an HTTP error", async () => {
      mockDetect.mockRejectedValue(new Error("HTTP 404 desde la URL"));

      const res = await request(app)
        .post("/detect-tech")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ url: "https://example.com" });

      expect(res.status).toBe(502);
      expect(res.body.error).toContain("HTTP 404");
    });
  });
});
