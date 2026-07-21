/**
 * ONE-TIME backfill of each client's PhoneBurner list convention from GTMOS.
 *
 * The upload endpoint owns Lead Score issuance and the client tag going forward,
 * but it needs a starting point so the FIRST minted Lead Score doesn't collide
 * with a list already in the dialer. This reads GTMOS's `calls` history (direct
 * DB via SDR_LAUNCH_DATABASE_URL — a deliberate one-time read, not a runtime
 * dependency) and seeds our tables:
 *   - clients.pb_client_tag         ← most frequent non-campaign tag on the client's calls
 *   - clients.pb_lead_score_prefix  ← dominant prefix of historical Lead Scores
 *   - pb_lead_scores (source=backfill) ← every distinct historical Lead Score
 *
 * After this runs, the service never needs GTMOS again for uploads.
 *
 * Usage:
 *   npm run pb:backfill-convention            # dry run — prints what it WOULD write
 *   npm run pb:backfill-convention -- --apply # write to our DB
 *   npm run pb:backfill-convention -- --apply <slug>   # a single client
 */
import dotenv from "dotenv";
dotenv.config();

import { Client as PgClient } from "pg";
import prisma from "../db/prisma";
import { parseLeadScore } from "../services/pb-lead-score.service";
import { gtmosSlugFor } from "../config/slug-aliases";

/** A real Lead Score is a short alphanumeric token with a trailing number
 *  (e.g. "CLUB7"). Reject polluted values — URLs, free text, absurd length —
 *  that occasionally land in the custom field (e.g. a pasted dialer link). */
function isPlausibleLeadScore(v: string): boolean {
  return /^[A-Za-z0-9._-]{1,16}$/.test(v) && /\d/.test(v);
}

interface GtmosClientRow {
  id: string;
  slug: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const onlySlug = args.find((a) => !a.startsWith("--"));

  const url = process.env.SDR_LAUNCH_DATABASE_URL;
  if (!url) throw new Error("SDR_LAUNCH_DATABASE_URL is not set (needed to read GTMOS call history)");

  const gtmos = new PgClient({ connectionString: url });
  await gtmos.connect();

  try {
    // Our clients (the ones we actually upload for).
    const ourClients = await prisma.client.findMany({
      where: onlySlug ? { external_id: onlySlug } : undefined,
      select: { id: true, external_id: true, name: true },
      orderBy: { external_id: "asc" },
    });

    // GTMOS client slug → id.
    const gtmosRows = (await gtmos.query<GtmosClientRow>(`SELECT id, slug FROM clients`)).rows;
    const gtmosBySlug = new Map(gtmosRows.map((r) => [r.slug, r.id]));

    console.log(`\nPhoneBurner convention backfill — ${apply ? "APPLY" : "DRY RUN"}\n`);
    console.log("client".padEnd(22), "clientTag".padEnd(18), "prefix".padEnd(10), "leadScores");
    console.log("-".repeat(80));

    let touched = 0;
    for (const c of ourClients) {
      const gid = gtmosBySlug.get(c.external_id) ?? gtmosBySlug.get(gtmosSlugFor(c.external_id));
      if (!gid) {
        console.log(c.external_id.padEnd(22), "(no GTMOS client for slug — skipped)");
        continue;
      }

      // Distinct historical Lead Scores.
      const lsRows = (
        await gtmos.query<{ ls: string }>(
          `SELECT DISTINCT custom_fields_snapshot->>'Lead Score' AS ls
             FROM calls
            WHERE client_id = $1
              AND coalesce(custom_fields_snapshot->>'Lead Score','') <> ''`,
          [gid]
        )
      ).rows.map((r) => r.ls.trim()).filter((v) => v && isPlausibleLeadScore(v));

      // Tag frequencies + the campaign values to exclude.
      const tagRows = (
        await gtmos.query<{ tag: string; n: string }>(
          `SELECT tag, count(*)::text AS n
             FROM calls, jsonb_array_elements_text(tags_snapshot) AS tag
            WHERE client_id = $1
            GROUP BY tag
            ORDER BY count(*) DESC`,
          [gid]
        )
      ).rows;
      const campaignRows = (
        await gtmos.query<{ campaign_snapshot: string | null }>(
          `SELECT DISTINCT campaign_snapshot FROM calls WHERE client_id = $1`,
          [gid]
        )
      ).rows;
      const campaigns = new Set(campaignRows.map((r) => (r.campaign_snapshot ?? "").trim()).filter(Boolean));

      // Client tag = most frequent tag that isn't a campaign and isn't a
      // combined "Client: Campaign" tag.
      const clientTag =
        tagRows.find((t) => t.tag && !campaigns.has(t.tag) && !t.tag.includes(":"))?.tag ?? null;

      // Parse lead scores; dominant prefix (case-insensitive) wins.
      const parsed = lsRows.map((ls) => ({ ls, p: parseLeadScore(ls) })).filter((x) => x.p);
      const prefixCounts = new Map<string, number>();
      for (const { p } of parsed) {
        const key = p!.prefix.toLowerCase();
        prefixCounts.set(key, (prefixCounts.get(key) ?? 0) + 1);
      }
      let prefix: string | null = null;
      let best = -1;
      for (const { p } of parsed) {
        const key = p!.prefix.toLowerCase();
        const count = prefixCounts.get(key)!;
        if (count > best) {
          best = count;
          prefix = p!.prefix;
        }
      }

      console.log(
        c.external_id.padEnd(22),
        (clientTag ?? "-").padEnd(18),
        (prefix ?? "-").padEnd(10),
        lsRows.length ? lsRows.join(", ") : "(none)"
      );

      if (apply) {
        await prisma.client.update({
          where: { id: c.id },
          data: {
            ...(clientTag ? { pb_client_tag: clientTag } : {}),
            ...(prefix ? { pb_lead_score_prefix: prefix } : {}),
          },
        });
        for (const { ls, p } of parsed) {
          await prisma.pbLeadScore.upsert({
            where: { client_id_lead_score: { client_id: c.id, lead_score: ls } },
            update: {},
            create: {
              client_id: c.id,
              lead_score: ls,
              prefix: p!.prefix,
              seq: p!.seq,
              source: "backfill",
            },
          });
        }
      }
      touched++;
    }

    console.log("-".repeat(80));
    console.log(`${touched} client(s) processed. ${apply ? "Written." : "Dry run — re-run with --apply to write."}\n`);
  } finally {
    await gtmos.end();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
