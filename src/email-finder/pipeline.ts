import prisma from "../db/prisma";
import { config } from "./config";
import {
  EmailStatus,
  VerificationResult,
  VerificationMethod,
  FindRequest,
  EmailVerificationProvider,
  SerpInfo,
  CONCLUSIVE_STATUSES,
} from "./types";
import { analyzeDomain } from "./domain-intel";
import {
  normalizeName,
  parseFullName,
  generatePermutations,
  generatePermutationsFromFullName,
  prioritizePermutations,
  identifyPattern,
} from "./permutator";
import { getCachedVerification, cacheVerification } from "./cache";
import { saveDomainPattern, getDomainPatterns } from "./pattern-learner";
import { EmailListVerifyProvider } from "./providers/emaillistverify";
import { DebounceProvider } from "./providers/debounce";
import {
  searchSerpForEmails,
  identifyPatternsFromEmails,
} from "./providers/serper";

function makeResult(partial: Partial<VerificationResult>): VerificationResult {
  return {
    email: null,
    status: EmailStatus.unknown,
    confidence: 0,
    method: null,
    pattern: null,
    domain_info: null,
    serp_info: null,
    permutations_tried: 0,
    cost_usd: 0,
    duration_ms: 0,
    ...partial,
  };
}

// Tier configuration — only Tier 1 and Tier 2 for now
const TIERS: EmailVerificationProvider[][] = [
  [new EmailListVerifyProvider()],       // Tier 1
  [new DebounceProvider()],              // Tier 2
  // Tier 3 (NeverBounce) — not implemented yet
];

async function apiCascade(
  email: string,
  maxTier: number
): Promise<VerificationResult> {
  let totalCost = 0;

  for (let tierIdx = 0; tierIdx < TIERS.length; tierIdx++) {
    if (tierIdx + 1 > maxTier) break;

    for (const provider of TIERS[tierIdx]) {
      if (!provider.is_configured()) continue;

      const result = await provider.verify(email);
      totalCost += result.cost_usd;

      if (CONCLUSIVE_STATUSES.includes(result.status)) {
        return { ...result, cost_usd: totalCost };
      }

      // risky is not conclusive — continue to next provider
      if (result.status === EmailStatus.risky) {
        return { ...result, cost_usd: totalCost };
      }
    }
  }

  return makeResult({ email, cost_usd: totalCost });
}

/**
 * Run apiCascade on multiple emails in parallel batches for speed.
 * Returns results in the same order as input.
 */
async function apiCascadeParallel(
  emails: string[],
  maxTier: number,
  concurrency: number = 5
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = new Array(emails.length);

  for (let i = 0; i < emails.length; i += concurrency) {
    const batch = emails.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((email) => apiCascade(email, maxTier))
    );
    for (let j = 0; j < batchResults.length; j++) {
      results[i + j] = batchResults[j];
    }
  }

  return results;
}

export async function findEmail(request: FindRequest): Promise<VerificationResult> {
  const start = Date.now();
  let totalCost = 0;
  let permutationsTried = 0;
  let apiCalls = 0;

  // ── 1. Parse name ──
  let first = request.first_name || "";
  let last = request.last_name || "";

  if (request.full_name && !(first && last)) {
    [first, last] = parseFullName(request.full_name);
  } else if (request.full_name && request.full_name.split(" ").length >= 3) {
    const [, parsedLast] = parseFullName(request.full_name);
    if (parsedLast && normalizeName(parsedLast) !== normalizeName(last)) {
      last = parsedLast;
    }
  }

  // ── 2. Normalize ──
  first = normalizeName(first);
  last = normalizeName(last);
  const domain = request.domain.trim().toLowerCase();
  const maxTier = Math.min(request.max_tier || 2, 2); // Cap at 2 (no Tier 3 yet)

  // ── 3. Domain analysis ──
  const domainInfo = await analyzeDomain(domain);

  // ── 4. Early exits ──
  if (!domainInfo.has_mx) {
    return makeResult({
      status: EmailStatus.no_mx,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
    });
  }
  if (domainInfo.is_disposable) {
    return makeResult({
      status: EmailStatus.disposable,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
    });
  }

  // ── 5. Generate permutations ──
  let permutations = generatePermutations(first, last, domain);

  if (request.full_name) {
    const extras = generatePermutationsFromFullName(request.full_name, domain);
    const seen = new Set(permutations);
    for (const e of extras) {
      if (!seen.has(e)) {
        seen.add(e);
        permutations.push(e);
      }
    }
  }

  // Apply known domain patterns (from DB)
  const knownPatterns = await getDomainPatterns(domain);
  permutations = prioritizePermutations(permutations, knownPatterns);

  // ── 5b. SERP pattern discovery ──
  // Search Google for "@domain.com" to find real emails and identify the domain's pattern.
  // This runs before API validation to inform permutation priority.
  const serpResult = await searchSerpForEmails(domain);
  totalCost += serpResult.cost_usd;

  let serpPatterns: { pattern: string; count: number; examples: string[] }[] = [];
  let serpDirectMatch: string | null = null;
  const serpUsed = !!config.serper_api_key;

  // Analyze SERP results: RocketReach structured pattern + raw emails
  const hasResults = serpResult.emails.length > 0 || serpResult.rocketreach_pattern;

  if (hasResults) {
    serpPatterns = identifyPatternsFromEmails(serpResult.emails, serpResult.rocketreach_pattern);

    // Check if any SERP email is an exact match for our target person
    for (const serpEmail of serpResult.emails) {
      if (permutations.includes(serpEmail)) {
        serpDirectMatch = serpEmail;
        break;
      }
    }

    // Re-prioritize permutations based on SERP-discovered patterns
    if (serpPatterns.length > 0) {
      const serpKnownPatterns = serpPatterns.map((sp) => ({
        pattern: sp.pattern,
        confidence: Math.min(1.0, 0.7 + sp.count * 0.1),
        sample_count: sp.count,
      }));

      // Merge SERP patterns with DB patterns (SERP takes priority for ordering)
      const mergedPatterns = [...serpKnownPatterns];
      for (const dbp of knownPatterns) {
        if (!mergedPatterns.find((p) => p.pattern === dbp.pattern)) {
          mergedPatterns.push(dbp);
        }
      }

      permutations = prioritizePermutations(permutations, mergedPatterns);

      // Save SERP-discovered patterns to DB for future lookups
      for (const sp of serpPatterns) {
        await saveDomainPattern(domain, sp.pattern);
      }
    }
  }

  permutations = permutations.slice(0, config.max_permutations_to_try);

  // Build SERP tracing info for the response
  const serpInfo: SerpInfo = {
    used: serpUsed,
    emails_found: serpResult.emails.length,
    rocketreach_pattern: serpResult.rocketreach_pattern,
    patterns_detected: serpPatterns,
    direct_match: serpDirectMatch,
  };

  // ── 6. Cache check ──
  for (const email of permutations) {
    const cached = await getCachedVerification(email);
    if (cached?.status === EmailStatus.valid) {
      const pattern = identifyPattern(email, first, last);
      return makeResult({
        email,
        status: EmailStatus.valid,
        confidence: cached.confidence,
        method: cached.method,
        pattern,
        domain_info: domainInfo,
        serp_info: serpInfo,
        permutations_tried: 0,
        cost_usd: totalCost,
        duration_ms: Date.now() - start,
      });
    }
  }

  // ── 6b. SERP direct match shortcut ──
  // If SERP found an exact email matching one of our permutations,
  // validate it directly first (single API call instead of batch scanning).
  if (serpDirectMatch) {
    const validation = await apiCascade(serpDirectMatch, maxTier);
    permutationsTried++;
    apiCalls++;
    totalCost += validation.cost_usd;

    if (validation.status === EmailStatus.valid) {
      const pattern = identifyPattern(serpDirectMatch, first, last);
      if (pattern) await saveDomainPattern(domain, pattern);
      await cacheVerification(serpDirectMatch, "valid", 0.99, VerificationMethod.serp_pattern);
      await logSearch(first, last, domain, serpDirectMatch, "valid", VerificationMethod.serp_pattern, permutationsTried, apiCalls, totalCost, Date.now() - start);
      return makeResult({
        email: serpDirectMatch,
        status: EmailStatus.valid,
        confidence: 0.99,
        method: VerificationMethod.serp_pattern,
        pattern,
        domain_info: domainInfo,
        serp_info: serpInfo,
        permutations_tried: permutationsTried,
        cost_usd: totalCost,
        duration_ms: Date.now() - start,
      });
    }

    // If catch-all, the SERP match is still our best guess — handle below
    if (validation.status === EmailStatus.catch_all) {
      const pattern = identifyPattern(serpDirectMatch, first, last);
      // SERP found this email publicly + domain is catch-all = high confidence
      const confidence = 0.85;
      await cacheVerification(serpDirectMatch, "catch_all", confidence, VerificationMethod.serp_pattern);
      await logSearch(first, last, domain, serpDirectMatch, "catch_all", VerificationMethod.serp_pattern, permutationsTried, apiCalls, totalCost, Date.now() - start);
      return makeResult({
        email: serpDirectMatch,
        status: EmailStatus.catch_all,
        confidence,
        method: VerificationMethod.serp_pattern,
        pattern,
        domain_info: domainInfo,
        serp_info: serpInfo,
        permutations_tried: permutationsTried,
        cost_usd: totalCost,
        duration_ms: Date.now() - start,
      });
    }

    // Remove from permutations list so we don't re-test it
    permutations = permutations.filter((p) => p !== serpDirectMatch);
  }

  // ── 7. API cascade with parallelization ──
  let riskyCandidate: VerificationResult | null = null;
  let catchAllCandidate: VerificationResult | null = null;
  const BATCH_SIZE = 5;

  for (let i = 0; i < permutations.length; i += BATCH_SIZE) {
    const batch = permutations.slice(i, i + BATCH_SIZE);
    const results = await apiCascadeParallel(batch, maxTier, BATCH_SIZE);

    permutationsTried += batch.length;
    apiCalls += batch.length;
    for (const r of results) totalCost += r.cost_usd;

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const email = batch[j];

      if (result.status === EmailStatus.valid) {
        const pattern = identifyPattern(email, first, last);
        if (pattern) await saveDomainPattern(domain, pattern);
        await cacheVerification(email, "valid", result.confidence, result.method);
        await logSearch(first, last, domain, email, "valid", result.method, permutationsTried, apiCalls, totalCost, Date.now() - start);
        return makeResult({
          email,
          status: EmailStatus.valid,
          confidence: result.confidence,
          method: result.method,
          pattern,
          domain_info: domainInfo,
          serp_info: serpInfo,
          permutations_tried: permutationsTried,
          cost_usd: totalCost,
          duration_ms: Date.now() - start,
        });
      }

      if (result.status === EmailStatus.catch_all && !catchAllCandidate) {
        // For catch-all: use SERP pattern if available, otherwise first permutation
        const bestEmail = pickBestCatchAllEmail(
          permutations, first, last, domain, serpPatterns
        );
        const pattern = identifyPattern(bestEmail, first, last);
        // Confidence: higher if SERP corroborates the pattern
        const serpBoost = serpPatterns.length > 0 && pattern &&
          serpPatterns.some((sp) => sp.pattern === pattern);
        const confidence = serpBoost ? 0.75 : 0.5;

        catchAllCandidate = makeResult({
          email: bestEmail,
          status: EmailStatus.catch_all,
          confidence,
          method: serpBoost ? VerificationMethod.serp_pattern : result.method,
          pattern,
          domain_info: domainInfo,
          serp_info: serpInfo,
        });
      }

      if (result.status === EmailStatus.risky && !riskyCandidate) {
        riskyCandidate = makeResult({
          email,
          status: EmailStatus.risky,
          confidence: result.confidence,
          method: result.method,
          domain_info: domainInfo,
        });
      }
    }

    // If catch-all detected, validate best guess with Debounce for extra signal
    if (catchAllCandidate) {
      const finalResult = await validateCatchAllWithDebounce(
        catchAllCandidate, permutationsTried, apiCalls, totalCost, start,
        first, last, domain
      );
      totalCost = finalResult.cost_usd;
      await logSearch(first, last, domain, finalResult.email, finalResult.status, finalResult.method, finalResult.permutations_tried, apiCalls, totalCost, Date.now() - start);
      return finalResult;
    }
  }

  // ── 8. Return best available ──
  if (riskyCandidate) {
    await logSearch(first, last, domain, riskyCandidate.email, "risky", riskyCandidate.method, permutationsTried, apiCalls, totalCost, Date.now() - start);
    return { ...riskyCandidate, serp_info: serpInfo, duration_ms: Date.now() - start, cost_usd: totalCost };
  }

  await logSearch(first, last, domain, null, "unknown", null, permutationsTried, apiCalls, totalCost, Date.now() - start);
  return makeResult({
    status: EmailStatus.unknown,
    domain_info: domainInfo,
    serp_info: serpInfo,
    permutations_tried: permutationsTried,
    cost_usd: totalCost,
    duration_ms: Date.now() - start,
  });
}

export async function verifySingleEmail(
  email: string,
  maxTier: number = 2
): Promise<VerificationResult> {
  const start = Date.now();

  // 1. Syntax check
  if (!email.includes("@")) {
    return makeResult({
      email,
      status: EmailStatus.invalid,
      confidence: 1.0,
      method: VerificationMethod.local_syntax,
      duration_ms: Date.now() - start,
    });
  }

  const domain = email.split("@")[1];

  // 2. Cache check
  const cached = await getCachedVerification(email);
  if (cached) {
    return makeResult({
      email,
      status: cached.status,
      confidence: cached.confidence,
      method: cached.method,
      duration_ms: Date.now() - start,
    });
  }

  // 3. Domain analysis
  const domainInfo = await analyzeDomain(domain);
  if (!domainInfo.has_mx) {
    return makeResult({
      email,
      status: EmailStatus.no_mx,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
    });
  }
  if (domainInfo.is_disposable) {
    return makeResult({
      email,
      status: EmailStatus.disposable,
      domain_info: domainInfo,
      duration_ms: Date.now() - start,
    });
  }

  // 4. API cascade
  const cappedTier = Math.min(maxTier, 2); // No Tier 3 yet
  const result = await apiCascade(email, cappedTier);

  // 5. Cache and return
  if (result.status !== EmailStatus.unknown) {
    await cacheVerification(email, result.status, result.confidence, result.method);
  }

  return makeResult({
    email,
    status: result.status,
    confidence: result.confidence,
    method: result.method,
    domain_info: domainInfo,
    cost_usd: result.cost_usd,
    duration_ms: Date.now() - start,
  });
}

/**
 * For catch-all domains, pick the best email based on SERP-discovered patterns.
 * If SERP found a pattern, use it to build the email. Otherwise fall back to first permutation.
 */
function pickBestCatchAllEmail(
  permutations: string[],
  first: string,
  last: string,
  domain: string,
  serpPatterns: { pattern: string; count: number; examples: string[] }[]
): string {
  if (serpPatterns.length === 0 || permutations.length === 0) {
    return permutations[0] || `${first}.${last}@${domain}`;
  }

  // The top SERP pattern is the most likely format for this domain
  const topPattern = serpPatterns[0].pattern;

  // Find the permutation that matches this pattern
  for (const email of permutations) {
    const pattern = identifyPattern(email, first, last);
    if (pattern === topPattern) return email;
  }

  // Fallback to first permutation (already prioritized by patterns)
  return permutations[0];
}

/**
 * For catch-all domains: if Tier 1 (EmailListVerify) said catch-all,
 * cross-validate with Debounce to see if it can give a more definitive answer.
 * Debounce sometimes distinguishes valid from catch-all more accurately.
 */
async function validateCatchAllWithDebounce(
  catchAllCandidate: VerificationResult,
  permutationsTried: number,
  apiCalls: number,
  totalCost: number,
  start: number,
  first: string,
  last: string,
  domain: string
): Promise<VerificationResult> {
  const email = catchAllCandidate.email;
  if (!email) return { ...catchAllCandidate, permutations_tried: permutationsTried, cost_usd: totalCost, duration_ms: Date.now() - start };

  const debounce = new DebounceProvider();
  if (!debounce.is_configured()) {
    return { ...catchAllCandidate, permutations_tried: permutationsTried, cost_usd: totalCost, duration_ms: Date.now() - start };
  }

  const debounceResult = await debounce.verify(email);
  totalCost += debounceResult.cost_usd;

  // If Debounce says "safe to send" (valid), upgrade confidence
  if (debounceResult.status === EmailStatus.valid) {
    const pattern = identifyPattern(email, first, last);
    await cacheVerification(email, "valid", 0.9, VerificationMethod.debounce);
    return makeResult({
      email,
      status: EmailStatus.valid,
      confidence: 0.9, // Debounce confirmed valid on a catch-all domain
      method: VerificationMethod.debounce,
      pattern,
      domain_info: catchAllCandidate.domain_info,
      permutations_tried: permutationsTried,
      cost_usd: totalCost,
      duration_ms: Date.now() - start,
    });
  }

  // If Debounce also says catch-all, keep our best guess but note the SERP confidence
  return {
    ...catchAllCandidate,
    permutations_tried: permutationsTried,
    cost_usd: totalCost,
    duration_ms: Date.now() - start,
  };
}

async function logSearch(
  firstName: string | null,
  lastName: string | null,
  domain: string | null,
  resultEmail: string | null,
  resultStatus: string | null,
  methodUsed: string | VerificationMethod | null,
  permutationsTried: number,
  apiCallsMade: number,
  costUsd: number,
  durationMs: number
): Promise<void> {
  try {
    await prisma.searchLog.create({
      data: {
        first_name: firstName,
        last_name: lastName,
        domain,
        result_email: resultEmail,
        result_status: resultStatus,
        method_used: methodUsed,
        permutations_tried: permutationsTried,
        api_calls_made: apiCallsMade,
        cost_usd: costUsd,
        duration_ms: durationMs,
      },
    });
  } catch {
    // Non-critical — don't fail pipeline on log errors
  }
}
