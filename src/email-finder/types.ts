export enum EmailStatus {
  valid = "valid",
  invalid = "invalid",
  catch_all = "catch_all",
  unknown = "unknown",
  risky = "risky",
  disposable = "disposable",
  no_mx = "no_mx",
  role_account = "role_account",
}

export enum VerificationMethod {
  local_syntax = "local_syntax",
  local_dns = "local_dns",
  emaillistverify = "emaillistverify",
  debounce = "debounce",
  bouncer = "bouncer",
  neverbounce = "neverbounce",
  serp_pattern = "serp_pattern",
}

export enum ProviderType {
  google_workspace = "google_workspace",
  office365 = "office365",
  yahoo = "yahoo",
  other = "other",
}

export interface DomainInfo {
  domain: string;
  has_mx: boolean;
  mx_records: string[];
  provider: ProviderType;
  is_catch_all: boolean;
  is_disposable: boolean;
  is_free_provider: boolean;
  smtp_verifiable: boolean;
}

export interface SerpInfo {
  used: boolean;
  emails_found: number;
  patterns_detected: { pattern: string; count: number; examples: string[] }[];
  direct_match: string | null; // exact match for our target person found in SERP
}

export interface VerificationResult {
  email: string | null;
  status: EmailStatus;
  confidence: number;
  method: VerificationMethod | null;
  pattern: string | null;
  domain_info: DomainInfo | null;
  serp_info: SerpInfo | null;
  permutations_tried: number;
  cost_usd: number;
  duration_ms: number;
}

export interface FindRequest {
  first_name?: string;
  last_name?: string;
  domain: string;
  full_name?: string;
  max_tier?: number;
  force_premium?: boolean;
}

export interface EmailVerificationProvider {
  name: string;
  cost_per_email: number;
  method: VerificationMethod;
  is_configured(): boolean;
  verify(email: string): Promise<VerificationResult>;
}

/** Conclusive statuses that stop the cascade */
export const CONCLUSIVE_STATUSES: EmailStatus[] = [
  EmailStatus.valid,
  EmailStatus.invalid,
  EmailStatus.catch_all,
];
