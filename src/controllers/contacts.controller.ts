import { Request, Response } from "express";
import { clientService, clientSuggestions } from "../services/client.service";
import { profileService } from "../services/profile.service";
import { contactClientService } from "../services/contact-client.service";
import { canAccessSlug } from "../middleware/identity.middleware";
import { normalizeEmail } from "../services/normalization";

export const contactsController = {
  /**
   * POST /admin/contacts/associate   (service auth)
   * Body: { client_id, contact_id? , email?, source?, reused_cache? }
   * Links a canonical contact to a customer. Resolves the contact by id, or by
   * email when no id is given.
   */
  async associate(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, contact_id, email, source, reused_cache } = req.body || {};
      if (!client_id) {
        res.status(400).json({ error: "client_id is required" });
        return;
      }
      const client = await clientService.getByExternalId(client_id);
      if (!client || !client.active) {
        const suggestions = await clientSuggestions(client_id);
        res.status(404).json({
          error: `Unknown or inactive client_id: ${client_id}`,
          ...(suggestions.length ? { suggestions } : {}),
        });
        return;
      }

      let resolvedContactId: string | null = contact_id ?? null;
      if (!resolvedContactId) {
        if (!email) {
          res.status(400).json({ error: "Provide contact_id or email" });
          return;
        }
        const { profile } = await profileService.findProfile({ email: normalizeEmail(String(email)) });
        if (!profile) {
          res.status(404).json({ error: `No contact found for email ${email}` });
          return;
        }
        resolvedContactId = String(profile.id);
      }

      const link = await contactClientService.associate({
        contactId: resolvedContactId as string,
        clientId: client.id,
        source,
        reusedCache: !!reused_cache,
      });
      res.json({ status: "ok", association: link });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * GET /clients/:slug/contacts   (user-scoped — X-User-Token)
   * Query: require_email, require_phone, domain, limit, offset
   * Builds a TAM list of the customer's contacts. The caller must have access
   * to the customer in GTMOS.
   */
  async buildList(req: Request, res: Response): Promise<void> {
    try {
      const slug = req.params.slug;
      const identity = req.identity;
      if (!identity) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (!canAccessSlug(identity, slug)) {
        res.status(403).json({ error: `No access to customer "${slug}"` });
        return;
      }
      const client = await clientService.getByExternalId(slug);
      if (!client || !client.active) {
        res.status(404).json({ error: `Unknown or inactive client: ${slug}` });
        return;
      }

      const q = req.query;
      const result = await contactClientService.listForClient(client.id, {
        requireEmail: q.require_email === "1" || q.require_email === "true",
        requirePhone: q.require_phone === "1" || q.require_phone === "true",
        domain: typeof q.domain === "string" ? q.domain : undefined,
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      });
      res.json({ status: "ok", client_id: slug, ...result });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /** GET /admin/contacts/reuse-stats   (service auth) — enrichment-reuse savings. */
  async reuseStats(_req: Request, res: Response): Promise<void> {
    try {
      const stats = await contactClientService.reuseStats();
      res.json({ status: "ok", ...stats });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },
};
