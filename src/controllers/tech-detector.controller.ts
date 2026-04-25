import { Request, Response } from "express";
import { detectTechnologies, FetchFailError } from "../services/tech-detector.service";

export const techDetectorController = {
  async detect(req: Request, res: Response) {
    try {
      const { url } = req.body;
      if (!url) {
        res.status(400).json({ error: "url is required" });
        return;
      }
      let normalizedUrl = url.trim();
      if (!/^https?:\/\//i.test(normalizedUrl)) {
        normalizedUrl = `https://${normalizedUrl}`;
      }
      try {
        new URL(normalizedUrl);
      } catch {
        res.status(400).json({ error: "Invalid URL format" });
        return;
      }
      const result = await detectTechnologies(normalizedUrl);
      res.json({ success: true, url: normalizedUrl, ...result });
    } catch (error: any) {
      if (error instanceof FetchFailError) {
        // Fetch failures return 200 with success:false so pipelines can handle them gracefully
        res.json({
          success: false,
          url: req.body?.url ?? "",
          reason: error.reason,
          ...(error.httpStatus !== undefined && { http_status: error.httpStatus }),
          message: error.message,
          technologies: "",
          scripts: [],
          links: [],
          meta: [],
        });
        return;
      }
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },
};
