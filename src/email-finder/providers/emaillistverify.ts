import {
  EmailVerificationProvider,
  EmailStatus,
  VerificationMethod,
  VerificationResult,
} from "../types";
import { config } from "../config";

const RESPONSE_MAP: Record<string, { status: EmailStatus; confidence: number }> = {
  ok: { status: EmailStatus.valid, confidence: 0.95 },
  fail: { status: EmailStatus.invalid, confidence: 0.95 },
  ok_for_all: { status: EmailStatus.catch_all, confidence: 0.5 },
  unknown: { status: EmailStatus.unknown, confidence: 0.3 },
  disposable: { status: EmailStatus.disposable, confidence: 0.95 },
  role: { status: EmailStatus.role_account, confidence: 0.8 },
  email_disabled: { status: EmailStatus.invalid, confidence: 0.9 },
  domain_error: { status: EmailStatus.invalid, confidence: 0.9 },
  error_credit: { status: EmailStatus.unknown, confidence: 0.0 },
  error: { status: EmailStatus.unknown, confidence: 0.0 },
};

let creditsExhausted = false;

export class EmailListVerifyProvider implements EmailVerificationProvider {
  name = "emaillistverify";
  cost_per_email = 0.0004;
  method = VerificationMethod.emaillistverify;

  is_configured(): boolean {
    return !!config.emaillistverify_api_key;
  }

  async verify(email: string): Promise<VerificationResult> {
    const base: VerificationResult = {
      email,
      status: EmailStatus.unknown,
      confidence: 0.3,
      method: this.method,
      pattern: null,
      domain_info: null,
      permutations_tried: 0,
      cost_usd: 0,
      duration_ms: 0,
    };

    if (creditsExhausted) return base;

    try {
      const url = `https://apps.emaillistverify.com/api/verifyEmail?secret=${encodeURIComponent(config.emaillistverify_api_key)}&email=${encodeURIComponent(email)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      const text = (await response.text()).trim().toLowerCase();

      if (text === "error_credit" || text === "error") {
        creditsExhausted = true;
        return base;
      }

      const mapped = RESPONSE_MAP[text] || {
        status: EmailStatus.unknown,
        confidence: 0.3,
      };

      return {
        ...base,
        status: mapped.status,
        confidence: mapped.confidence,
        cost_usd: this.cost_per_email,
      };
    } catch {
      return base;
    }
  }
}
