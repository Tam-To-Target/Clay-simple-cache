import { Request, Response } from "express";
import prisma from "../db/prisma";
import { clientService, publicClient, clientSuggestions } from "../services/client.service";
import {
  dncService,
  normalizeCheckIdentifiers,
  normalizeEntry,
  NormalizedDncEntry,
  RawDncEntry,
} from "../services/dnc.service";
import { profileService } from "../services/profile.service";
import { parseCsv, resolveColumn } from "../dnc/csv";
import {
  syncAllHubspotSources,
  syncClient,
  discoverAndSyncAll,
  discoverAndSyncClient,
} from "../services/dnc-sync.service";

export const dncController = {
  /**
   * POST /dnc-check
   * Body: { client_id, email?, phone?, domain? }
   * If the contact is on the client's DNC list → contactable:false + reason.
   * Otherwise → contactable:true + the contact's cached profile data (if any).
   */
  async check(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, email, phone, domain } = req.body || {};

      if (!client_id) {
        res.status(400).json({ error: "client_id is required" });
        return;
      }
      if (!email && !phone && !domain) {
        res.status(400).json({ error: "At least one of email, phone, or domain is required" });
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

      const ids = normalizeCheckIdentifiers({ email, phone, domain });
      const match = await dncService.findMatch(client.id, ids);

      // Cache the checked contact as a profile (best-effort, never throws) so a
      // later GET /profiles can return it with whatever identity we were given.
      // Skipped automatically when only a domain is provided (no profile key).
      await profileService.recordProfile(
        { email: ids.email || undefined, phone_e164: ids.phone_e164 || undefined },
        {
          ...(ids.domain ? { domain: ids.domain } : {}),
          ...(ids.email_domain ? { email_domain: ids.email_domain } : {}),
          source: "dnc_check",
          client_id,
          last_dnc_status: match ? "do_not_contact" : "contactable",
          checked_at: new Date().toISOString(),
        }
      );

      if (match) {
        const { entry, matchedOn, matchedValue } = match;
        res.json({
          client_id,
          contactable: false,
          status: "do_not_contact",
          reason: entry.reason || "Contact is on the client's Do Not Contact list",
          matched_on: matchedOn,
          matched_value: matchedValue,
          source: entry.source
            ? {
                type: entry.source.type,
                label: entry.source.label,
                hubspot_list_id: entry.source.hubspot_list_id,
                synced_at: entry.source.last_synced_at,
              }
            : { type: entry.source_type },
          added_at: entry.created_at,
        });
        return;
      }

      // Not suppressed → return whatever we have cached about the contact.
      const { profile } = await profileService.findProfile({
        email: ids.email || undefined,
        phone_e164: ids.phone_e164 || undefined,
      });

      res.json({
        client_id,
        contactable: true,
        status: "ok",
        contact: profile
          ? {
              ...(profile.data as object),
              id: profile.id,
              email: profile.email,
              linkedin_slug: profile.linkedin_slug,
              phone: profile.phone_e164,
              updated_at: profile.updated_at,
            }
          : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * POST /admin/clients
   * Body: { external_id, name?, active?, hubspot_portal_id?, hubspot_access_token? }
   */
  async upsertClient(req: Request, res: Response): Promise<void> {
    try {
      const { external_id, name, active, hubspot_portal_id, hubspot_access_token } = req.body || {};
      if (!external_id) {
        res.status(400).json({ error: "external_id is required" });
        return;
      }
      const client = await clientService.upsert({
        external_id,
        name,
        active,
        hubspot_portal_id,
        hubspot_access_token,
      });
      res.json({ status: "ok", client: publicClient(client) });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /** GET /admin/clients/:external_id — inspect a client + its DNC sources. */
  async getClient(req: Request, res: Response): Promise<void> {
    try {
      const client = await prisma.client.findUnique({
        where: { external_id: req.params.external_id },
        include: { dnc_sources: true },
      });
      if (!client) {
        const suggestions = await clientSuggestions(req.params.external_id);
        res.status(404).json({
          error: "Client not found",
          ...(suggestions.length ? { suggestions } : {}),
        });
        return;
      }
      const { dnc_sources, ...rest } = client;
      res.json({ client: { ...publicClient(rest as any), dnc_sources } });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * POST /admin/dnc/sources
   * Body: { client_id, type: 'csv'|'hubspot_list', label?, hubspot_list_id?, active? }
   * Registers a DNC source. HubSpot-list sources are upserted by (client, list).
   */
  async upsertSource(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, type, label, hubspot_list_id, active } = req.body || {};
      if (!client_id || !type) {
        res.status(400).json({ error: "client_id and type are required" });
        return;
      }
      if (!["csv", "hubspot_list"].includes(type)) {
        res.status(400).json({ error: "type must be 'csv' or 'hubspot_list'" });
        return;
      }
      if (type === "hubspot_list" && !hubspot_list_id) {
        res.status(400).json({ error: "hubspot_list_id is required for hubspot_list sources" });
        return;
      }

      const client = await clientService.getByExternalId(client_id);
      if (!client) {
        res.status(404).json({ error: `Unknown client_id: ${client_id}` });
        return;
      }

      let source;
      if (type === "hubspot_list") {
        source = await prisma.dncSource.upsert({
          where: { client_id_hubspot_list_id: { client_id: client.id, hubspot_list_id } },
          update: { label, active: active ?? true },
          create: { client_id: client.id, type, label, hubspot_list_id, active: active ?? true },
        });
      } else {
        // CSV sources are keyed by label within a client.
        source =
          (await prisma.dncSource.findFirst({
            where: { client_id: client.id, type: "csv", label: label ?? null },
          })) ??
          (await prisma.dncSource.create({
            data: { client_id: client.id, type: "csv", label, active: active ?? true },
          }));
      }

      res.json({ status: "ok", source });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * POST /admin/dnc/import
   * Body: {
   *   client_id, source_label?, reason?,
   *   csv?: string, entries?: RawDncEntry[],
   *   column_map?: { email?, phone?, domain?, reason? },
   *   mode?: 'replace' | 'append'  (default 'replace')
   * }
   * Imports DNC entries from a CSV string or an explicit entries array.
   */
  async importCsv(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, source_label, reason, csv, entries, column_map, mode } = req.body || {};
      if (!client_id) {
        res.status(400).json({ error: "client_id is required" });
        return;
      }
      if (!csv && !Array.isArray(entries)) {
        res.status(400).json({ error: "Provide either 'csv' (string) or 'entries' (array)" });
        return;
      }

      const client = await clientService.getByExternalId(client_id);
      if (!client) {
        res.status(404).json({ error: `Unknown client_id: ${client_id}` });
        return;
      }

      // Build raw entries from CSV and/or explicit array.
      const rawEntries: RawDncEntry[] = [];

      if (csv) {
        const rows = parseCsv(csv);
        if (rows.length > 0) {
          const headers = Object.keys(rows[0]);
          const emailCol = resolveColumn(headers, "email", column_map);
          const phoneCol = resolveColumn(headers, "phone", column_map);
          const domainCol = resolveColumn(headers, "domain", column_map);
          const reasonCol = resolveColumn(headers, "reason", column_map);

          if (!emailCol && !phoneCol && !domainCol) {
            res.status(400).json({
              error: "CSV must contain at least one of an email, phone, or domain column",
              detected_headers: headers,
            });
            return;
          }

          for (const row of rows) {
            rawEntries.push({
              email: emailCol ? row[emailCol] : null,
              phone: phoneCol ? row[phoneCol] : null,
              domain: domainCol ? row[domainCol] : null,
              reason: (reasonCol ? row[reasonCol] : null) || reason || null,
              data: { source: "csv" },
            });
          }
        }
      }

      if (Array.isArray(entries)) {
        for (const e of entries as RawDncEntry[]) {
          rawEntries.push({ ...e, reason: e.reason || reason || null });
        }
      }

      // Normalize + drop empties.
      const normalized: NormalizedDncEntry[] = [];
      let skipped = 0;
      for (const raw of rawEntries) {
        const n = normalizeEntry(raw);
        if (n) normalized.push(n);
        else skipped++;
      }

      // Get or create the CSV source.
      const source =
        (await prisma.dncSource.findFirst({
          where: { client_id: client.id, type: "csv", label: source_label ?? null },
        })) ??
        (await prisma.dncSource.create({
          data: { client_id: client.id, type: "csv", label: source_label ?? null },
        }));

      const useAppend = mode === "append";
      const count = useAppend
        ? await dncService.appendSourceEntries(client.id, source.id, "csv", normalized)
        : await dncService.replaceSourceEntries(client.id, source.id, "csv", normalized);

      await prisma.dncSource.update({
        where: { id: source.id },
        data: { last_synced_at: new Date(), last_sync_status: "ok", last_entry_count: count },
      });

      res.json({
        status: "ok",
        client_id,
        source_id: source.id,
        mode: useAppend ? "append" : "replace",
        imported: count,
        skipped,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * POST /admin/dnc/sync
   * Body: { client_id? }  — sync one client or (if omitted) all clients.
   * Pulls current HubSpot list memberships into the DNC tables. Cron-friendly.
   */
  async sync(req: Request, res: Response): Promise<void> {
    try {
      const { client_id } = req.body || {};

      if (client_id) {
        const client = await clientService.getByExternalId(client_id);
        if (!client) {
          res.status(404).json({ error: `Unknown client_id: ${client_id}` });
          return;
        }
        const results = await syncClient(client);
        res.json({ status: "ok", scope: "client", client_id, results });
        return;
      }

      const results = await syncAllHubspotSources();
      res.json({ status: "ok", scope: "all", sources_synced: results.length, results });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * POST /admin/dnc/discover
   * Body: { client_id? } — re-discover + sync one client or (if omitted) all.
   * Re-scans each portal for "<prefix> …" lists, (re)classifies them as
   * individual/domain, registers/deactivates sources, then syncs membership.
   * This is the cron-friendly "keep everything fresh" entry point.
   */
  async discover(req: Request, res: Response): Promise<void> {
    try {
      const { client_id } = req.body || {};

      if (client_id) {
        const client = await clientService.getByExternalId(client_id);
        if (!client) {
          const suggestions = await clientSuggestions(client_id);
          res.status(404).json({
            error: `Unknown client_id: ${client_id}`,
            ...(suggestions.length ? { suggestions } : {}),
          });
          return;
        }
        const result = await discoverAndSyncClient(client);
        res.json({ status: "ok", scope: "client", client_id, ...result });
        return;
      }

      const result = await discoverAndSyncAll();
      res.json({
        status: "ok",
        scope: "all",
        clients_discovered: result.discover.length,
        sources_synced: result.sync.length,
        ...result,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },
};
