import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/services/dnc-sync.service", () => ({
  detectAndSyncChangedClients: vi.fn(),
}));

vi.mock("../../src/services/phoneburner-purge.service", () => ({
  runPurge: vi.fn(),
  purgeOptionsFromEnv: vi.fn().mockReturnValue({
    dryRun: true,
    maxRatio: 0.3,
    includeDomains: true,
    maxDeletesPerRun: null,
  }),
}));

import { detectAndSyncChangedClients } from "../../src/services/dnc-sync.service";
import { runPurge } from "../../src/services/phoneburner-purge.service";
import { startScheduler, stopScheduler } from "../../src/scheduler";

const detectMock = detectAndSyncChangedClients as any;
const purgeMock = runPurge as any;

const detectResult = (overrides?: Partial<{ checked: number; changed: any[] }>) => ({
  checked: 1,
  changed: [],
  sync: [],
  ...overrides,
});

const purgeResult = (overrides?: Partial<{ status: string; dry_run: boolean }>) => ({
  run_id: "run-1",
  dry_run: true,
  clients: [],
  totals: {
    clients_processed: 0,
    members_processed: 0,
    members_skipped: 0,
    contacts_scanned: 0,
    collisions_found: 0,
    deleted: 0,
    failed: 0,
    protected_other_client: 0,
    targeted_members: 0,
    full_scan_members: 0,
  },
  status: "ok",
  ...overrides,
});

describe("scheduler", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    detectMock.mockReset().mockResolvedValue(detectResult());
    purgeMock.mockReset().mockResolvedValue(purgeResult());
    process.env = { ...ORIGINAL_ENV };
    delete process.env.DETECTOR_ENABLED;
    delete process.env.DETECTOR_INTERVAL_MINUTES;
  });

  afterEach(() => {
    stopScheduler();
    vi.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
  });

  it("is a no-op when DETECTOR_ENABLED is not set", async () => {
    startScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); // a full day
    expect(detectMock).not.toHaveBeenCalled();
    expect(purgeMock).not.toHaveBeenCalled();
  });

  it("is a no-op when DETECTOR_ENABLED is not exactly \"true\"", async () => {
    process.env.DETECTOR_ENABLED = "1";
    startScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(detectMock).not.toHaveBeenCalled();
  });

  it("runs the first tick 2 minutes after start, then every DETECTOR_INTERVAL_MINUTES (default 60)", async () => {
    process.env.DETECTOR_ENABLED = "true";
    startScheduler();

    // Nothing yet just before 2 minutes.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 - 1);
    expect(detectMock).not.toHaveBeenCalled();

    // First tick fires at +2min.
    await vi.advanceTimersByTimeAsync(1);
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(purgeMock).toHaveBeenCalledTimes(1);
    expect(purgeMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "targeted" }));

    // Nothing else happens before the next full 60-minute interval.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
    expect(detectMock).toHaveBeenCalledTimes(1);

    // Second tick fires at +60min after the first.
    await vi.advanceTimersByTimeAsync(1);
    expect(detectMock).toHaveBeenCalledTimes(2);
    expect(purgeMock).toHaveBeenCalledTimes(2);
  });

  it("respects a custom DETECTOR_INTERVAL_MINUTES", async () => {
    process.env.DETECTOR_ENABLED = "true";
    process.env.DETECTOR_INTERVAL_MINUTES = "15";
    startScheduler();

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000); // first tick
    expect(detectMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1);
    expect(detectMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(detectMock).toHaveBeenCalledTimes(2);
  });

  it("overlap guard: a tick that never resolves blocks the next tick from starting", async () => {
    process.env.DETECTOR_ENABLED = "true";
    let releaseFirst: () => void = () => {};
    const hang = new Promise<any>((resolve) => {
      releaseFirst = () => resolve(detectResult());
    });
    detectMock.mockReturnValueOnce(hang);

    startScheduler();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000); // first tick starts, hangs on detect
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(purgeMock).not.toHaveBeenCalled(); // never got past the hung detect call

    // Even advancing well past the interval, no second tick starts because the
    // first has never settled (self-rescheduling only schedules the next tick
    // once the current one resolves).
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(detectMock).toHaveBeenCalledTimes(1);

    // Release the hung tick — it completes, and the scheduler resumes ticking.
    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(detectMock).toHaveBeenCalledTimes(2);
  });

  it("a rejecting tick does not throw/unhandled-reject and the next tick still runs", async () => {
    process.env.DETECTOR_ENABLED = "true";
    detectMock.mockRejectedValueOnce(new Error("boom"));

    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    startScheduler();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(detectMock).toHaveBeenCalledTimes(1);
    expect(purgeMock).not.toHaveBeenCalled(); // detect rejected before purge ran

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(detectMock).toHaveBeenCalledTimes(2);
    expect(purgeMock).toHaveBeenCalledTimes(1); // second tick succeeded normally

    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", unhandled);
  });

  it("stopScheduler clears the pending timer so no further ticks run", async () => {
    process.env.DETECTOR_ENABLED = "true";
    startScheduler();

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(detectMock).toHaveBeenCalledTimes(1);

    stopScheduler();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(detectMock).toHaveBeenCalledTimes(1);
  });

  it("calling startScheduler twice does not double-schedule", async () => {
    process.env.DETECTOR_ENABLED = "true";
    startScheduler();
    startScheduler();

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(detectMock).toHaveBeenCalledTimes(1);
  });
});
