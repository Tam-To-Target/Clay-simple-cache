import { Request, Response } from "express";
import { detectTechnologies } from "../services/tech-detector.service";

export const techDetectorController = {
  async detect(req: Request, res: Response) {
    try {
      const { url } = req.body;
      if (!url) {
        res.status(400).json({ error: "url is required" });
        return;
      }
      // Basic URL validation
      try {
        new URL(url);
      } catch {
        res.status(400).json({ error: "Invalid URL format" });
        return;
      }
      const result = await detectTechnologies(url);
      res.json({ success: true, url, ...result });
    } catch (error: any) {
      if (error.message?.includes("Timeout")) {
        res.status(504).json({ error: error.message });
      } else if (error.message?.includes("HTTP ")) {
        res.status(502).json({ error: error.message });
      } else {
        res.status(500).json({ error: error.message || "Internal server error" });
      }
    }
  },
};
