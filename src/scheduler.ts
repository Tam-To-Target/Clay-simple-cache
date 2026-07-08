/**
 * Hourly in-process detector for the always-on web service.
 *
 * The daily `ops:daily` cron (see src/scripts/ops-daily.ts) is the source of
 * truth for full reconciliation, but DNC lists can change between daily runs.
 * This scheduler cheaply checks for drift every `DETECTOR_INTERVAL_MINUTES`
 * (default 60): `detectAndSyncChangedClients()` spends ~1 HubSpot call per
 * client to see if anything moved (near-zero cost when nothing did, and only
 * pulls membership for the list(s) that actually changed), then
 * `runPurge({ mode: "targeted" })` looks up any newly-added DNC entries in the
 * PhoneBurner identity index (DB-only when there's nothing new — no book
 * scans here; those are the daily/weekly job's job).
 *
 * Gated behind `DETECTOR_ENABLED === "true"` so it stays off by default —
 * running it on every deployed instance would multiply the work, and most
 * deployments are fine with the daily cron alone. Env is read at call/tick
 * time (not module load) so a running process picks up a Railway var change
 * without a redeploy, and so tests can flip it per-case.
 *
 * A tick NEVER throws or rejects out of this module — a failure here must not
 * crash the web service. The overlap guard (recursive self-scheduling: the
 * next tick is only scheduled once the current one has settled) means a slow
 * or hung tick simply delays the next one rather than running concurrently
 * with it.
 */
import { detectAndSyncChangedClients } from "./services/dnc-sync.service";
import { runPurge, purgeOptionsFromEnv } from "./services/phoneburner-purge.service";

/** Deploys shouldn't be hammered by a detector tick the instant they boot. */
const FIRST_TICK_DELAY_MS = 2 * 60 * 1000;

let timer: ReturnType<typeof setTimeout> | null = null;
/** True once startScheduler has run and stopScheduler hasn't been called since. */
let started = false;
/** Belt-and-suspenders overlap guard alongside the self-rescheduling design (see module doc). */
let ticking = false;

function detectorEnabled(): boolean {
  return process.env.DETECTOR_ENABLED === "true";
}

function intervalMinutes(): number {
  const n = Number(process.env.DETECTOR_INTERVAL_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/** Run one detect+targeted-purge cycle. Never throws/rejects. */
async function tick(): Promise<void> {
  if (ticking) {
    console.log("[scheduler] previous tick still running — skipping this tick.");
    return;
  }
  ticking = true;
  try {
    const detect = await detectAndSyncChangedClients();
    const changedCount = detect.changed.filter((c) => c.changed).length;

    const purge = await runPurge({ ...purgeOptionsFromEnv(), mode: "targeted" });
    const t = purge.totals;

    console.log(
      `[scheduler] tick: checked ${detect.checked} client(s), ${changedCount} changed; ` +
        `purge ${purge.status} — ${t.deleted} ${purge.dry_run ? "would-delete" : "deleted"}, ${t.failed} failed.`
    );
  } catch (err: any) {
    // A tick failure must never crash the web service or surface as an
    // unhandled rejection — log and let the next tick try again.
    console.error("[scheduler] tick failed:", err?.message || err);
  } finally {
    ticking = false;
  }
}

function scheduleNext(delayMs: number): void {
  timer = setTimeout(() => {
    timer = null;
    void tick().finally(() => {
      if (started) scheduleNext(intervalMinutes() * 60 * 1000);
    });
  }, delayMs);
}

/**
 * Start the hourly detector. No-op unless `DETECTOR_ENABLED === "true"`.
 * Safe to call more than once (a second call while already started is a
 * no-op). First tick fires `FIRST_TICK_DELAY_MS` after this call, then every
 * `DETECTOR_INTERVAL_MINUTES`.
 */
export function startScheduler(): void {
  if (!detectorEnabled()) {
    console.log('[scheduler] DETECTOR_ENABLED is not "true" — hourly detector disabled.');
    return;
  }
  if (started) return;
  started = true;
  console.log(
    `[scheduler] hourly detector enabled — first tick in ${FIRST_TICK_DELAY_MS / 60000}min, ` +
      `then every ${intervalMinutes()}min.`
  );
  scheduleNext(FIRST_TICK_DELAY_MS);
}

/** Stop the scheduler and clear any pending timer. Idempotent. */
export function stopScheduler(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
