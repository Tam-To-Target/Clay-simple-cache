/**
 * Persistence for client scoring configs. The config lives entirely in our DB —
 * we own consistency and never depend on a third party for a client's rubric.
 *
 * On update we bump config_version so historical score_results stay pinned to
 * the rubric that produced them. Validation is the controller's job (validate
 * BEFORE calling put) — this service assumes a validated document.
 */
import prisma from "../db/prisma";
import type { ScoringConfigDoc } from "../scoring/types";

export interface StoredConfig {
  client_id: string;
  config_version: number;
  document: ScoringConfigDoc;
  updated_at: Date;
}

function toStored(row: {
  client_id: string;
  config_version: number;
  document: unknown;
  updated_at: Date;
}): StoredConfig {
  // The stored document always reflects the authoritative version + client_id.
  const doc = (row.document || {}) as ScoringConfigDoc;
  return {
    client_id: row.client_id,
    config_version: row.config_version,
    document: { ...doc, client_id: row.client_id, config_version: row.config_version },
    updated_at: row.updated_at,
  };
}

export const scoringConfigService = {
  async get(clientId: string): Promise<StoredConfig | null> {
    const row = await prisma.scoringConfig.findUnique({ where: { client_id: clientId } });
    return row ? toStored(row) : null;
  },

  /**
   * Create or update a client's config. New client → config_version 1; existing
   * client → previous version + 1. The caller-supplied config_version in the
   * document is ignored (the server owns versioning).
   */
  async put(clientId: string, document: ScoringConfigDoc): Promise<StoredConfig> {
    // Read-then-write must be atomic: two concurrent PUTs reading the same
    // config_version would otherwise both compute the same next version and one
    // would silently clobber the other (lost update + duplicated version). A
    // Serializable transaction makes the loser fail rather than overwrite.
    const row = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.scoringConfig.findUnique({ where: { client_id: clientId } });
        const nextVersion = existing ? existing.config_version + 1 : 1;
        const stored = { ...document, client_id: clientId, config_version: nextVersion };
        return tx.scoringConfig.upsert({
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
