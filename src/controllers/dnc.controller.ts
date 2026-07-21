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
  syncHubspotSource,
  discoverAndSyncAll,
  discoverAndSyncClient,
} from "../services/dnc-sync.service";
import { fetchListById, searchLists } from "../services/hubspot-lists.service";
import { getValidToken } from "../services/hubspot-token.service";
import { resolveClientSdrs } from "../services/phoneburner-upload.service";

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
          // Namespaced provenance — disjoint from push (`last_push`) and from any
          // caller-supplied property, so writers never clobber each other.
          last_dnc_check: {
            client_id,
            status: match ? "do_not_contact" : "contactable",
            at: new Date().toISOString(),
          },
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
   * Body: { external_id, name?, active?, hubspot_portal_id? }
   */
  async upsertClient(req: Request, res: Response): Promise<void> {
    try {
      const { external_id, name, active, hubspot_portal_id } = req.body || {};
      if (!external_id) {
        res.status(400).json({ error: "external_id is required" });
        return;
      }
      const client = await clientService.upsert({
        external_id,
        name,
        active,
        hubspot_portal_id,
      });
      res.json({ status: "ok", client: publicClient(client) });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * GET /admin/clients — list every customer with their internal name and a
   * roll-up of their data (portal/connection, DNC coverage, contacts, and how
   * many pushed leads are waiting on CRM access). Query: ?active=1 to filter.
   */
  async listClients(req: Request, res: Response): Promise<void> {
    try {
      const activeOnly = req.query.active === "1" || req.query.active === "true";
      const clients = await prisma.client.findMany({
        where: activeOnly ? { active: true } : undefined,
        orderBy: { name: "asc" },
      });

      // Aggregate counts in one round-trip each, then stitch by client id.
      const [sourceCounts, entryCounts, pushRows] = await Promise.all([
        prisma.dncSource.groupBy({ by: ["client_id"], _count: { _all: true } }),
        prisma.dncEntry.groupBy({ by: ["client_id"], _count: { _all: true } }),
        prisma.contactClient.groupBy({
          by: ["client_id", "push_status"],
          _count: { _all: true },
        }),
      ]);

      const srcById = new Map(sourceCounts.map((r) => [r.client_id, r._count._all]));
      const entById = new Map(entryCounts.map((r) => [r.client_id, r._count._all]));
      const contactsById = new Map<string, number>();
      const pushById = new Map<string, Record<string, number>>();
      for (const r of pushRows) {
        contactsById.set(r.client_id, (contactsById.get(r.client_id) ?? 0) + r._count._all);
        if (r.push_status) {
          const m = pushById.get(r.client_id) ?? {};
          m[r.push_status] = r._count._all;
          pushById.set(r.client_id, m);
        }
      }

      const rows = clients.map((c) => {
        const push = pushById.get(c.id) ?? {};
        return {
          ...publicClient(c),
          dnc_sources: srcById.get(c.id) ?? 0,
          dnc_entries: entById.get(c.id) ?? 0,
          contacts: contactsById.get(c.id) ?? 0,
          pending_push: push.pending ?? 0,
          failed_push: push.failed ?? 0,
          pushed: push.pushed ?? 0,
        };
      });

      res.json({ status: "ok", count: rows.length, clients: rows });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * GET /admin/clients/:external_id — inspect a client + its DNC sources + the
   * PhoneBurner SDRs assigned to it (so a caller knows which `sdr` to pass to the
   * upload endpoint). Resolves known slug aliases (e.g. GTMOS-style "bridge-it").
   */
  async getClient(req: Request, res: Response): Promise<void> {
    try {
      // Alias-aware resolution, then reload with dnc_sources included.
      const resolved = await clientService.getByExternalId(req.params.external_id);
      const client = resolved
        ? await prisma.client.findUnique({ where: { id: resolved.id }, include: { dnc_sources: true } })
        : null;
      if (!client) {
        const suggestions = await clientSuggestions(req.params.external_id);
        res.status(404).json({
          error: "Client not found",
          ...(suggestions.length ? { suggestions } : {}),
        });
        return;
      }
      const sdrs = await resolveClientSdrs(client);
      const { dnc_sources, ...rest } = client;
      res.json({ client: { ...publicClient(rest as any), dnc_sources, sdrs } });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * GET /admin/dnc/hubspot-lists?client_id=<slug>&q=<name>
   * Look up a client's HubSpot lists (id + name) so a caller can find a list id
   * from its name before pinning it as a DNC source. `q` filters by name (HubSpot
   * list search); omit to list lists.
   */
  async hubspotLists(req: Request, res: Response): Promise<void> {
    try {
      const clientId = String(req.query.client_id || "");
      const q = typeof req.query.q === "string" ? req.query.q : "";
      if (!clientId) {
        res.status(400).json({ error: "client_id query param is required" });
        return;
      }
      const client = await clientService.getByExternalId(clientId);
      if (!client || !client.active) {
        const suggestions = await clientSuggestions(clientId);
        res.status(404).json({
          error: `Unknown or inactive client_id: ${clientId}`,
          ...(suggestions.length ? { suggestions } : {}),
        });
        return;
      }
      if (!client.hubspot_portal_id) {
        res.status(400).json({ error: `Client ${clientId} has no hubspot_portal_id` });
        return;
      }
      const portalId = client.hubspot_portal_id;
      const lists = await searchLists((force) => getValidToken(portalId, { force }), q);
      res.json({ status: "ok", client_id: clientId, count: lists.length, lists });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },

  /**
   * POST /admin/dnc/lists
   * Body: { client_id, hubspot_list_id, dnc_level: 'individual'|'domain' }
   * Pin a HubSpot list as a DNC source for a client REGARDLESS of its name — the
   * programmatic way to add lists outside the (Individual)/(Domain) convention.
   * Stored with origin='manual' so discovery never auto-deactivates it, then
   * synced immediately.
   */
  async addList(req: Request, res: Response): Promise<void> {
    try {
      const { client_id, hubspot_list_id, dnc_level } = req.body || {};
      if (!client_id || !hubspot_list_id || !dnc_level) {
        res.status(400).json({ error: "client_id, hubspot_list_id, and dnc_level are required" });
        return;
      }
      const level = String(dnc_level).toLowerCase();
      if (level !== "individual" && level !== "domain") {
        res.status(400).json({ error: "dnc_level must be 'individual' or 'domain'" });
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
      if (!client.hubspot_portal_id) {
        res.status(400).json({ error: `Client ${client_id} has no hubspot_portal_id` });
        return;
      }

      const listId = String(hubspot_list_id);
      const portalId = client.hubspot_portal_id;
      // Validate the list exists in this portal + capture its name for the label.
      const meta = await fetchListById((force) => getValidToken(portalId, { force }), listId);
      if (!meta) {
        res.status(404).json({ error: `HubSpot list ${listId} not found in portal ${portalId}` });
        return;
      }

      const source = await prisma.dncSource.upsert({
        where: { client_id_hubspot_list_id: { client_id: client.id, hubspot_list_id: listId } },
        update: { origin: "manual", dnc_level: level, label: meta.name, active: true },
        create: {
          client_id: client.id,
          type: "hubspot_list",
          origin: "manual",
          hubspot_list_id: listId,
          label: meta.name,
          dnc_level: level,
          active: true,
        },
      });

      // Sync membership right away so the pin is immediately effective.
      const sync = await syncHubspotSource(client, source);
      res.json({ status: "ok", client_id, source, sync });
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
        sources_ok: result.sync.filter((s) => s.status === "ok").length,
        sources_error: result.sync.filter((s) => s.status === "error").length,
        clients_no_access: result.discover.filter((d) => d.status === "no_access").map((d) => d.client_external_id),
        ...result,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Internal server error" });
    }
  },
};
