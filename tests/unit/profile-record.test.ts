import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    profile: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

import { profileService } from "../../src/services/profile.service";
import prisma from "../../src/db/prisma";

const mockPrisma = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.profile.update.mockResolvedValue({});
});

describe("recordProfile", () => {
  it("is a no-op when no identity key is provided", async () => {
    const r = await profileService.recordProfile({}, { foo: "bar" });
    expect(r).toEqual({ profile_id: null, created: false });
    expect(mockPrisma.profile.findMany).not.toHaveBeenCalled();
  });

  it("creates a new profile when none exists", async () => {
    mockPrisma.profile.findMany.mockResolvedValue([]);
    mockPrisma.profile.create.mockResolvedValue({ id: "new-1" });
    const r = await profileService.recordProfile({ email: "a@b.com" }, { campaign: "x" });
    expect(r).toEqual({ profile_id: "new-1", created: true });
    expect(mockPrisma.profile.create).toHaveBeenCalled();
  });

  it("merges data into EVERY profile owning a provided key (no data loss when split)", async () => {
    // Identity split across two rows: A owns email, B owns phone.
    mockPrisma.profile.findMany.mockResolvedValue([
      { id: "A", email: "a@b.com", phone_e164: null, linkedin_slug: null, linkedin_url: null, data: {} },
      { id: "B", email: null, phone_e164: "+1222", linkedin_slug: null, linkedin_url: null, data: {} },
    ]);
    const r = await profileService.recordProfile({ email: "a@b.com", phone_e164: "+1222" }, { note: "hi" });
    expect(r.created).toBe(false);
    // Both rows updated with the merged data → reachable by either key.
    const ids = mockPrisma.profile.update.mock.calls.map((c: any[]) => c[0].where.id).sort();
    expect(ids).toEqual(["A", "B"]);
    for (const call of mockPrisma.profile.update.mock.calls) {
      expect(call[0].data.data).toMatchObject({ note: "hi" });
    }
  });

  it("does not fill a key already owned by another matched row", async () => {
    // Primary A (email) has no phone; B owns the phone we'd otherwise fill.
    mockPrisma.profile.findMany.mockResolvedValue([
      { id: "A", email: "a@b.com", phone_e164: null, linkedin_slug: null, linkedin_url: null, data: {} },
      { id: "B", email: null, phone_e164: "+1222", linkedin_slug: null, linkedin_url: null, data: {} },
    ]);
    await profileService.recordProfile({ email: "a@b.com", phone_e164: "+1222" }, {});
    const aUpdate = mockPrisma.profile.update.mock.calls.find((c: any[]) => c[0].where.id === "A");
    // A must NOT be assigned phone_e164 (owned by B) — avoids the unique collision.
    expect(aUpdate[0].data.phone_e164).toBeUndefined();
  });

  it("recovers from a create race by merging into the winner", async () => {
    mockPrisma.profile.findMany
      .mockResolvedValueOnce([]) // first lookup: none
      .mockResolvedValueOnce([{ id: "winner", email: "a@b.com", data: {} }]); // after race
    mockPrisma.profile.create.mockRejectedValue(new Error("Unique constraint failed"));
    const r = await profileService.recordProfile({ email: "a@b.com" }, { note: "x" });
    expect(r.profile_id).toBe("winner");
    expect(mockPrisma.profile.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "winner" } })
    );
  });
});
