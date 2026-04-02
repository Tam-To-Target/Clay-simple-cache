import dns from "dns";
import { promisify } from "util";
import prisma from "../db/prisma";
import { config } from "./config";
import { DomainInfo, ProviderType } from "./types";
import { checkDisposable, checkFreeProvider } from "./static-lists";

const resolveMx = promisify(dns.resolveMx);

function detectProvider(mxRecords: string[]): ProviderType {
  const lowered = mxRecords.map((mx) => mx.toLowerCase());

  for (const mx of lowered) {
    if (mx.includes("google.com") || mx.includes("googlemail.com"))
      return ProviderType.google_workspace;
  }
  for (const mx of lowered) {
    if (
      mx.includes("outlook.com") ||
      mx.includes("protection.outlook.com") ||
      mx.includes("microsoft.com")
    )
      return ProviderType.office365;
  }
  for (const mx of lowered) {
    if (mx.includes("yahoo.com") || mx.includes("yahoodns.net"))
      return ProviderType.yahoo;
  }
  return ProviderType.other;
}

export async function analyzeDomain(domain: string): Promise<DomainInfo> {
  // 1. Check cache
  const cached = await prisma.domainIntel.findUnique({
    where: { domain },
  });

  if (cached && cached.expires_at > new Date()) {
    return {
      domain: cached.domain,
      has_mx: cached.has_mx,
      mx_records: cached.mx_records as string[],
      provider: cached.provider as ProviderType,
      is_catch_all: cached.is_catch_all,
      is_disposable: cached.is_disposable,
      is_free_provider: cached.is_free_provider,
      smtp_verifiable: cached.provider === "other",
    };
  }

  // 2. MX Lookup
  let mxRecords: string[] = [];
  let hasMx = false;

  try {
    const records = await resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    mxRecords = records.map((r) => r.exchange.replace(/\.$/, ""));
    hasMx = mxRecords.length > 0;
  } catch {
    hasMx = false;
  }

  // 3. Detect provider
  const provider = detectProvider(mxRecords);

  // 4-5. Static checks
  const isDisposable = checkDisposable(domain);
  const isFreeProvider = checkFreeProvider(domain);

  // 6. SMTP verifiable
  const smtpVerifiable = provider === ProviderType.other;

  const expiresAt = new Date(Date.now() + config.domain_cache_ttl * 1000);

  // 7. Cache in DB (upsert)
  await prisma.domainIntel.upsert({
    where: { domain },
    update: {
      has_mx: hasMx,
      mx_records: mxRecords,
      provider,
      is_catch_all: false,
      is_disposable: isDisposable,
      is_free_provider: isFreeProvider,
      checked_at: new Date(),
      expires_at: expiresAt,
    },
    create: {
      domain,
      has_mx: hasMx,
      mx_records: mxRecords,
      provider,
      is_catch_all: false,
      is_disposable: isDisposable,
      is_free_provider: isFreeProvider,
      checked_at: new Date(),
      expires_at: expiresAt,
    },
  });

  return {
    domain,
    has_mx: hasMx,
    mx_records: mxRecords,
    provider,
    is_catch_all: false,
    is_disposable: isDisposable,
    is_free_provider: isFreeProvider,
    smtp_verifiable: smtpVerifiable,
  };
}
