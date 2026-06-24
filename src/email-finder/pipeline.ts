import { config } from "./config";
import {
  EmailStatus,
  VerificationResult,
  VerificationMethod,
  EmailVerificationProvider,
  CONCLUSIVE_STATUSES,
} from "./types";
import { analyzeDomain } from "./domain-intel";
import { getCachedVerification, cacheVerification } from "./cache";
import { EmailListVerifyProvider } from "./providers/emaillistverify";
import { DebounceProvider } from "./providers/debounce";

function makeResult(partial: Partial<VerificationResult>): VerificationResult {
  return {
    email: null,
    status: EmailStatus.unknown,
    confidence: 0,
    method: null,
    domain_info: null,
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
