import { config } from "../config";

export interface SerpEmailResult {
  emails: string[];
  rocketreach_pattern: RocketReachPattern | null;
  domain: string;
  cost_usd: number;
}

export interface RocketReachPattern {
  pattern: string;       // our internal pattern name (e.g., "flast", "first.last")
  example: string;       // e.g., "jdoe@hubspot.com"
  percentage: number;    // e.g., 73.5
  raw_format: string;    // e.g., "[first_initial][last]"
}

// Map RocketReach format descriptors to our internal pattern names
const ROCKETREACH_FORMAT_MAP: Record<string, string> = {
  "[first_initial][last]": "flast",
  "[first].[last]": "first.last",
  "[first][last]": "firstlast",
  "[first]_[last]": "first_last",
  "[first]-[last]": "first-last",
  "[first]": "first",
  "[last]": "last",
  "[last][first_initial]": "lastf",
  "[last].[first]": "last.first",
  "[first_initial].[last]": "f.last",
  "[first].[last_initial]": "first.l",
  "[first][last_initial]": "firstl",
  "[first_initial]_[last]": "f_last",
  "[last]_[first]": "last_first",
  "[last].[first_initial]": "last.f",
};

/**
 * Run a single Serper search and return raw organic results.
 */
async function serperSearch(
  query: string
): Promise<{ organic: any[]; knowledgeGraph?: any; peopleAlsoAsk?: any[] } | null> {
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": config.serper_api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 20 }),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Parse RocketReach email format snippets.
 * Matches patterns like:
 *   "The most common X email format is [first_initial][last] (ex. jdoe@hubspot.com), which is being used by 73.5%"
 *   "Stripe uses 11 email formats: 1. first@stripe.com (32.6%)"
 *   "FLast@hubspot.com; this email format is used 86% of the time"
 */
function parseRocketReachSnippets(
  snippets: string[],
  domain: string
): RocketReachPattern | null {
  const emailRegex = new RegExp(
    `([a-zA-Z0-9._%+\\-]+)@${escapeRegex(domain)}`,
    "i"
  );

  for (const snippet of snippets) {
    // Pattern 1: "[format_desc] (ex. email@domain), which is being used by XX.X%"
    const formatMatch = snippet.match(
      /format is (\[[^\]]+\](?:\[[^\]]+\])*)\s*\(ex\.\s*([^)]+)\).*?(\d+\.?\d*)%/i
    );
    if (formatMatch) {
      const rawFormat = formatMatch[1].toLowerCase();
      const example = formatMatch[2].trim().toLowerCase();
      const percentage = parseFloat(formatMatch[3]);
      const pattern = ROCKETREACH_FORMAT_MAP[rawFormat];
      if (pattern && emailRegex.test(example)) {
        return { pattern, example, percentage, raw_format: rawFormat };
      }
    }

    // Pattern 2: "FLast@domain.com; this email format is used XX% of the time" (LeadIQ style)
    const leadiqMatch = snippet.match(
      /([A-Za-z]+)@[^\s;]+;\s*this email format is used\s*(\d+\.?\d*)%/i
    );
    if (leadiqMatch) {
      const formatHint = leadiqMatch[1]; // e.g., "FLast"
      const percentage = parseFloat(leadiqMatch[2]);
      const emailMatch = snippet.match(emailRegex);
      if (emailMatch) {
        const pattern = inferPatternFromHint(formatHint);
        if (pattern) {
          return {
            pattern,
            example: emailMatch[0].toLowerCase(),
            percentage,
            raw_format: formatHint,
          };
        }
      }
    }

    // Pattern 3: "1. first@domain.com (XX.X%)" — numbered format list
    const numberedMatch = snippet.match(
      /1\.\s*([a-zA-Z0-9._%+-]+@[^\s]+)\s*\((\d+\.?\d*)%\)/
    );
    if (numberedMatch) {
      const example = numberedMatch[1].toLowerCase();
      const percentage = parseFloat(numberedMatch[2]);
      if (emailRegex.test(example)) {
        const local = example.split("@")[0];
        const pattern = inferPatternFromExample(local);
        if (pattern) {
          return { pattern, example, percentage, raw_format: local };
        }
      }
    }
  }

  return null;
}

/**
 * Infer pattern from LeadIQ-style hints like "FLast", "First.Last", etc.
 */
function inferPatternFromHint(hint: string): string | null {
  const h = hint.toLowerCase();
  if (h === "flast") return "flast";
  if (h === "first.last") return "first.last";
  if (h === "firstlast") return "firstlast";
  if (h === "first") return "first";
  if (h === "last") return "last";
  if (h === "lastf") return "lastf";
  if (h === "f.last") return "f.last";
  if (h === "first.l") return "first.l";
  if (h === "first_last") return "first_last";
  if (h === "first-last") return "first-last";
  return null;
}

/**
 * Infer pattern from a concrete example local part like "jane", "jdoe", "john.doe".
 * Used when RocketReach gives us a numbered list format.
 */
function inferPatternFromExample(local: string): string | null {
  if (local.includes(".")) {
    const parts = local.split(".");
    if (parts.length === 2) {
      if (parts[0].length === 1) return "f.last";
      if (parts[1].length === 1) return "first.l";
      return "first.last";
    }
  }
  if (local.includes("_")) {
    const parts = local.split("_");
    if (parts.length === 2) {
      if (parts[0].length === 1) return "f_last";
      return "first_last";
    }
  }
  if (local.includes("-")) return "first-last";

  // No separator — check common example names
  // RocketReach uses "jane", "jdoe", "janedoe", etc.
  if (/^[a-z]{1}[a-z]{3,}$/.test(local)) return "flast"; // jdoe, jsmith
  if (/^[a-z]{2,8}$/.test(local)) return "first";         // jane, john
  return null;
}

/**
 * Search Google via Serper API for emails at a given domain.
 *
 * Two-query strategy:
 * 1. "rocketreach.co {domain} email format" — parses structured RocketReach snippets
 *    that explicitly state the pattern + percentage (e.g., "[first_initial][last] used by 73.5%")
 * 2. "{domain} email contact" — catches raw emails from the web (footers, about pages, etc.)
 */
export async function searchSerpForEmails(
  domain: string
): Promise<SerpEmailResult> {
  const result: SerpEmailResult = {
    emails: [],
    rocketreach_pattern: null,
    domain,
    cost_usd: 0,
  };

  if (!config.serper_api_key) return result;

  // Run both queries in parallel
  const [rrData, genericData] = await Promise.all([
    serperSearch(`rocketreach.co "${domain}" email format`),
    serperSearch(`"${domain}" email contact`),
  ]);

  // Each Serper search costs ~$0.001
  result.cost_usd = (rrData ? 0.001 : 0) + (genericData ? 0.001 : 0);

  // ── Query 1: Parse RocketReach snippets for structured pattern info ──
  if (rrData) {
    const snippets = (rrData.organic || [])
      .map((item: any) => item.snippet || "")
      .filter(Boolean);
    result.rocketreach_pattern = parseRocketReachSnippets(snippets, domain);
  }

  // ── Query 2: Extract raw emails from generic search results ──
  const emailRegex = new RegExp(
    `[a-zA-Z0-9._%+\\-]+@${escapeRegex(domain)}`,
    "gi"
  );
  const foundEmails = new Set<string>();

  for (const data of [rrData, genericData]) {
    if (!data) continue;

    for (const item of data.organic || []) {
      const text = [item.title, item.snippet, item.link].filter(Boolean).join(" ");
      const matches = text.match(emailRegex);
      if (matches) {
        for (const m of matches) foundEmails.add(m.toLowerCase());
      }
    }

    if (data.knowledgeGraph) {
      const kgText = JSON.stringify(data.knowledgeGraph);
      const matches = kgText.match(emailRegex);
      if (matches) {
        for (const m of matches) foundEmails.add(m.toLowerCase());
      }
    }

    for (const item of data.peopleAlsoAsk || []) {
      const text = [item.title, item.snippet].filter(Boolean).join(" ");
      const matches = text.match(emailRegex);
      if (matches) {
        for (const m of matches) foundEmails.add(m.toLowerCase());
      }
    }
  }

  // Filter out role accounts
  const ROLE_PREFIXES = [
    "info", "admin", "support", "contact", "contacto", "hello", "help",
    "sales", "marketing", "office", "team", "hr", "jobs",
    "careers", "press", "media", "noreply", "no-reply",
    "webmaster", "postmaster", "abuse", "billing", "legal",
    "privacy", "security", "feedback", "newsletter", "hola",
  ];

  // Also filter out RocketReach example emails (generic names like "jane", "jdoe")
  const RR_EXAMPLE_LOCALS = ["jane", "jdoe", "john", "johndoe", "john.doe", "j.doe"];

  for (const email of foundEmails) {
    const local = email.split("@")[0];
    if (!ROLE_PREFIXES.includes(local) && !RR_EXAMPLE_LOCALS.includes(local)) {
      result.emails.push(email);
    }
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

  const shapes = new Map<string, string[]>(); // shape → locals

  for (const local of locals) {
    if (local.length <= 2) {
      (shapes.get("too_short") || (shapes.set("too_short", []), shapes.get("too_short")!)).push(local);
      continue;
    }

    const restAfterFirst = local.slice(1);
    const restBeforeLast = local.slice(0, -1);

    const looksLikeFlast = restAfterFirst.length >= 3 && /^[a-z]+$/.test(restAfterFirst);
    const looksLikeLastf = restBeforeLast.length >= 3 && /^[a-z]+$/.test(restBeforeLast);
    const looksLikeSingleName = local.length >= 3 && local.length <= 8 && /^[a-z]+$/.test(local);
    const looksLikeConcat = local.length >= 6 && /^[a-z]+$/.test(local);

    const tags: string[] = [];
    if (looksLikeFlast) tags.push("flast");
    if (looksLikeLastf) tags.push("lastf");
    if (looksLikeSingleName) tags.push("single_name");
    if (looksLikeConcat) tags.push("concat");

    for (const tag of tags) {
      (shapes.get(tag) || (shapes.set(tag, []), shapes.get(tag)!)).push(local);
    }
  }

  const flastCandidates = shapes.get("flast") || [];
  const lastfCandidates = shapes.get("lastf") || [];

  const flastFirstChars = new Set(flastCandidates.map((l) => l[0]));
  const lastfLastChars = new Set(lastfCandidates.map((l) => l[l.length - 1]));

  const flastRests = new Set(flastCandidates.map((l) => l.slice(1)));
  const lastfRests = new Set(lastfCandidates.map((l) => l.slice(0, -1)));

  const flastUniqueness = flastCandidates.length > 0
    ? (flastFirstChars.size / flastCandidates.length) * (flastRests.size / flastCandidates.length)
    : 0;
  const lastfUniqueness = lastfCandidates.length > 0
    ? (lastfLastChars.size / lastfCandidates.length) * (lastfRests.size / lastfCandidates.length)
    : 0;

  if (flastCandidates.length >= 2 && flastUniqueness >= lastfUniqueness) {
    for (const local of flastCandidates) result.set(local, "flast");
  } else if (lastfCandidates.length >= 2 && lastfUniqueness > flastUniqueness) {
    for (const local of lastfCandidates) result.set(local, "lastf");
  }

  const concatCandidates = (shapes.get("concat") || []).filter((l) => !result.has(l));
  if (concatCandidates.length >= 2) {
    const allLong = concatCandidates.every((l) => l.length >= 8);
    if (allLong) {
      for (const local of concatCandidates) result.set(local, "firstlast");
    }
  }

  const singleCandidates = (shapes.get("single_name") || []).filter((l) => !result.has(l));
  if (singleCandidates.length >= 2) {
    for (const local of singleCandidates) result.set(local, "first");
  }

  return result;
}

/**
 * Analyze SERP-discovered emails to identify the domain's email pattern.
 * Uses cross-referencing across multiple emails to resolve ambiguities.
 * Returns patterns sorted by frequency (most common first).
 *
 * If a RocketReach pattern was found, it's included as the top result
 * (since it has explicit percentage data from a large sample).
 */
export function identifyPatternsFromEmails(
  emails: string[],
  rocketreachPattern: RocketReachPattern | null = null
): { pattern: string; count: number; examples: string[] }[] {
  const patternCounts = new Map<string, { count: number; examples: string[] }>();

  // If RocketReach gave us a pattern, seed it with high count
  if (rocketreachPattern) {
    patternCounts.set(rocketreachPattern.pattern, {
      count: Math.max(10, Math.round(rocketreachPattern.percentage / 5)),
      examples: [rocketreachPattern.example],
    });
  }

  if (emails.length === 0 && !rocketreachPattern) return [];
  if (emails.length === 0) {
    return Array.from(patternCounts.entries())
      .map(([pattern, data]) => ({ pattern, count: data.count, examples: data.examples }))
      .sort((a, b) => b.count - a.count);
  }

  // Step 1: Classify emails with separators (unambiguous)
  const noSepLocals: string[] = [];
  const localToEmail = new Map<string, string>();

  for (const email of emails) {
    const local = email.split("@")[0];
    localToEmail.set(local, email);

    const fp = fingerprint(local);
    if (!fp) continue;

    let pattern: string | null = null;

    if (fp.sep !== "none") {
      const sepName = fp.sep === "." ? "." : fp.sep === "_" ? "_" : "-";

      if (fp.left === "short" && fp.right === "long") {
        pattern = fp.sep === "-" ? null : `f${sepName}last`;
      } else if (fp.left === "long" && fp.right === "short") {
        pattern = `first${sepName}l`;
      } else if (fp.left === "long" && fp.right === "long") {
        pattern = fp.sep === "." ? "first.last"
                : fp.sep === "_" ? "first_last"
                : "first-last";
      }
    } else {
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

  // Step 3: Use known patterns to disambiguate remaining no-sep emails
  const unresolvedLocals = noSepLocals.filter((l) => !resolved.has(l));
  if (unresolvedLocals.length > 0 && patternCounts.size > 0) {
    const topPattern = Array.from(patternCounts.entries())
      .sort((a, b) => b[1].count - a[1].count)[0]?.[0];

    if (topPattern) {
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
