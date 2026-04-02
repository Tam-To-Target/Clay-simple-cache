import prisma from "../db/prisma";
import { KnownPattern } from "./permutator";

export async function saveDomainPattern(
  domain: string,
  pattern: string
): Promise<void> {
  const existing = await prisma.domainPattern.findUnique({
    where: { domain_pattern: { domain, pattern } },
  });

  if (existing) {
    await prisma.domainPattern.update({
      where: { id: existing.id },
      data: {
        sample_count: existing.sample_count + 1,
        confidence: Math.min(1.0, existing.confidence + 0.1),
        last_confirmed: new Date(),
      },
    });
  } else {
    await prisma.domainPattern.create({
      data: { domain, pattern, confidence: 1.0, sample_count: 1 },
    });
  }
}

export async function getDomainPatterns(
  domain: string
): Promise<KnownPattern[]> {
  const patterns = await prisma.domainPattern.findMany({
    where: { domain },
    orderBy: [{ confidence: "desc" }, { sample_count: "desc" }],
  });

  return patterns.map((p) => ({
    pattern: p.pattern,
    confidence: p.confidence,
    sample_count: p.sample_count,
  }));
}
