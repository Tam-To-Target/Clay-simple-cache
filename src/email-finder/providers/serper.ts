import { config } from "../config";

export interface SerpEmailResult {
  emails: string[];
  patterns: Map<string, string[]>; // pattern_name -> emails that match it
  domain: string;
  cost_usd: number;
}

/**
 * Search Google via Serper API for emails at a given domain.
 * Queries: "@domain.com" to find publicly visible email addresses.
 * Extracts emails from snippets, titles, and links in organic results.
 */
export async function searchSerpForEmails(
  domain: string
): Promise<SerpEmailResult> {
  const result: SerpEmailResult = {
    emails: [],
    patterns: new Map(),
    domain,
    cost_usd: 0,
  };

  if (!config.serper_api_key) return result;

  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": config.serper_api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: `"@${domain}"`,
        num: 30,
      }),
    });

    if (!response.ok) return result;

    // Serper costs ~$0.001 per search (1000 credits = $1 on their plan)
    result.cost_usd = 0.001;

    const data = await response.json();
    const emailRegex = new RegExp(
      `[a-zA-Z0-9._%+\\-]+@${escapeRegex(domain)}`,
      "gi"
    );

    const foundEmails = new Set<string>();

    // Extract emails from organic results
    for (const item of data.organic || []) {
      const text = [item.title, item.snippet, item.link].filter(Boolean).join(" ");
      const matches = text.match(emailRegex);
      if (matches) {
        for (const m of matches) {
          foundEmails.add(m.toLowerCase());
        }
      }
    }

    // Also check knowledge graph if present
    if (data.knowledgeGraph) {
      const kgText = JSON.stringify(data.knowledgeGraph);
      const matches = kgText.match(emailRegex);
      if (matches) {
        for (const m of matches) {
          foundEmails.add(m.toLowerCase());
        }
      }
    }

    // Also check "peopleAlsoAsk" snippets
    for (const item of data.peopleAlsoAsk || []) {
      const text = [item.title, item.snippet].filter(Boolean).join(" ");
      const matches = text.match(emailRegex);
      if (matches) {
        for (const m of matches) {
          foundEmails.add(m.toLowerCase());
        }
      }
    }

    // Filter out role accounts and clearly non-personal emails
    const ROLE_PREFIXES = [
      "info", "admin", "support", "contact", "hello", "help",
      "sales", "marketing", "office", "team", "hr", "jobs",
      "careers", "press", "media", "noreply", "no-reply",
      "webmaster", "postmaster", "abuse", "billing", "legal",
      "privacy", "security", "feedback", "newsletter",
    ];

    const personalEmails: string[] = [];
    for (const email of foundEmails) {
      const local = email.split("@")[0];
      if (!ROLE_PREFIXES.includes(local)) {
        personalEmails.push(email);
      }
    }

    result.emails = personalEmails;
  } catch {
    // Non-critical — return empty result on error
  }

  return result;
}

/**
 * A structural fingerprint for a local part, before we know the pattern name.
 * We classify structure first, then cross-reference multiple emails to resolve
 * ambiguities (e.g., "word.word" could be first.last or last.first).
 */
type Structure =
  | { sep: "." | "_" | "-"; left: "short" | "long"; right: "short" | "long" }
  | { sep: "none"; shape: "short-long" | "long-short" | "long" | "short" | "ambiguous" };

function fingerprint(local: string): Structure | null {
  if (local.length <= 1) return null;

  for (const sep of [".", "_", "-"] as const) {
    if (local.includes(sep)) {
      const parts = local.split(sep);
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
      return {
        sep,
        left: parts[0].length === 1 ? "short" : "long",
        right: parts[1].length === 1 ? "short" : "long",
      };
    }
  }

  // No separator
  if (local.length <= 2) return { sep: "none", shape: "short" };
  return { sep: "none", shape: "ambiguous" };
}

/**
 * Given a set of structural fingerprints from multiple emails, resolve ambiguous
 * no-separator patterns by checking if the majority share a consistent shape.
 *
 * Cross-reference logic:
 * - If most no-separator locals are "1 char + 3+ chars" (e.g., jdoe, msmith) → flast
 * - If most are "3+ chars + 1 char" (e.g., doej, smithm) → lastf
 * - If most are very long (8+ chars, no obvious split) → firstlast
 * - If most are short-medium (3-6 chars, all alpha) → first or last (use prevalence)
 */
function resolveNoSepPatterns(
  locals: string[]
): Map<string, string> {
  const result = new Map<string, string>(); // local → pattern

  if (locals.length === 0) return result;

  // Analyze the "shape" of each local: where could the split be?
  // For "flast": first char is initial, rest is a last name
  // For "lastf": last char is initial, rest is a last name
  // For "firstlast": long, no obvious 1-char boundary
  // For "first"/"last": single name, medium length

  const shapes = new Map<string, string[]>(); // shape → locals

  for (const local of locals) {
    if (local.length <= 2) {
      (shapes.get("too_short") || (shapes.set("too_short", []), shapes.get("too_short")!)).push(local);
      continue;
    }

    const firstChar = local[0];
    const lastChar = local[local.length - 1];
    const inner = local.slice(1, -1);

    // Heuristic: if removing first char leaves a plausible name (3+ alpha chars)
    const restAfterFirst = local.slice(1);
    const restBeforeLast = local.slice(0, -1);

    const looksLikeFlast = restAfterFirst.length >= 3 && /^[a-z]+$/.test(restAfterFirst);
    const looksLikeLastf = restBeforeLast.length >= 3 && /^[a-z]+$/.test(restBeforeLast);
    const looksLikeSingleName = local.length >= 3 && local.length <= 8 && /^[a-z]+$/.test(local);
    const looksLikeConcat = local.length >= 6 && /^[a-z]+$/.test(local);

    // We can't decide individually — tag as candidates
    const tags: string[] = [];
    if (looksLikeFlast) tags.push("flast");
    if (looksLikeLastf) tags.push("lastf");
    if (looksLikeSingleName) tags.push("single_name");
    if (looksLikeConcat) tags.push("concat");

    for (const tag of tags) {
      (shapes.get(tag) || (shapes.set(tag, []), shapes.get(tag)!)).push(local);
    }
  }

  // Cross-reference: if multiple emails share the same "1 char + rest" structure,
  // it's very likely "flast"
  const flastCandidates = shapes.get("flast") || [];
  const lastfCandidates = shapes.get("lastf") || [];

  // Check consistency: do all flast candidates have different first chars?
  // e.g., jdoe, msmith, agarcia → j, m, a all different → strong flast signal
  const flastFirstChars = new Set(flastCandidates.map((l) => l[0]));
  const lastfLastChars = new Set(lastfCandidates.map((l) => l[l.length - 1]));

  // The pattern where initials vary more is more likely correct
  // (different people → different initials, but last names vary too)
  // Key insight: for "flast", the REST (last name) should be unique across emails
  // For "lastf", the REST (last name) should also be unique
  // But if first chars are all different AND rest parts are all different → flast
  const flastRests = new Set(flastCandidates.map((l) => l.slice(1)));
  const lastfRests = new Set(lastfCandidates.map((l) => l.slice(0, -1)));

  const flastUniqueness = flastCandidates.length > 0
    ? (flastFirstChars.size / flastCandidates.length) * (flastRests.size / flastCandidates.length)
    : 0;
  const lastfUniqueness = lastfCandidates.length > 0
    ? (lastfLastChars.size / lastfCandidates.length) * (lastfRests.size / lastfCandidates.length)
    : 0;

  // Need at least 2 emails to cross-reference meaningfully
  if (flastCandidates.length >= 2 && flastUniqueness >= lastfUniqueness) {
    for (const local of flastCandidates) result.set(local, "flast");
  } else if (lastfCandidates.length >= 2 && lastfUniqueness > flastUniqueness) {
    for (const local of lastfCandidates) result.set(local, "lastf");
  }

  // For concat candidates not yet resolved, check length distribution
  const concatCandidates = (shapes.get("concat") || []).filter((l) => !result.has(l));
  if (concatCandidates.length >= 2) {
    // If they're all long (8+ chars), likely "firstlast"
    const allLong = concatCandidates.every((l) => l.length >= 8);
    if (allLong) {
      for (const local of concatCandidates) result.set(local, "firstlast");
    }
  }

  // Single name candidates not yet resolved
  const singleCandidates = (shapes.get("single_name") || []).filter((l) => !result.has(l));
  if (singleCandidates.length >= 2) {
    // Can't distinguish "first" vs "last" without more context — use prevalence
    // "first" is 3x more common than "last" globally
    for (const local of singleCandidates) result.set(local, "first");
  }

  return result;
}

/**
 * Analyze SERP-discovered emails to identify the domain's email pattern.
 * Uses cross-referencing across multiple emails to resolve ambiguities.
 * Returns patterns sorted by frequency (most common first).
 */
export function identifyPatternsFromEmails(
  emails: string[]
): { pattern: string; count: number; examples: string[] }[] {
  if (emails.length === 0) return [];

  // Step 1: Classify emails with separators (unambiguous)
  // Step 2: Collect no-separator emails for cross-reference
  const patternCounts = new Map<string, { count: number; examples: string[] }>();
  const noSepLocals: string[] = [];
  const localToEmail = new Map<string, string>();

  for (const email of emails) {
    const local = email.split("@")[0];
    localToEmail.set(local, email);

    const fp = fingerprint(local);
    if (!fp) continue;

    let pattern: string | null = null;

    if (fp.sep !== "none") {
      // Separator-based: mostly unambiguous
      const sepName = fp.sep === "." ? "." : fp.sep === "_" ? "_" : "-";

      if (fp.left === "short" && fp.right === "long") {
        // f.last, f_last
        pattern = fp.sep === "-" ? null : `f${sepName}last`;
      } else if (fp.left === "long" && fp.right === "short") {
        // first.l, last.f — ambiguous, but first.l is 2x more prevalent
        pattern = `first${sepName}l`;
      } else if (fp.left === "long" && fp.right === "long") {
        // first.last vs last.first — ambiguous between the two
        // Default to first.last (17.5x more prevalent), but tag for cross-ref
        pattern = fp.sep === "." ? "first.last"
                : fp.sep === "_" ? "first_last"
                : "first-last";
      }
    } else {
      // No separator — needs cross-referencing
      noSepLocals.push(local);
    }

    if (pattern) {
      const entry = patternCounts.get(pattern) || { count: 0, examples: [] };
      entry.count++;
      if (entry.examples.length < 3) entry.examples.push(email);
      patternCounts.set(pattern, entry);
    }
  }

  // Step 2: Cross-reference no-separator emails
  const resolved = resolveNoSepPatterns(noSepLocals);
  for (const [local, pattern] of resolved) {
    const email = localToEmail.get(local);
    if (!email) continue;
    const entry = patternCounts.get(pattern) || { count: 0, examples: [] };
    entry.count++;
    if (entry.examples.length < 3) entry.examples.push(email);
    patternCounts.set(pattern, entry);
  }

  // Step 3: If we have separator-based patterns AND unresolved no-sep emails,
  // check if the separator pattern can disambiguate.
  // e.g., if we know the domain uses "first.last" and we see "jdoe" → likely "flast"
  // (same first-initial + last-name convention, just without separator)
  const unresolvedLocals = noSepLocals.filter((l) => !resolved.has(l));
  if (unresolvedLocals.length > 0 && patternCounts.size > 0) {
    const topPattern = Array.from(patternCounts.entries())
      .sort((a, b) => b[1].count - a[1].count)[0]?.[0];

    if (topPattern) {
      // If the domain's main pattern puts last name after first initial/name,
      // no-sep emails with 1-char prefix are likely "flast"
      const lastNameFirst = ["last.first", "last_first", "lastf", "last.f"].includes(topPattern);
      const firstNameFirst = ["first.last", "first_last", "first-last", "f.last", "f_last", "flast", "first.l"].includes(topPattern);

      for (const local of unresolvedLocals) {
        if (local.length <= 2) continue;
        const restAfterFirst = local.slice(1);
        const restBeforeLast = local.slice(0, -1);

        let inferredPattern: string | null = null;

        if (firstNameFirst && restAfterFirst.length >= 3 && /^[a-z]+$/.test(restAfterFirst)) {
          inferredPattern = "flast";
        } else if (lastNameFirst && restBeforeLast.length >= 3 && /^[a-z]+$/.test(restBeforeLast)) {
          inferredPattern = "lastf";
        }

        if (inferredPattern) {
          const email = localToEmail.get(local);
          if (!email) continue;
          const entry = patternCounts.get(inferredPattern) || { count: 0, examples: [] };
          entry.count++;
          if (entry.examples.length < 3) entry.examples.push(email);
          patternCounts.set(inferredPattern, entry);
        }
      }
    }
  }

  return Array.from(patternCounts.entries())
    .map(([pattern, data]) => ({
      pattern,
      count: data.count,
      examples: data.examples,
    }))
    .sort((a, b) => b.count - a.count);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
