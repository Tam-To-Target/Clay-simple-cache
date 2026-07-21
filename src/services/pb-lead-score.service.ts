/**
 * PhoneBurner "Lead Score" issuance — owned entirely by this service.
 *
 * A Lead Score (e.g. "club8") is the per-list identifier the dialing org uses so
 * one uploaded list never mixes with another. The account convention is a stable
 * per-client PREFIX + an incrementing number. We seed the ledger from GTMOS call
 * history once (scripts/backfill-pb-convention.ts) and then mint the next value
 * HERE, recording each issuance — so a just-uploaded-but-not-yet-dialed list is
 * still counted (unlike deriving "next" from call history alone, which only sees
 * dialed contacts).
 */

import prisma from "../db/prisma";
import type { Client, PbLeadScore } from "@prisma/client";

export interface LeadScore {
  prefix: string;
  seq: number;
  value: string;
}

/** Split "club8" → { prefix: "club", seq: 8 }. Returns null if there's no
 *  trailing number (an unparseable/free-form score we can't increment). */
export function parseLeadScore(value: string): { prefix: string; seq: number } | null {
  const m = /^(.*?)(\d+)$/.exec(value.trim());
  if (!m) return null;
  const seq = Number(m[2]);
  if (!Number.isFinite(seq)) return null;
  return { prefix: m[1], seq };
}

/** Fallback prefix when the client has no history at all: prefer the seeded
 *  prefix, else the client tag, else the slug — always lowercased, letters only. */
export function derivePrefix(client: Pick<Client, "pb_lead_score_prefix" | "pb_client_tag" | "external_id">): string {
  const raw =
    client.pb_lead_score_prefix?.trim() ||
    client.pb_client_tag?.trim() ||
    client.external_id;
  const cleaned = raw.toLowerCase().replace(/[^a-z]/g, "");
  return cleaned || "list";
}

/** The prefix used by the most ledger rows (case-insensitive group), returning
 *  the most common verbatim casing so new values match the account's convention. */
function dominantPrefix(rows: Pick<PbLeadScore, "prefix">[]): string | null {
  if (rows.length === 0) return null;
  const byKey = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const key = r.prefix.toLowerCase();
    const variants = byKey.get(key) ?? new Map<string, number>();
    variants.set(r.prefix, (variants.get(r.prefix) ?? 0) + 1);
    byKey.set(key, variants);
  }
  // Winning key = the one with the most rows overall.
  let bestKey = "";
  let bestCount = -1;
  for (const [key, variants] of byKey) {
    const count = [...variants.values()].reduce((a, b) => a + b, 0);
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  // Within the winning key, the most common verbatim casing.
  const variants = byKey.get(bestKey)!;
  let bestVariant = bestKey;
  let vc = -1;
  for (const [variant, count] of variants) {
    if (count > vc) {
      vc = count;
      bestVariant = variant;
    }
  }
  return bestVariant;
}

export interface LeadScoreDeps {
  findLedger?: (clientId: string) => Promise<Pick<PbLeadScore, "prefix" | "seq">[]>;
}

/**
 * Compute (without recording) the next Lead Score for a client: dominant
 * historical prefix + (max seq for that prefix) + 1, or prefix+"1" if no history.
 */
export async function peekNextLeadScore(client: Client, deps?: LeadScoreDeps): Promise<LeadScore> {
  const rows = deps?.findLedger
    ? await deps.findLedger(client.id)
    : await prisma.pbLeadScore.findMany({
        where: { client_id: client.id },
        select: { prefix: true, seq: true },
      });

  const prefix = client.pb_lead_score_prefix?.trim() || dominantPrefix(rows) || derivePrefix(client);
  const prefixKey = prefix.toLowerCase();
  const maxSeq = rows
    .filter((r) => r.prefix.toLowerCase() === prefixKey)
    .reduce((max, r) => Math.max(max, r.seq), 0);
  const seq = maxSeq + 1;
  return { prefix, seq, value: `${prefix}${seq}` };
}

/**
 * Mint AND record the next Lead Score. Retries on a unique-collision (a
 * concurrent issue for the same client) by re-peeking. Falls back to a suffixed
 * value if the parsed prefix somehow keeps colliding.
 */
export async function issueLeadScore(
  client: Client,
  opts?: { campaign?: string | null },
  deps?: LeadScoreDeps
): Promise<LeadScore> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = await peekNextLeadScore(client, deps);
    try {
      await prisma.pbLeadScore.create({
        data: {
          client_id: client.id,
          lead_score: next.value,
          prefix: next.prefix,
          seq: next.seq,
          source: "issued",
          campaign: opts?.campaign ?? null,
        },
      });
      return next;
    } catch (e: any) {
      // P2002 = unique violation on (client_id, lead_score) — someone took it; retry.
      if (e?.code === "P2002") continue;
      throw e;
    }
  }
  throw new Error(`Could not mint a unique Lead Score for client ${client.external_id} after retries`);
}

/**
 * Record a caller-supplied Lead Score verbatim (idempotent). Used when the
 * upload caller overrides auto-issue. Unparseable values are stored with seq 0
 * so they don't perturb the increment sequence.
 */
export async function recordLeadScore(
  client: Client,
  value: string,
  opts?: { campaign?: string | null; source?: string }
): Promise<void> {
  const parsed = parseLeadScore(value);
  await prisma.pbLeadScore.upsert({
    where: { client_id_lead_score: { client_id: client.id, lead_score: value } },
    update: {},
    create: {
      client_id: client.id,
      lead_score: value,
      prefix: parsed?.prefix ?? value,
      seq: parsed?.seq ?? 0,
      source: opts?.source ?? "issued",
      campaign: opts?.campaign ?? null,
    },
  });
}
