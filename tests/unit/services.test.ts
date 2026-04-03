import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma before importing services
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
  },
}));

import { profileService } from "../../src/services/profile.service";
import { companyService } from "../../src/services/company.service";
import prisma from "../../src/db/prisma";

const mockPrisma = prisma as any;

describe("profileService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findProfile", () => {
    it("finds by email first (highest priority)", async () => {
      const mockProfile = { id: "1", email: "test@test.com", data: {} };
      mockPrisma.profile.findUnique.mockResolvedValueOnce(mockProfile);

      const result = await profileService.findProfile({
        email: "test@test.com",
        linkedin_slug: "test-slug",
      });

      expect(result.profile).toEqual(mockProfile);
      expect(result.resolvedBy).toBe("email");
      expect(mockPrisma.profile.findUnique).toHaveBeenCalledTimes(1);
    });

    it("falls back to linkedin_url when email not found", async () => {
      const mockProfile = { id: "2", linkedin_url: "https://linkedin.com/in/test" };
      mockPrisma.profile.findUnique
        .mockResolvedValueOnce(null) // email
        .mockResolvedValueOnce(mockProfile); // linkedin_url

      const result = await profileService.findProfile({
        email: "test@test.com",
        linkedin_url: "https://linkedin.com/in/test",
      });

      expect(result.resolvedBy).toBe("linkedin_url");
    });

    it("falls back to linkedin_slug", async () => {
      const mockProfile = { id: "3", linkedin_slug: "test-slug" };
      mockPrisma.profile.findUnique
        .mockResolvedValueOnce(null) // email
        .mockResolvedValueOnce(null) // linkedin_url
        .mockResolvedValueOnce(mockProfile); // linkedin_slug

      const result = await profileService.findProfile({
        email: "x@x.com",
        linkedin_url: "url",
        linkedin_slug: "test-slug",
      });

      expect(result.resolvedBy).toBe("linkedin_slug");
    });

    it("falls back to phone_e164", async () => {
      const mockProfile = { id: "4", phone_e164: "+5215512345678" };
      mockPrisma.profile.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockProfile);

      const result = await profileService.findProfile({
        email: "x@x.com",
        linkedin_url: "url",
        linkedin_slug: "slug",
        phone_e164: "+5215512345678",
      });

      expect(result.resolvedBy).toBe("phone_e164");
    });

    it("returns null when nothing found", async () => {
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const result = await profileService.findProfile({ email: "nope@nope.com" });
      expect(result.profile).toBeNull();
      expect(result.resolvedBy).toBeNull();
    });
  });

  describe("mergeData", () => {
    it("merges old and new data", () => {
      const result = profileService.mergeData(
        { firstName: "John", title: "Old" },
        { title: "New", company: "Acme" }
      );
      expect(result).toEqual({ firstName: "John", title: "New", company: "Acme" });
    });

    it("handles null old data", () => {
      const result = profileService.mergeData(null, { key: "value" });
      expect(result).toEqual({ key: "value" });
    });
  });

  describe("createProfile", () => {
    it("creates profile with all fields", async () => {
      const params = {
        email: "test@test.com",
        linkedin_slug: "test",
        linkedin_url: "https://linkedin.com/in/test",
        phone_e164: "+1234567890",
        data: { name: "Test" },
      };
      mockPrisma.profile.create.mockResolvedValueOnce({ id: "new-id", ...params });

      const result = await profileService.createProfile(params);
      expect(result.id).toBe("new-id");
      expect(mockPrisma.profile.create).toHaveBeenCalledWith({
        data: {
          email: "test@test.com",
          linkedin_slug: "test",
          linkedin_url: "https://linkedin.com/in/test",
          phone_e164: "+1234567890",
          data: { name: "Test" },
        },
      });
    });

    it("defaults data to empty object", async () => {
      mockPrisma.profile.create.mockResolvedValueOnce({ id: "id" });

      await profileService.createProfile({ email: "a@b.com" });
      expect(mockPrisma.profile.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ data: {} }),
      });
    });
  });

  describe("updateProfile", () => {
    it("strips meta fields before updating", async () => {
      mockPrisma.profile.update.mockResolvedValueOnce({ id: "1" });

      await profileService.updateProfile("1", {
        id: "1",
        email: "new@email.com",
        created_at: new Date(),
        updated_at: new Date(),
      } as any);

      const call = mockPrisma.profile.update.mock.calls[0][0];
      expect(call.data).not.toHaveProperty("created_at");
      expect(call.data).not.toHaveProperty("updated_at");
      expect(call.data).not.toHaveProperty("id");
      expect(call.data.email).toBe("new@email.com");
    });
  });
});

describe("companyService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("findCompany", () => {
    it("finds by domain first", async () => {
      const mockCompany = { id: "1", domain: "acme.com" };
      mockPrisma.company.findUnique.mockResolvedValueOnce(mockCompany);

      const result = await companyService.findCompany({
        domain: "acme.com",
        linkedin_slug: "acme",
      });

      expect(result.company).toEqual(mockCompany);
      expect(result.resolved_by).toBe("domain");
    });

    it("falls back to linkedin_slug", async () => {
      const mockCompany = { id: "2", linkedin_slug: "acme" };
      mockPrisma.company.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockCompany);

      const result = await companyService.findCompany({
        domain: "acme.com",
        linkedin_slug: "acme",
      });

      expect(result.resolved_by).toBe("linkedin_slug");
    });

    it("returns undefined when nothing found", async () => {
      mockPrisma.company.findUnique.mockResolvedValue(null);

      const result = await companyService.findCompany({ domain: "nope.com" });
      expect(result.company).toBeUndefined();
    });
  });

  describe("mergeData", () => {
    it("merges old and new data", () => {
      const result = companyService.mergeData(
        { industry: "Tech" },
        { employees: 50 }
      );
      expect(result).toEqual({ industry: "Tech", employees: 50 });
    });
  });

  describe("createCompany", () => {
    it("creates company", async () => {
      mockPrisma.company.create.mockResolvedValueOnce({ id: "c1" });

      await companyService.createCompany({
        domain: "acme.com",
        linkedin_slug: "acme",
        data: { name: "Acme" },
      });

      expect(mockPrisma.company.create).toHaveBeenCalledWith({
        data: {
          domain: "acme.com",
          linkedin_slug: "acme",
          data: { name: "Acme" },
        },
      });
    });
  });
});
