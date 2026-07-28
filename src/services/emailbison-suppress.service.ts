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
import { shouldSendAlert } from "./alert-throttle.service";

export interface EmailbisonSuppressOptions {
  /** "auto" (daily) / "targeted" (hourly) are informational; behavior is identical. */
  mode?: "auto" | "targeted";
  /** Override the env default (EMAILBISON_SUPPRESS_DRY_RUN, default true). */
  dryRun?: boolean;
  /**
   * Bypass the per-run safety cap (EMAILBISON_SUPPRESS_MAX_PER_RUN). Required to
   * push an anomalously large batch — e.g. the intentional first backfill of a
   * big client, or after reviewing a large DNC import. Never sourced from env
   * (mirrors the PB purge's overrideRatioCeiling: explicit, per-invocation).
   */
  overrideMax?: boolean;
}

export type WorkspaceStatus =
  | "ok"
  | "skipped_no_new"
  | "skipped_no_key"
  | "aborted_max" // new batch exceeded the per-run cap → nothing pushed, watermark held
  | "partial"; // some identifiers failed → watermark NOT advanced

export interface WorkspaceResult {
  client_external_id: string;
  client_name: string;
  workspace_id: number;
  workspace_name: string | null;
  status: WorkspaceStatus;
  emails: { added: number; already: number; invalid: number; failed: number };
  domains: { added: number; already: number; invalid: number; failed: number };
  watermark_advanced: boolean;
  /** On aborted_max: what the run WOULD have pushed (for the Slack alert). */
  capBlocked?: { emails: number; domains: number };
}

export interface EmailbisonSuppressSummary {
  run_id: string;
  dry_run: boolean;
  workspaces: WorkspaceResult[];
  totals: {
    workspaces_processed: number;
    workspaces_skipped: number;
    workspaces_aborted: number;
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

/**
 * Per-run, per-workspace safety cap on how many identifiers a single run may push.
 * Add-only suppression can't "delete a book" like the PB purge, so there's no
 * meaningful percentage; instead we halt on anomalous absolute volume (a bad bulk
 * DNC import) — protecting against mass over-suppression + API hammering. A run
 * over the cap is aborted for that workspace (nothing pushed, watermark held) and
 * Slack-alerted; re-run with overrideMax once reviewed. Default 5000; 0 disables.
 */
function maxPerRunFromEnv(): number {
  const raw = Number(process.env.EMAILBISON_SUPPRESS_MAX_PER_RUN);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
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
        workspace_name: ws.workspace_name ?? null,
        status: "ok",
        emails: { added: 0, already: 0, invalid: 0, failed: 0 },
        domains: { added: 0, already: 0, invalid: 0, failed: 0 },
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

      // Safety cap: halt an anomalously large batch (e.g. a bad bulk DNC import)
      // unless explicitly overridden. Non-destructive — nothing is pushed and the
      // watermark is held, so it retries once reviewed / re-run with overrideMax.
      const totalIdentifiers = emailList.length + domainList.length;
      const maxPerRun = maxPerRunFromEnv();
      if (maxPerRun > 0 && totalIdentifiers > maxPerRun && !opts.overrideMax) {
        if (!dryRun) {
          await prisma.emailbisonWorkspace.update({
            where: { id: ws.id },
            data: { last_run_at: new Date(), last_run_status: "aborted_max" },
          });
        }
        console.warn(
          `[emailbison-suppress] ${client.external_id} ws ${ws.workspace_id}: ` +
            `ABORTED — ${totalIdentifiers} identifiers > cap ${maxPerRun} ` +
            `(${emailList.length} email + ${domainList.length} domain). Nothing pushed, ` +
            `watermark held. Re-run with overrideMax once reviewed.`
        );
        results.push({
          ...base,
          status: "aborted_max",
          watermark_advanced: false,
          capBlocked: { emails: emailList.length, domains: domainList.length },
        });
        continue;
      }

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
        bucket: { added: number; already: number; invalid: number; failed: number }
      ) => {
        if (r.status === "added") bucket.added++;
        else if (r.status === "already_present") bucket.already++;
        else if (r.status === "invalid") bucket.invalid++; // permanent skip — does NOT block the watermark
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
          `emails +${base.emails.added}/~${base.emails.already}/⊘${base.emails.invalid}/✗${base.emails.failed}, ` +
          `domains +${base.domains.added}/~${base.domains.already}/⊘${base.domains.invalid}/✗${base.domains.failed}` +
          `${advance ? "" : " (watermark held — retry next run)"}`
      );
    }
  }

  const totals = results.reduce(
    (acc, r) => {
      if (r.status === "aborted_max") acc.workspaces_aborted++;
      else if (r.status === "skipped_no_new" || r.status === "skipped_no_key") acc.workspaces_skipped++;
      else acc.workspaces_processed++;
      acc.added += r.emails.added + r.domains.added;
      acc.already_present += r.emails.already + r.domains.already;
      acc.failed += r.emails.failed + r.domains.failed;
      return acc;
    },
    { workspaces_processed: 0, workspaces_skipped: 0, workspaces_aborted: 0, added: 0, already_present: 0, failed: 0 }
  );

  // A cap-abort is an operational anomaly (needs review + override), so it makes
  // the run "partial" and triggers the alert alongside hard failures.
  const status: "ok" | "partial" =
    totals.failed > 0 || totals.workspaces_aborted > 0 ? "partial" : "ok";
  const summary: EmailbisonSuppressSummary = { run_id, dry_run: dryRun, workspaces: results, totals, status };

  await sendFailureAlert(summary);
  return summary;
}

/**
 * Dedicated EmailBison-suppression Slack alert (distinct from the PhoneBurner
 * ratio-ceiling alert). Fires on cap-aborts and/or hard failures — never on a
 * clean run, never on a dry-run. Never throws. Lists every affected workspace
 * with its counts, then explains + gives the action, PB-alert style.
 */
export async function sendFailureAlert(summary: EmailbisonSuppressSummary): Promise<void> {
  try {
    if (summary.dry_run) return;
    const aborted = summary.workspaces.filter((w) => w.status === "aborted_max");
    const failed = summary.workspaces.filter((w) => w.emails.failed + w.domains.failed > 0);
    if (aborted.length === 0 && failed.length === 0) return;

    // Once per day: the daily cron + hourly detector can both hit the cap.
    if (!(await shouldSendAlert("emailbison_suppress_cap"))) {
      console.log("[emailbison-suppress] alert muted (already sent within the throttle window)");
      return;
    }

    const cap = maxPerRunFromEnv();
    const nf = (n: number) => n.toLocaleString("en-US");

    const blocks: any[] = [
      {
        type: "header",
        text: { type: "plain_text", text: "🚨 EmailBison DNC suppression hit the per-run cap", emoji: true },
      },
    ];

    if (aborted.length > 0) {
      const lines = aborted
        .map((w) => {
          const e = w.capBlocked?.emails ?? 0;
          const d = w.capBlocked?.domains ?? 0;
          const label = w.workspace_name ? ` "${w.workspace_name}"` : "";
          return (
            `• *${w.client_external_id}* — ws ${w.workspace_id}${label}: ` +
            `${nf(e + d)} new DNC identifiers (${nf(e)} email + ${nf(d)} domain) ` +
            `> cap ${nf(cap)} → aborted, 0 suppressed`
          );
        })
        .join("\n");
      blocks.push({ type: "section", text: { type: "mrkdwn", text: lines } });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*What this means:* each workspace above had more than ${nf(cap)} new DNC identifiers ` +
            `queued in a single run, so suppression aborted that workspace and added *nothing* to its ` +
            `EmailBison blocklist (hard safety cap). No emails were suppressed; the watermark is held, ` +
            `so it retries next run.\n\n` +
            `*Action:* this is expected on a client's first backfill. If the volume is intended, re-run ` +
            `for that client with \`override_max: true\` (\`POST /admin/emailbison/suppress\`) or raise ` +
            `\`EMAILBISON_SUPPRESS_MAX_PER_RUN\`. Otherwise check for an over-broad DNC import before the next run.`,
        },
      });
    }

    if (failed.length > 0) {
      const lines = failed
        .map(
          (w) =>
            `• *${w.client_external_id}* — ws ${w.workspace_id}: ` +
            `${w.emails.failed} email + ${w.domains.failed} domain failed to suppress`
        )
        .join("\n");
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Hard failures* (watermark held, will retry):\n${lines}`,
        },
      });
    }

    const text =
      `EmailBison DNC suppression: ${summary.totals.workspaces_aborted} workspace(s) cap-aborted, ` +
      `${summary.totals.failed} identifier(s) failed`;
    await postSlackMessage(process.env.OPS_ALERT_SLACK_CHANNEL_ID || DEFAULT_CHANNEL_ID, blocks, text);
  } catch (err: any) {
    console.error("[emailbison-suppress] slack alert failed:", err?.message || err);
  }
}
