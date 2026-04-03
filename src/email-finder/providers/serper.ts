import { config } from "../config";

export interface SerpEmailResult {
  emails: string[];
  domain: string;
  cost_usd: number;
}

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
 * Search Google via Serper API for emails at a given domain.
 *
 * Single query: "{domain} email" — the most effective for both large and small domains.
 * Catches emails from footers, about/contact pages, directories, and profile sites.
 */
export async function searchSerpForEmails(
  domain: string
): Promise<SerpEmailResult> {
  const result: SerpEmailResult = {
    emails: [],
    domain,
    cost_usd: 0,
  };

  if (!config.serper_api_key) return result;

  const data = await serperSearch(`${domain} email`);
  if (!data) return result;

  result.cost_usd = 0.001;

  // Extract emails from all result fields
  const emailRegex = new RegExp(
    `[a-zA-Z0-9._%+\\-]+@${escapeRegex(domain)}`,
    "gi"
  );
  const foundEmails = new Set<string>();

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

  // Filter out role accounts and generic example emails
  const ROLE_PREFIXES = [
    "info", "admin", "support", "contact", "contacto", "hello", "help",
    "sales", "marketing", "office", "team", "hr", "jobs",
    "careers", "press", "media", "noreply", "no-reply",
    "webmaster", "postmaster", "abuse", "billing", "legal",
    "privacy", "security", "feedback", "newsletter", "hola",
  ];

  const GENERIC_LOCALS = ["jane", "jdoe", "john", "johndoe", "john.doe", "j.doe"];

  for (const email of foundEmails) {
    const local = email.split("@")[0];
    if (!ROLE_PREFIXES.includes(local) && !GENERIC_LOCALS.includes(local)) {
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
  emails: string[]
): { pattern: string; count: number; examples: string[] }[] {
  if (emails.length === 0) return [];

  const patternCounts = new Map<string, { count: number; examples: string[] }>();

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
