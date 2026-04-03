import {
  EmailVerificationProvider,
  EmailStatus,
  VerificationMethod,
  VerificationResult,
} from "../types";
import { config } from "../config";

export class DebounceProvider implements EmailVerificationProvider {
  name = "debounce";
  cost_per_email = 0.0015;
  method = VerificationMethod.debounce;

  is_configured(): boolean {
    return !!config.debounce_api_key;
  }

  async verify(email: string): Promise<VerificationResult> {
    const base: VerificationResult = {
      email,
      status: EmailStatus.unknown,
      confidence: 0.3,
      method: this.method,
      pattern: null,
      domain_info: null,
      serp_info: null,
      permutations_tried: 0,
      cost_usd: 0,
      duration_ms: 0,
    };

    try {
      const url = `https://api.debounce.io/v1/?api=${encodeURIComponent(config.debounce_api_key)}&email=${encodeURIComponent(email)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      const json = await response.json();
      const debounce = json.debounce;

      if (!debounce) return base;

      // Override: code "4" = catch_all
      if (debounce.code === "4") {
        return {
          ...base,
          status: EmailStatus.catch_all,
          confidence: 0.5,
          cost_usd: this.cost_per_email,
        };
      }

      const result = (debounce.result || "").toLowerCase();

      let status: EmailStatus = EmailStatus.unknown;
      let confidence = 0.3;

      if (result === "safe to send") {
        status = EmailStatus.valid;
        confidence = 0.95;
      } else if (result === "risky") {
        status = EmailStatus.risky;
        confidence = 0.5;
      } else if (result === "invalid") {
        status = EmailStatus.invalid;
        confidence = 0.95;
      }

      return {
        ...base,
        status,
        confidence,
        cost_usd: this.cost_per_email,
      };
    } catch {
      return base;
    }
  }
}
