import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    pbLeadScore: { findMany: vi.fn(), create: vi.fn(), upsert: vi.fn() },
  },
}));

import prisma from "../../src/db/prisma";
import {
  parseLeadScore,
  derivePrefix,
  peekNextLeadScore,
  issueLeadScore,
  recordLeadScore,
} from "../../src/services/pb-lead-score.service";

const mockPrisma = prisma as any;

const client = (over: Partial<any> = {}) =>
  ({
    id: "client-1",
    external_id: "club-hub",
    name: "Club Hub",
    pb_client_tag: null,
    pb_lead_score_prefix: null,
    ...over,
  } as any);

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.pbLeadScore.create.mockResolvedValue({});
  mockPrisma.pbLeadScore.upsert.mockResolvedValue({});
});

describe("parseLeadScore", () => {
  it("splits a prefix + trailing number", () => {
    expect(parseLeadScore("club8")).toEqual({ prefix: "club", seq: 8 });
    expect(parseLeadScore("PlanIt3")).toEqual({ prefix: "PlanIt", seq: 3 });
    expect(parseLeadScore("12")).toEqual({ prefix: "", seq: 12 });
  });
  it("returns null with no trailing number", () => {
    expect(parseLeadScore("freeform")).toBeNull();
  });
});

describe("derivePrefix", () => {
  it("prefers the seeded prefix, then tag, then slug; letters only, lowercased", () => {
    expect(derivePrefix({ pb_lead_score_prefix: "Club", pb_client_tag: "X", external_id: "y" })).toBe("club");
    expect(derivePrefix({ pb_lead_score_prefix: null, pb_client_tag: "PlanIt", external_id: "plan-it" })).toBe("planit");
    expect(derivePrefix({ pb_lead_score_prefix: null, pb_client_tag: null, external_id: "club-hub" })).toBe("clubhub");
  });
});

describe("peekNextLeadScore", () => {
  it("uses the dominant historical prefix + max seq + 1", async () => {
    const next = await peekNextLeadScore(client(), {
      findLedger: async () => [
        { prefix: "club", seq: 6 },
        { prefix: "club", seq: 7 },
        { prefix: "misc", seq: 99 }, // minority prefix, ignored
      ],
    });
    expect(next).toEqual({ prefix: "club", seq: 8, value: "club8" });
  });

  it("starts at prefix+1 when there is no history", async () => {
    const next = await peekNextLeadScore(client({ pb_client_tag: "ClubHub" }), { findLedger: async () => [] });
    expect(next).toEqual({ prefix: "clubhub", seq: 1, value: "clubhub1" });
  });

  it("honors an explicit client prefix override for the seq window", async () => {
    const next = await peekNextLeadScore(client({ pb_lead_score_prefix: "club" }), {
      findLedger: async () => [
        { prefix: "club", seq: 4 },
        { prefix: "other", seq: 40 },
      ],
    });
    expect(next).toEqual({ prefix: "club", seq: 5, value: "club5" });
  });
});

describe("issueLeadScore", () => {
  it("records the minted value as source=issued", async () => {
    const res = await issueLeadScore(client(), { campaign: "ISTE" }, {
      findLedger: async () => [{ prefix: "club", seq: 8 }],
    });
    expect(res.value).toBe("club9");
    expect(mockPrisma.pbLeadScore.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.pbLeadScore.create.mock.calls[0][0].data).toMatchObject({
      client_id: "client-1",
      lead_score: "club9",
      prefix: "club",
      seq: 9,
      source: "issued",
      campaign: "ISTE",
    });
  });

  it("retries on a unique collision (P2002) then succeeds", async () => {
    // First peek yields club9 (collides); the ledger then reflects club9 taken,
    // so the retry peek yields club10 and succeeds.
    const findLedger = vi
      .fn()
      .mockResolvedValueOnce([{ prefix: "club", seq: 8 }])
      .mockResolvedValueOnce([{ prefix: "club", seq: 9 }]);
    mockPrisma.pbLeadScore.create
      .mockRejectedValueOnce({ code: "P2002" })
      .mockResolvedValueOnce({});

    const res = await issueLeadScore(client(), {}, { findLedger });
    expect(res.value).toBe("club10");
    expect(mockPrisma.pbLeadScore.create).toHaveBeenCalledTimes(2);
  });
});

describe("recordLeadScore", () => {
  it("upserts a caller-supplied value with parsed prefix/seq", async () => {
    await recordLeadScore(client(), "club12", { campaign: "X" });
    const call = mockPrisma.pbLeadScore.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ client_id_lead_score: { client_id: "client-1", lead_score: "club12" } });
    expect(call.create).toMatchObject({ lead_score: "club12", prefix: "club", seq: 12, source: "issued", campaign: "X" });
  });

  it("stores an unparseable value with seq 0", async () => {
    await recordLeadScore(client(), "freeform");
    expect(mockPrisma.pbLeadScore.upsert.mock.calls[0][0].create).toMatchObject({ prefix: "freeform", seq: 0 });
  });
});
