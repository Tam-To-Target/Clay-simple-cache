import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/prisma", () => ({ default: { $queryRaw: vi.fn() } }));

import prisma from "../../src/db/prisma";
import { warmupDatabase } from "../../src/services/dnc-sync.service";

const mQuery = (prisma as any).$queryRaw as ReturnType<typeof vi.fn>;
const noSleep = async () => {};

beforeEach(() => vi.clearAllMocks());

describe("warmupDatabase", () => {
  it("returns after a single successful ping", async () => {
    mQuery.mockResolvedValueOnce([{ "?column?": 1 }]);
    await warmupDatabase({ sleep: noSleep });
    expect(mQuery).toHaveBeenCalledTimes(1);
  });

  it("retries a P1001 connection error, then succeeds", async () => {
    const p1001 = Object.assign(new Error("Can't reach database server at neon:5432"), { code: "P1001" });
    mQuery.mockRejectedValueOnce(p1001).mockRejectedValueOnce(p1001).mockResolvedValueOnce([1]);
    await warmupDatabase({ sleep: noSleep, baseDelayMs: 0 });
    expect(mQuery).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-connection error", async () => {
    mQuery.mockRejectedValueOnce(Object.assign(new Error("syntax error"), { code: "P2010" }));
    await expect(warmupDatabase({ sleep: noSleep })).rejects.toThrow("syntax error");
    expect(mQuery).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of attempts", async () => {
    mQuery.mockRejectedValue(Object.assign(new Error("Can't reach database server"), { code: "P1001" }));
    await expect(warmupDatabase({ attempts: 3, sleep: noSleep, baseDelayMs: 0 })).rejects.toThrow(
      /reach database server/
    );
    expect(mQuery).toHaveBeenCalledTimes(3);
  });
});
