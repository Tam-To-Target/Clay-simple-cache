import { Request, Response } from "express";
import { findLinkedInForDomain } from "../services/linkedin-finder.service";

export const linkedinFinderController = {
  async find(req: Request, res: Response): Promise<void> {
    try {
      const input = req.body?.url ?? req.body?.domain;
      if (!input || typeof input !== "string") {
        res.status(400).json({ error: "url or domain is required" });
        return;
      }

      const result = await findLinkedInForDomain(input);

      if (!result.success && result.reason === "missing_api_key") {
        res.status(503).json(result);
        return;
      }

      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },
};
