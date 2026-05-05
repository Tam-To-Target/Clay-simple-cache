import { config } from "../email-finder/config";
import { normalizeDomain, normalizeLinkedIn } from "./normalization";

export type LinkedInFinderReason =
  | "missing_api_key"
  | "invalid_input"
  | "serper_error"
  | "no_results";

export interface LinkedInFinderResult {
  success: boolean;
  input: string;
  domain: string | null;
  linkedin_url: string | null;
  linkedin_slug: string | null;
  match_type?: "domain_in_url" | "domain_in_snippet" | "first_result";
  candidates?: { url: string; slug: string; title?: string; snippet?: string }[];
  reason?: LinkedInFinderReason;
  message?: string;
  cost_usd: number;
}

interface SerperOrganicItem {
  title?: string;
  link?: string;
  snippet?: string;
}

interface SerperResponse {
  organic?: SerperOrganicItem[];
}

const COMPANY_URL_REGEX = /linkedin\.com\/company\/([^\/?#"\s]+)/i;

async function serperSearch(query: string): Promise<SerperResponse | null> {
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": config.serper_api_key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 10 }),
    });
    if (!response.ok) return null;
    return (await response.json()) as SerperResponse;
  } catch {
    return null;
  }
}

function buildCanonicalUrl(slug: string): string {
  return `https://www.linkedin.com/company/${slug}`;
}

export async function findLinkedInForDomain(
  rawInput: string
): Promise<LinkedInFinderResult> {
  const input = (rawInput || "").trim();

  const base: LinkedInFinderResult = {
    success: false,
    input,
    domain: null,
    linkedin_url: null,
    linkedin_slug: null,
    cost_usd: 0,
  };

  if (!input) {
    return { ...base, reason: "invalid_input", message: "input is required" };
  }

  const domain = normalizeDomain(input);
  if (!domain) {
    return {
      ...base,
      reason: "invalid_input",
      message: "Could not normalize domain from input",
    };
  }

  if (!config.serper_api_key) {
    return {
      ...base,
      domain,
      reason: "missing_api_key",
      message: "SERPER_API_KEY is not configured",
    };
  }

  // Build Google query: restrict to LinkedIn company pages and include the domain.
  // Quoting the domain biases Google toward exact-match snippets.
  const query = `site:linkedin.com/company "${domain}"`;
  const data = await serperSearch(query);

  if (!data) {
    return {
      ...base,
      domain,
      reason: "serper_error",
      message: "Serper request failed",
    };
  }

  const cost_usd = 0.001;
  const organic = data.organic || [];

  const candidates: { url: string; slug: string; title?: string; snippet?: string }[] = [];
  const seenSlugs = new Set<string>();

  for (const item of organic) {
    const link = item.link || "";
    const match = link.match(COMPANY_URL_REGEX);
    if (!match) continue;
    const slug = decodeURIComponent(match[1]).toLowerCase();
    if (seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    candidates.push({
      url: buildCanonicalUrl(slug),
      slug,
      title: item.title,
      snippet: item.snippet,
    });
  }

  if (candidates.length === 0) {
    return {
      ...base,
      domain,
      cost_usd,
      reason: "no_results",
      message: "No LinkedIn company pages found",
    };
  }

  // Ranking: prefer a candidate whose URL or snippet/title actually mentions
  // the domain (Google's first hit is usually right, but we double-check).
  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const domainRegex = new RegExp(`\\b${escapedDomain}\\b`, "i");

  let chosen = candidates[0];
  let matchType: LinkedInFinderResult["match_type"] = "first_result";

  for (const c of candidates) {
    if (c.slug.includes(domain.split(".")[0])) {
      chosen = c;
      matchType = "domain_in_url";
      break;
    }
  }

  if (matchType === "first_result") {
    for (const c of candidates) {
      const haystack = `${c.title || ""} ${c.snippet || ""}`;
      if (domainRegex.test(haystack)) {
        chosen = c;
        matchType = "domain_in_snippet";
        break;
      }
    }
  }

  const normalizedSlug = normalizeLinkedIn(chosen.url) || chosen.slug;
  const canonicalUrl = buildCanonicalUrl(normalizedSlug);

  return {
    success: true,
    input,
    domain,
    linkedin_url: canonicalUrl,
    linkedin_slug: normalizedSlug,
    match_type: matchType,
    candidates,
    cost_usd,
  };
}
