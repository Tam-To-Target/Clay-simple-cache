import prisma from "../db/prisma";
import { config } from "./config";
import {
  EmailStatus,
  VerificationResult,
  VerificationMethod,
  FindRequest,
  EmailVerificationProvider,
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

function makeResult(partial: Partial<VerificationResult>): VerificationResult {
  return {
    email: null,
    status: EmailStatus.unknown,
    confidence: 0,
    method: null,
    pattern: null,
    domain_info: null,
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

  // Apply known domain patterns
  const knownPatterns = await getDomainPatterns(domain);
  permutations = prioritizePermutations(permutations, knownPatterns);
  permutations = permutations.slice(0, config.max_permutations_to_try);

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
        permutations_tried: 0,
        cost_usd: 0,
        duration_ms: Date.now() - start,
      });
    }
  }

  // ── 7. API cascade with parallelization ──
  // Strategy: verify in parallel batches for speed.
  // Each batch fires all calls simultaneously, then we scan results for a winner.
  let riskyCandidate: VerificationResult | null = null;
  let catchAllCandidate: VerificationResult | null = null;
  const BATCH_SIZE = 5;

  for (let i = 0; i < permutations.length; i += BATCH_SIZE) {
    const batch = permutations.slice(i, i + BATCH_SIZE);
    const results = await apiCascadeParallel(batch, maxTier, BATCH_SIZE);

    // Count the whole batch as tried (they all ran in parallel)
    permutationsTried += batch.length;
    apiCalls += batch.length;
    for (const r of results) totalCost += r.cost_usd;

    // Scan batch results: valid wins immediately, catch_all/risky are saved, invalid is skipped
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
          permutations_tried: permutationsTried,
          cost_usd: totalCost,
          duration_ms: Date.now() - start,
        });
      }

      if (result.status === EmailStatus.catch_all && !catchAllCandidate) {
        catchAllCandidate = makeResult({
          email: permutations[0],
          status: EmailStatus.catch_all,
          confidence: 0.5,
          method: result.method,
          pattern: identifyPattern(permutations[0], first, last),
          domain_info: domainInfo,
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

      // invalid = this email doesn't exist, continue trying other permutations
    }

    // If we got catch_all from this batch, no point trying more permutations
    // (the whole domain accepts everything)
    if (catchAllCandidate) {
      await logSearch(first, last, domain, catchAllCandidate.email, "catch_all", catchAllCandidate.method, permutationsTried, apiCalls, totalCost, Date.now() - start);
      return {
        ...catchAllCandidate,
        permutations_tried: permutationsTried,
        cost_usd: totalCost,
        duration_ms: Date.now() - start,
      };
    }
  }

  // ── 8. Return best available ──
  if (riskyCandidate) {
    await logSearch(first, last, domain, riskyCandidate.email, "risky", riskyCandidate.method, permutationsTried, apiCalls, totalCost, Date.now() - start);
    return { ...riskyCandidate, duration_ms: Date.now() - start, cost_usd: totalCost };
  }

  await logSearch(first, last, domain, null, "unknown", null, permutationsTried, apiCalls, totalCost, Date.now() - start);
  return makeResult({
    status: EmailStatus.unknown,
    domain_info: domainInfo,
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
