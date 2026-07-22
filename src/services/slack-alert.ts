/**
 * src/services/slack-alert.ts — minimal Slack ops alerting for this service.
 *
 * Posts a Block Kit message to the ops channel via chat.postMessage. Mirrors
 * the GTMOS `lib/ops/slack-alert.ts` convention (same TAM bot, same
 * #gtmos-ops-alerts channel) so PhoneBurner-purge ceiling hits land alongside
 * GTMOS pipeline alerts, giving the team one place to watch.
 *
 * Env:
 *   SLACK_BOT_TOKEN             — required to post (silently no-ops without it)
 *   OPS_ALERT_SLACK_CHANNEL_ID  — override the default channel
 *   OPS_ALERT_SLACK_ENABLED     — "false" disables (default on)
 *
 * The bot must be invited to the channel (`/invite @<bot>`).
 *
 * NEVER throws — an alerting failure must not fail the purge it is reporting on.
 */
import type { PurgeRunSummary } from "./phoneburner-purge.service";

/** #gtmos-ops-alerts in the TAM to Target workspace. */
export const DEFAULT_CHANNEL_ID = "C0BGNP8EAQY";
const POST_TIMEOUT_MS = 8_000;

export interface SlackPostResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** Post a Block Kit message. Returns a result instead of throwing. */
export async function postSlackMessage(
  channel: string,
  blocks: unknown[],
  text: string
): Promise<SlackPostResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { ok: false, status: 0, error: "no_token" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text, blocks }),
      signal: ctrl.signal,
    });
    const body: any = await res.json().catch(() => ({}));
    return {
      ok: res.ok && body?.ok === true,
      status: res.status,
      error: body?.ok ? undefined : body?.error,
    };
  } catch (err: any) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export interface RatioCeilingHit {
  client: string;
  pb_member_id: string;
  pb_username: string | null;
  contacts_scanned: number;
  collisions: number;
  ratio: number | null;
  mode?: string;
}

/** Pull every member across the run that the ratio ceiling aborted. */
export function collectRatioCeilingHits(summary: PurgeRunSummary): RatioCeilingHit[] {
  const hits: RatioCeilingHit[] = [];
  for (const c of summary.clients) {
    for (const m of c.members) {
      if (m.status !== "aborted_ratio") continue;
      hits.push({
        client: c.client_external_id,
        pb_member_id: m.pb_member_id,
        pb_username: m.pb_username,
        contacts_scanned: m.contacts_scanned,
        collisions: m.collisions,
        ratio: m.ratio ?? (m.contacts_scanned > 0 ? m.collisions / m.contacts_scanned : null),
        mode: m.mode,
      });
    }
  }
  return hits;
}

/** Build the Block Kit payload for a ratio-ceiling alert (exported for tests). */
export function buildRatioCeilingBlocks(
  summary: PurgeRunSummary,
  maxRatio: number,
  hits: RatioCeilingHit[]
): { text: string; blocks: unknown[] } {
  const title = `PhoneBurner DNC purge hit the ${pct(maxRatio)} ratio ceiling`;
  const runMode = summary.dry_run ? "dry-run (no deletes)" : "LIVE";
  const memberLines = hits.map((h) => {
    const who = h.pb_username ? h.pb_username : `member ${h.pb_member_id}`;
    const r = h.ratio != null ? pct(h.ratio) : "n/a";
    return (
      `• *${h.client}* — ${who} (PB ${h.pb_member_id}): *${r}* of book on DNC ` +
      `— ${h.collisions} collisions / ${h.contacts_scanned} scanned → *aborted, 0 deleted*`
    );
  });
  const text = `:rotating_light: ${title} — ${hits.length} SDR book(s) aborted`;
  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: `:rotating_light: *${title}*` } },
    { type: "section", text: { type: "mrkdwn", text: memberLines.join("\n") } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*What this means:* each SDR above has more than ${pct(maxRatio)} of their live ` +
          `PhoneBurner book colliding with the client's DNC list, so the purge *aborted that ` +
          `book and deleted nothing* (hard safety ceiling). No data was lost.`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Action:* check whether the DNC list is over-broad or the SDR is dialing suppressed ` +
          `accounts. If suppression is intended, re-run the purge for that client after ` +
          `confirming; otherwise fix the list before the next run.`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `DNC purge · run ${summary.run_id} · ${runMode} · ceiling ${pct(maxRatio)}`,
        },
      ],
    },
  ];
  return { text, blocks };
}

/**
 * Post a Slack alert if any member's book was aborted by the ratio ceiling.
 * One consolidated message per run (the purge runs once nightly). No-op when
 * nothing hit the ceiling, Slack is disabled, or no bot token is configured.
 */
export async function sendRatioCeilingAlert(
  summary: PurgeRunSummary,
  maxRatio: number
): Promise<void> {
  try {
    if (process.env.OPS_ALERT_SLACK_ENABLED === "false") return;
    if (!process.env.SLACK_BOT_TOKEN) return; // not configured in this env

    const hits = collectRatioCeilingHits(summary);
    if (!hits.length) return;

    const channel = process.env.OPS_ALERT_SLACK_CHANNEL_ID ?? DEFAULT_CHANNEL_ID;
    const { text, blocks } = buildRatioCeilingBlocks(summary, maxRatio, hits);
    const res = await postSlackMessage(channel, blocks, text);
    if (!res.ok) {
      console.error(
        `[slack-alert] ratio-ceiling post failed: ${res.status} ${res.error ?? ""}`
      );
    } else {
      console.log(
        `[slack-alert] ratio-ceiling alert posted for ${hits.length} member(s) to ${channel}`
      );
    }
  } catch (err) {
    // Alerting must never break the purge.
    console.error("[slack-alert] error:", err);
  }
}
