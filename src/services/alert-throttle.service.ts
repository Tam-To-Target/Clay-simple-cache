/**
 * DB-backed once-per-window alert throttle.
 *
 * This service has no Redis, and both the daily `ops:daily` cron and the hourly
 * `scheduler` detector can each hit a Slack-alerting condition — so without a
 * throttle the same alert fires up to hourly. `shouldSendAlert(key)` returns
 * true AT MOST ONCE per window (default 24h) per key; the caller posts only when
 * it returns true.
 *
 * Race-safe across the two runners via a conditional `updateMany` (claim an
 * expired row atomically) + a unique-key `create` (first alert). Fails OPEN on
 * an unexpected DB error — better to over-alert than to silently swallow a real
 * problem (and it also means the alert keeps working before the table exists on
 * a fresh deploy, just un-throttled).
 */
import prisma from "../db/prisma";

function defaultWindowHours(): number {
  const raw = Number(process.env.ALERT_THROTTLE_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

export async function shouldSendAlert(
  key: string,
  windowHours: number = defaultWindowHours()
): Promise<boolean> {
  const now = new Date();
  const threshold = new Date(now.getTime() - windowHours * 3_600_000);
  try {
    // If a row exists and its last send is older than the window, claim it.
    const advanced = await prisma.alertThrottle.updateMany({
      where: { key, last_sent_at: { lt: threshold } },
      data: { last_sent_at: now },
    });
    if (advanced.count > 0) return true;

    // No row advanced → either it doesn't exist yet, or it's within the window.
    try {
      await prisma.alertThrottle.create({ data: { key, last_sent_at: now } });
      return true; // first alert for this key
    } catch (e: any) {
      if (e?.code === "P2002") return false; // row exists & still within window → muted
      throw e;
    }
  } catch (e: any) {
    // Fail open — never let the throttle suppress a real alert on a DB hiccup.
    console.error("[alert-throttle] error, allowing alert:", e?.message || e);
    return true;
  }
}
