/**
 * Tiny fuzzy matcher used to suggest real client handles when a caller passes
 * an unknown client_id to /dnc-check. No dependencies — Levenshtein distance
 * plus a substring bonus, ranked, top-N.
 */

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export interface SuggestCandidate {
  /** The handle returned to the caller (e.g. the client slug). */
  id: string;
  /** Optional display name also matched against (e.g. "Awarded Software"). */
  name?: string | null;
}

/**
 * Rank candidates by similarity to `query` and return the closest `id`s.
 * A candidate matches on either its id or its name; the better of the two wins.
 */
export function suggestSimilar(
  query: string,
  candidates: SuggestCandidate[],
  limit = 3
): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored = candidates.map((c) => {
    const fields = [c.id, c.name ?? ""].map((f) => f.trim().toLowerCase()).filter(Boolean);
    let best = Infinity;
    for (const f of fields) {
      const dist = levenshtein(q, f);
      // Substring matches are strong signals — pull them to the front.
      const adjusted = f.includes(q) || q.includes(f) ? Math.min(dist, 1) : dist;
      best = Math.min(best, adjusted);
    }
    return { id: c.id, score: best, len: Math.max(c.id.length, q.length) };
  });

  return scored
    .filter((s) => s.score <= Math.max(3, Math.ceil(s.len * 0.5)))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((s) => s.id);
}
