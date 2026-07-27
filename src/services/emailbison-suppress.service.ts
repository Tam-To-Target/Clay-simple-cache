/**
 * EmailBison DNC suppression — the email-channel analog of the PhoneBurner purge.
 *
 * Every DNC event (a HubSpot DNC list add or POST /admin/dnc/import) lands a
 * normalized row in `dnc_entries` with a load-bearing `created_at`. This service
 * pushes each client's newly-DNC'd emails + domains into that client's EmailBison
 * workspace "Block List", so the contact stops receiving cold email.
 *
 * ADD-ONLY, watermark-driven (product decision 2026-07-27): we never read the
 * (huge, per_page=15) remote blocklist. We query `dnc_entries` newer than the
 * workspace's `suppressed_through` watermark and POST each one; the API's 422
 * "already been taken" makes any re-push a harmless no-op success. The watermark
 * advances only on a run with zero failures (mirrors the PB purge discipline), so
 * a transient failure just gets retried (and the already-done ones 422) next run.
 *
 * Unlike the PhoneBurner purge there is NO identity index, full scan, ratio
 * ceiling, or shared-book guard — EmailBison workspaces are strictly per-client
 * and suppression is an idempotent add to a durable list.
 *
 * Gated: the triggers only call this when EMAILBISON_SUPPRESS_ENABLED === "true".
 * Dry-run by default (EMAILBISON_SUPPRESS_DRY_RUN, default true) unless overridden.
 */
import { randomUUID } from "crypto";
import prisma from "../db/prisma";
import { getWorkspaceKey } from "./emailbison-token.service";
import { suppressEmail, suppressDomain, mapLimit, SuppressResult } from "./emailbison.service";
import { postSlackMessage, DEFAULT_CHANNEL_ID } from "./slack-alert";

export interface EmailbisonSuppressOptions {
  /** "auto" (daily) / "targeted" (hourly) are informational; behavior is identical. */
  mode?: "auto" | "targeted";
  /** Override the env default (EMAILBISON_SUPPRESS_DRY_RUN, default true). */
  dryRun?: boolean;
}

export type WorkspaceStatus =
  | "ok"
  | "skipped_no_new"
  | "skipped_no_key"
  | "partial"; // some identifiers failed → watermark NOT advanced

export interface WorkspaceResult {
  client_external_id: string;
  client_name: string;
  workspace_id: number;
  status: WorkspaceStatus;
  emails: { added: number; already: number; failed: number };
  domains: { added: number; already: number; failed: number };
  watermark_advanced: boolean;
}

export interface EmailbisonSuppressSummary {
  run_id: string;
  dry_run: boolean;
  workspaces: WorkspaceResult[];
  totals: {
    workspaces_processed: number;
    workspaces_skipped: number;
    added: number;
    already_present: number;
    failed: number;
  };
  status: "ok" | "partial";
}

function dryRunFromEnv(override?: boolean): boolean {
  if (typeof override === "boolean") return override;
  // Default TRUE — a live run must be explicitly requested.
  return process.env.EMAILBISON_SUPPRESS_DRY_RUN !== "false";
}

/** Run EmailBison suppression for one client (by external_id) or all eligible. */
export async function runEmailbisonSuppress(
  opts: EmailbisonSuppressOptions = {},
  onlySlug?: string
): Promise<EmailbisonSuppressSummary> {
  const dryRun = dryRunFromEnv(opts.dryRun);
  const run_id = randomUUID();

  const clients = await prisma.client.findMany({
    where: {
      active: true,
      ...(onlySlug ? { external_id: onlySlug } : {}),
      emailbison_workspaces: { some: { active: true } },
    },
    include: { emailbison_workspaces: { where: { active: true } } },
  });

  const results: WorkspaceResult[] = [];

  for (const client of clients) {
    for (const ws of client.emailbison_workspaces) {
      const base: WorkspaceResult = {
        client_external_id: client.external_id,
        client_name: client.name,
        workspace_id: ws.workspace_id,
        status: "ok",
        emails: { added: 0, already: 0, failed: 0 },
        domains: { added: 0, already: 0, failed: 0 },
        watermark_advanced: false,
      };

      const watermark = ws.suppressed_through ?? new Date(0);
      // Capture BEFORE the query: an entry inserted mid-run must stay above the
      // new watermark, or a concurrent sync could slip a row into the gap.
      const queriedAt = new Date();
      const newEntries = await prisma.dncEntry.findMany({
        where: { client_id: client.id, created_at: { gt: watermark } },
        select: { email: true, domain: true, created_at: true },
      });

      if (newEntries.length === 0) {
        if (!dryRun) {
          await prisma.emailbisonWorkspace.update({
            where: { id: ws.id },
            data: { suppressed_through: queriedAt, last_run_at: new Date(), last_run_status: "skipped_no_new" },
          });
        }
        results.push({ ...base, status: "skipped_no_new", watermark_advanced: !dryRun });
        continue;
      }

      // Dedupe identifiers + track the high-watermark of what we're about to push.
      const emails = new Set<string>();
      const domains = new Set<string>();
      let maxCreatedAt = watermark;
      for (const e of newEntries) {
        if (e.email) emails.add(e.email);
        if (e.domain) domains.add(e.domain);
        if (e.created_at > maxCreatedAt) maxCreatedAt = e.created_at;
      }

      const key = dryRun ? "DRY_RUN" : await getWorkspaceKey(ws.workspace_id);
      if (!dryRun && !key) {
        // GTMOS has no key for this workspace — skip, do NOT advance the watermark.
        await prisma.emailbisonWorkspace.update({
          where: { id: ws.id },
          data: { last_run_at: new Date(), last_run_status: "skipped_no_key" },
        });
        results.push({ ...base, status: "skipped_no_key" });
        continue;
      }

      const emailList = [...emails];
      const domainList = [...domains];

      if (dryRun) {
        // Compute + log only. No POSTs, no audit rows (a first backfill can be
        // large), no watermark advance — so the same set re-runs when live.
        base.emails.added = emailList.length;
        base.domains.added = domainList.length;
        console.log(
          `[emailbison-suppress] DRY-RUN ${client.external_id} ws ${ws.workspace_id}: ` +
            `would suppress ${emailList.length} email(s) + ${domainList.length} domain(s)`
        );
        results.push({ ...base, status: "ok", watermark_advanced: false });
        continue;
      }

      // ---- Live: single POST per identifier, bounded concurrency ----
      const auditRows: {
        client_id: string;
        workspace_id: number;
        type: string;
        value: string;
        provider_id: number | null;
        status: string;
        http_status: number | null;
        error: string | null;
        run_id: string;
      }[] = [];

      const tally = (
        kind: "email" | "domain",
        value: string,
        r: SuppressResult,
        bucket: { added: number; already: number; failed: number }
      ) => {
        if (r.status === "added") bucket.added++;
        else if (r.status === "already_present") bucket.already++;
        else bucket.failed++;
        auditRows.push({
          client_id: client.id,
          workspace_id: ws.workspace_id,
          type: kind === "email" ? "EMAIL" : "DOMAIN",
          value,
          provider_id: r.providerId ?? null,
          status: r.status,
          http_status: r.httpStatus || null,
          error: r.error ?? null,
          run_id,
        });
      };

      const emailResults = await mapLimit(emailList, (email) => suppressEmail(key!, email));
      emailResults.forEach((r, i) => tally("email", emailList[i], r, base.emails));

      const domainResults = await mapLimit(domainList, (domain) => suppressDomain(key!, domain));
      domainResults.forEach((r, i) => tally("domain", domainList[i], r, base.domains));

      // Persist audit rows in chunks (keeps a single insert bounded).
      for (let i = 0; i < auditRows.length; i += 500) {
        await prisma.emailbisonSuppression.createMany({ data: auditRows.slice(i, i + 500) });
      }

      const failed = base.emails.failed + base.domains.failed;
      const advance = failed === 0;
      await prisma.emailbisonWorkspace.update({
        where: { id: ws.id },
        data: {
          // Advance ONLY on a clean run — else re-attempt next run (dups 422 = ok).
          ...(advance ? { suppressed_through: maxCreatedAt } : {}),
          emails_suppressed: { increment: base.emails.added + base.emails.already },
          domains_suppressed: { increment: base.domains.added + base.domains.already },
          last_run_at: new Date(),
          last_run_status: advance ? "ok" : "partial",
        },
      });

      results.push({ ...base, status: advance ? "ok" : "partial", watermark_advanced: advance });
      console.log(
        `[emailbison-suppress] ${client.external_id} ws ${ws.workspace_id}: ` +
          `emails +${base.emails.added}/~${base.emails.already}/✗${base.emails.failed}, ` +
          `domains +${base.domains.added}/~${base.domains.already}/✗${base.domains.failed}` +
          `${advance ? "" : " (watermark held — retry next run)"}`
      );
    }
  }

  const totals = results.reduce(
    (acc, r) => {
      const skipped = r.status === "skipped_no_new" || r.status === "skipped_no_key";
      if (skipped) acc.workspaces_skipped++;
      else acc.workspaces_processed++;
      acc.added += r.emails.added + r.domains.added;
      acc.already_present += r.emails.already + r.domains.already;
      acc.failed += r.emails.failed + r.domains.failed;
      return acc;
    },
    { workspaces_processed: 0, workspaces_skipped: 0, added: 0, already_present: 0, failed: 0 }
  );

  const status: "ok" | "partial" = totals.failed > 0 ? "partial" : "ok";
  const summary: EmailbisonSuppressSummary = { run_id, dry_run: dryRun, workspaces: results, totals, status };

  await sendFailureAlert(summary);
  return summary;
}

/** Post a Slack alert only when identifiers failed to suppress. Never throws. */
async function sendFailureAlert(summary: EmailbisonSuppressSummary): Promise<void> {
  try {
    if (summary.dry_run || summary.totals.failed === 0) return;
    const offenders = summary.workspaces.filter((w) => w.emails.failed + w.domains.failed > 0);
    const lines = offenders
      .map(
        (w) =>
          `• *${w.client_external_id}* ws ${w.workspace_id}: ${w.emails.failed} email + ${w.domains.failed} domain failed`
      )
      .join("\n");
    const text = `EmailBison suppression: ${summary.totals.failed} identifier(s) failed`;
    await postSlackMessage(
      process.env.OPS_ALERT_SLACK_CHANNEL_ID || DEFAULT_CHANNEL_ID,
      [
        { type: "header", text: { type: "plain_text", text: "⚠️ EmailBison suppression failures" } },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              `run \`${summary.run_id}\` — ${summary.totals.failed} failed ` +
              `(${summary.totals.added} added, ${summary.totals.already_present} already suppressed).\n` +
              `Watermark held for these workspaces — they'll retry next run.\n${lines}`,
          },
        },
      ],
      text
    );
  } catch (err: any) {
    console.error("[emailbison-suppress] slack alert failed:", err?.message || err);
  }
}
