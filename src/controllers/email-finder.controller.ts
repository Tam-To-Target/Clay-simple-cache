import { Request, Response } from "express";
import { verifySingleEmail } from "../email-finder";
import prisma from "../db/prisma";

export const emailFinderController = {
  async verify(req: Request, res: Response) {
    try {
      const { email, max_tier } = req.body;

      if (!email) {
        res.status(400).json({ error: "email is required" });
        return;
      }

      const result = await verifySingleEmail(email, max_tier || 2);

      res.json({
        email: result.email,
        status: result.status,
        confidence: result.confidence,
        method: result.method,
        domain_info: result.domain_info,
        cost_usd: result.cost_usd,
        duration_ms: result.duration_ms,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  async stats(_req: Request, res: Response) {
    try {
      const [
        emailsCached,
        validCached,
        catchAllCached,
        methodBreakdown,
        domainsCached,
      ] = await Promise.all([
        prisma.verificationCache.count(),
        prisma.verificationCache.count({ where: { status: "valid" } }),
        prisma.verificationCache.count({ where: { status: "catch_all" } }),
        prisma.verificationCache.groupBy({
          by: ["method"],
          where: { status: "valid" },
          _count: true,
        }),
        prisma.domainIntel.count(),
      ]);

      const methods: Record<string, number> = {};
      for (const m of methodBreakdown) {
        if (m.method) methods[m.method] = m._count;
      }

      res.json({
        emails_cached: emailsCached,
        valid_cached: validCached,
        catch_all_cached: catchAllCached,
        methods_breakdown: methods,
        domains_in_cache: domainsCached,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },
};
