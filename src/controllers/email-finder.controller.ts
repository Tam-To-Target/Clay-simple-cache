import { Request, Response } from "express";
import { findEmail, verifySingleEmail } from "../email-finder";
import prisma from "../db/prisma";

export const emailFinderController = {
  async find(req: Request, res: Response) {
    try {
      const { first_name, last_name, domain, full_name, max_tier } = req.body;

      if (!domain) {
        res.status(400).json({ error: "domain is required" });
        return;
      }

      if (!first_name && !last_name && !full_name) {
        res.status(400).json({
          error: "At least one of first_name, last_name, or full_name is required",
        });
        return;
      }

      const result = await findEmail({
        first_name,
        last_name,
        domain,
        full_name,
        max_tier: max_tier || 2,
      });

      res.json({
        success: true,
        email: result.email,
        status: result.status,
        confidence: result.confidence,
        method: result.method,
        pattern: result.pattern,
        domain_info: result.domain_info,
        serp_info: result.serp_info,
        permutations_tried: result.permutations_tried,
        cost_usd: result.cost_usd,
        duration_ms: result.duration_ms,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

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
        totalSearches,
        validFound,
        totalCost,
        methodBreakdown,
        domainsCached,
        patternsLearned,
        catchAllCount,
      ] = await Promise.all([
        prisma.searchLog.count(),
        prisma.searchLog.count({ where: { result_status: "valid" } }),
        prisma.searchLog.aggregate({ _sum: { cost_usd: true } }),
        prisma.searchLog.groupBy({
          by: ["method_used"],
          where: { result_status: "valid" },
          _count: true,
        }),
        prisma.domainIntel.count(),
        prisma.domainPattern.count(),
        prisma.searchLog.count({ where: { result_status: "catch_all" } }),
      ]);

      const methods: Record<string, number> = {};
      for (const m of methodBreakdown) {
        if (m.method_used) methods[m.method_used] = m._count;
      }

      const total = totalCost._sum.cost_usd || 0;

      res.json({
        total_searches: totalSearches,
        total_valid_found: validFound,
        success_rate: totalSearches > 0 ? validFound / totalSearches : 0,
        methods_breakdown: methods,
        total_cost_usd: total,
        avg_cost_per_email: totalSearches > 0 ? total / totalSearches : 0,
        domains_in_cache: domainsCached,
        patterns_learned: patternsLearned,
        catch_all_domains: catchAllCount,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },
};
