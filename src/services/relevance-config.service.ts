/**
 * Persistence for client relevance configs. Mirrors scoring-config.service:
 * the config lives entirely in our DB, and every update bumps config_version so
 * historical relevance_results stay pinned to the prompt that produced them —
 * which matters more here than for fit scoring, because a prompt edit can change
 * a tier without any input changing.
 *
 * Validation is the controller's job (validate BEFORE calling put).
 */
import prisma from "../db/prisma";
import type { RelevanceConfigDoc } from "../relevance/types";

export interface StoredRelevanceConfig {
  client_id: string;
  config_version: number;
  document: RelevanceConfigDoc;
  updated_at: Date;
}

function toStored(row: {
  client_id: string;
  config_version: number;
  document: unknown;
  updated_at: Date;
}): StoredRelevanceConfig {
  const doc = (row.document || {}) as RelevanceConfigDoc;
  return {
    client_id: row.client_id,
    config_version: row.config_version,
    document: { ...doc, client_id: row.client_id, config_version: row.config_version },
    updated_at: row.updated_at,
  };
}

export const relevanceConfigService = {
  async get(clientId: string): Promise<StoredRelevanceConfig | null> {
    const row = await prisma.relevanceConfig.findUnique({ where: { client_id: clientId } });
    return row ? toStored(row) : null;
  },

  /**
   * Create or update. New client → version 1; existing → previous + 1. A
   * caller-supplied config_version is ignored (the server owns versioning).
   * Serializable so two concurrent PUTs can't compute the same next version and
   * silently clobber one another.
   */
  async put(clientId: string, document: RelevanceConfigDoc): Promise<StoredRelevanceConfig> {
    const row = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.relevanceConfig.findUnique({ where: { client_id: clientId } });
        const nextVersion = existing ? existing.config_version + 1 : 1;
        const stored = { ...document, client_id: clientId, config_version: nextVersion };
        return tx.relevanceConfig.upsert({
          where: { client_id: clientId },
          update: { config_version: nextVersion, document: stored as object },
          create: { client_id: clientId, config_version: nextVersion, document: stored as object },
        });
      },
      { isolationLevel: "Serializable" }
    );
    return toStored(row);
  },
};
