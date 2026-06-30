/**
 * Contact ↔ Customer associations (Phase 3).
 *
 * The layer that turns the global, deduplicated contact database into a
 * multi-tenant one: a single canonical Profile can be linked to many customers.
 * This powers per-customer TAM-list building and the cross-customer
 * enrichment-reuse ("credits we didn't spend twice") metric.
 */
import prisma from "../db/prisma";

export interface AssociateParams {
  contactId: string;
  clientId: string;
  source?: string;
  /** Was enrichment data already cached when this customer asked for it? */
  reusedCache?: boolean;
}

export interface ListFilters {
  /** Only contacts that have an email. */
  requireEmail?: boolean;
  /** Only contacts that have a phone. */
  requirePhone?: boolean;
  /** Email domain filter, e.g. "acme.com" → email ends with "@acme.com". */
  domain?: string;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 500;

export const contactClientService = {
  /** Link a contact to a customer (idempotent on (contact_id, client_id)). */
  async associate(params: AssociateParams) {
    const { contactId, clientId, source = "manual", reusedCache = false } = params;
    return prisma.contactClient.upsert({
      where: { contact_id_client_id: { contact_id: contactId, client_id: clientId } },
      update: {
        // Re-association refreshes enrichment recency; never downgrades source.
        last_enriched_at: new Date(),
        ...(reusedCache ? { reused_cache: true } : {}),
      },
      create: {
        contact_id: contactId,
        client_id: clientId,
        source,
        reused_cache: reusedCache,
        last_enriched_at: new Date(),
      },
    });
  },

  /** Build a list of a customer's contacts (the "TAM list" surface). */
  async listForClient(clientId: string, filters: ListFilters = {}) {
    const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? 100));
    const offset = Math.max(0, filters.offset ?? 0);

    const contactWhere: Record<string, unknown> = {};
    const and: Record<string, unknown>[] = [];
    if (filters.requireEmail) and.push({ email: { not: null } });
    if (filters.requirePhone) and.push({ phone_e164: { not: null } });
    if (filters.domain) and.push({ email: { endsWith: `@${filters.domain.toLowerCase()}` } });
    if (and.length) contactWhere.AND = and;

    const [rows, total] = await Promise.all([
      prisma.contactClient.findMany({
        where: { client_id: clientId, contact: contactWhere },
        include: { contact: true },
        orderBy: { first_seen_at: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.contactClient.count({ where: { client_id: clientId, contact: contactWhere } }),
    ]);

    return {
      total,
      limit,
      offset,
      contacts: rows.map((r) => ({
        contact_id: r.contact_id,
        email: r.contact.email,
        phone_e164: r.contact.phone_e164,
        linkedin_url: r.contact.linkedin_url,
        data: r.contact.data,
        source: r.source,
        reused_cache: r.reused_cache,
        first_seen_at: r.first_seen_at,
        last_enriched_at: r.last_enriched_at,
      })),
    };
  },

  /** Per-customer association count. */
  async countForClient(clientId: string): Promise<number> {
    return prisma.contactClient.count({ where: { client_id: clientId } });
  },

  /**
   * Cross-customer reuse: contacts linked to ≥2 customers, and the count of
   * "extra" links beyond the first per contact — i.e. enrichment we served from
   * cache instead of paying again.
   */
  async reuseStats(): Promise<{ sharedContacts: number; reusedLinks: number; totalLinks: number }> {
    const rows = await prisma.$queryRaw<{ shared: bigint; reused: bigint; total: bigint }[]>`
      SELECT
        count(*) FILTER (WHERE n >= 2)        AS shared,
        coalesce(sum(n - 1), 0)               AS reused,
        coalesce(sum(n), 0)                   AS total
      FROM (
        SELECT contact_id, count(*)::int AS n
          FROM contact_clients
         GROUP BY contact_id
      ) t
    `;
    const r = rows[0] ?? { shared: 0n, reused: 0n, total: 0n };
    return {
      sharedContacts: Number(r.shared),
      reusedLinks: Number(r.reused),
      totalLinks: Number(r.total),
    };
  },
};
