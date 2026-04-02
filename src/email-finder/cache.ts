import prisma from "../db/prisma";
import { config } from "./config";
import { EmailStatus, VerificationMethod } from "./types";

interface CachedVerification {
  email: string;
  status: EmailStatus;
  confidence: number;
  method: VerificationMethod | null;
}

export async function getCachedVerification(
  email: string
): Promise<CachedVerification | null> {
  const cached = await prisma.verificationCache.findUnique({
    where: { email },
  });

  if (!cached || cached.expires_at <= new Date()) return null;

  return {
    email: cached.email,
    status: cached.status as EmailStatus,
    confidence: cached.confidence,
    method: cached.method as VerificationMethod | null,
  };
}

export async function cacheVerification(
  email: string,
  status: string,
  confidence: number,
  method: string | null
): Promise<void> {
  const expiresAt = new Date(
    Date.now() + config.verification_cache_ttl * 1000
  );

  await prisma.verificationCache.upsert({
    where: { email },
    update: {
      status,
      confidence,
      method,
      verified_at: new Date(),
      expires_at: expiresAt,
    },
    create: {
      email,
      status,
      confidence,
      method,
      verified_at: new Date(),
      expires_at: expiresAt,
    },
  });
}
