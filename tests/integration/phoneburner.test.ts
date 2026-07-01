import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../../src/db/prisma", () => ({
  default: {
    client: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("../../src/services/phoneburner-purge.service", async (importActual) => {
  const actual = await importActual<any>();
  return { ...actual, runPurge: vi.fn() };
});

import app from "../../src/app";
import prisma from "../../src/db/prisma";
import { runPurge } from "../../src/services/phoneburner-purge.service";

const mockPrisma = prisma as any;
const runPurgeMock = runPurge as any;
const API_KEY = "test-pb-key";
const auth = (r: request.Test) => r.set("Authorization", `Bearer ${API_KEY}`);

const CLIENT = { id: "c-uuid", external_id: "cust", name: "Cust", active: true };

describe("POST /admin/phoneburner/purge", () => {
  beforeAll(() => {
    process.env.API_KEY = API_KEY;
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.client.findMany.mockResolvedValue([]);
    // Member tokens are resolved from GTMOS; the internal-API config must be set.
    process.env.SDR_LAUNCH_INTERNAL_URL = "https://gtmos.example";
    process.env.SDR_LAUNCH_INTERNAL_SECRET = "secret";
  });

  it("401 without auth", async () => {
    const res = await request(app).post("/admin/phoneburner/purge").send({});
    expect(res.status).toBe(401);
  });

  it("400 when GTMOS internal-API config is not set", async () => {
    delete process.env.SDR_LAUNCH_INTERNAL_URL;
    const res = await auth(request(app).post("/admin/phoneburner/purge")).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("SDR_LAUNCH_INTERNAL_URL");
    expect(runPurgeMock).not.toHaveBeenCalled();
  });

  it("404 for unknown client_id (with suggestions)", async () => {
    mockPrisma.client.findUnique.mockResolvedValue(null);
    mockPrisma.client.findMany.mockResolvedValue([{ external_id: "cust", name: "Cust", active: true }]);
    const res = await auth(request(app).post("/admin/phoneburner/purge")).send({ client_id: "cuts" });
    expect(res.status).toBe(404);
    expect(runPurgeMock).not.toHaveBeenCalled();
  });

  it("runs a dry-run and returns the summary", async () => {
    mockPrisma.client.findUnique.mockResolvedValue(CLIENT);
    runPurgeMock.mockResolvedValue({
      run_id: "run-1",
      dry_run: true,
      clients: [],
      totals: { clients_processed: 1, members_processed: 0, members_skipped: 0, contacts_scanned: 0, collisions_found: 0, deleted: 0, failed: 0 },
      status: "ok",
    });
    const res = await auth(request(app).post("/admin/phoneburner/purge")).send({ client_id: "cust", dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.run.run_id).toBe("run-1");
    expect(res.body.run.dry_run).toBe(true);
    // dry_run:true must be passed through to the purge
    expect(runPurgeMock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }), "cust");
  });
});
