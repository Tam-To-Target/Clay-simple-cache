import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  collectRatioCeilingHits,
  buildRatioCeilingBlocks,
  sendRatioCeilingAlert,
  DEFAULT_CHANNEL_ID,
} from "../../src/services/slack-alert";
import type { PurgeRunSummary } from "../../src/services/phoneburner-purge.service";

function summary(overrides: Partial<PurgeRunSummary> = {}): PurgeRunSummary {
  return {
    run_id: "run-123",
    dry_run: true,
    status: "ok",
    totals: {
      clients_processed: 1,
      members_processed: 1,
      members_skipped: 1,
      contacts_scanned: 334,
      collisions_found: 79,
      deleted: 26,
      failed: 0,
      protected_other_client: 0,
      protected_recent_meeting: 0,
      protected_read_errors: 0,
      targeted_members: 0,
      full_scan_members: 2,
    },
    clients: [
      {
        client_external_id: "brainpop",
        client_name: "BrainPOP",
        members: [
          {
            pb_member_id: "1285815280",
            pb_username: "ava@tamtotarget.com",
            status: "aborted_ratio",
            contacts_scanned: 164,
            collisions: 53,
            deleted: 0,
            failed: 0,
            mode: "full",
            ratio: 53 / 164,
          },
          {
            pb_member_id: "1291285814",
            pb_username: "sam@tamtotarget.com",
            status: "ok",
            contacts_scanned: 170,
            collisions: 26,
            deleted: 26,
            failed: 0,
            mode: "full",
          },
        ],
      },
    ],
    ...overrides,
  };
}

const OLD_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("collectRatioCeilingHits", () => {
  it("returns only aborted_ratio members with a computed ratio", () => {
    const hits = collectRatioCeilingHits(summary());
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      client: "brainpop",
      pb_member_id: "1285815280",
      pb_username: "ava@tamtotarget.com",
      contacts_scanned: 164,
      collisions: 53,
    });
    expect(hits[0].ratio).toBeCloseTo(53 / 164, 5);
  });

  it("falls back to collisions/scanned when ratio field is absent", () => {
    const s = summary();
    delete (s.clients[0].members[0] as any).ratio;
    const hits = collectRatioCeilingHits(s);
    expect(hits[0].ratio).toBeCloseTo(53 / 164, 5);
  });

  it("is empty when nothing hit the ceiling", () => {
    const s = summary();
    s.clients[0].members[0].status = "ok";
    expect(collectRatioCeilingHits(s)).toHaveLength(0);
  });
});

describe("buildRatioCeilingBlocks", () => {
  it("includes ceiling %, per-member details, and run context", () => {
    const hits = collectRatioCeilingHits(summary());
    const { text, blocks } = buildRatioCeilingBlocks(summary(), 0.3, hits);
    const rendered = JSON.stringify(blocks);
    expect(text).toContain("30.0%");
    expect(rendered).toContain("brainpop");
    expect(rendered).toContain("ava@tamtotarget.com");
    expect(rendered).toContain("32.3%"); // 53/164
    expect(rendered).toContain("53 collisions / 164 scanned");
    expect(rendered).toContain("aborted, 0 deleted");
    expect(rendered).toContain("run-123");
    expect(rendered).toContain("dry-run");
  });

  it("labels live runs distinctly", () => {
    const s = summary({ dry_run: false });
    const { blocks } = buildRatioCeilingBlocks(s, 0.3, collectRatioCeilingHits(s));
    expect(JSON.stringify(blocks)).toContain("LIVE");
  });
});

describe("sendRatioCeilingAlert", () => {
  beforeEach(() => {
    delete process.env.OPS_ALERT_SLACK_ENABLED;
    delete process.env.OPS_ALERT_SLACK_CHANNEL_ID;
  });

  it("no-ops (no fetch) when SLACK_BOT_TOKEN is unset", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendRatioCeilingAlert(summary(), 0.3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no-ops when OPS_ALERT_SLACK_ENABLED=false", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.OPS_ALERT_SLACK_ENABLED = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendRatioCeilingAlert(summary(), 0.3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT post when no member hit the ceiling", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const s = summary();
    s.clients[0].members[0].status = "ok";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendRatioCeilingAlert(s, 0.3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to chat.postMessage on the default channel when the ceiling is hit", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendRatioCeilingAlert(summary(), 0.3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect((init.headers as any).Authorization).toBe("Bearer xoxb-test");
    const payload = JSON.parse(init.body);
    expect(payload.channel).toBe(DEFAULT_CHANNEL_ID);
    expect(JSON.stringify(payload.blocks)).toContain("ava@tamtotarget.com");
  });

  it("honors OPS_ALERT_SLACK_CHANNEL_ID override", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.OPS_ALERT_SLACK_CHANNEL_ID = "C_OVERRIDE";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await sendRatioCeilingAlert(summary(), 0.3);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.channel).toBe("C_OVERRIDE");
  });

  it("never throws when the Slack call fails", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(sendRatioCeilingAlert(summary(), 0.3)).resolves.toBeUndefined();
  });
});
