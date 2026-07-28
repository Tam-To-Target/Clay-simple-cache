/**
 * Persistence for client relevance configs. Mirrors scoring-config.service:
 * the config lives entirely in our DB, and every update bumps config_version so
 * historical relevance_results stay pinned to the prompt that produced them —
 * which matters more here than for fit scoring, because a prompt edit can change
 * a tier without any input changing.
 *
 * One extra responsibility: the HubSpot **private-app token**. It arrives inside
 * the config document as `hubspot_push.private_app_token`, so an operator can set
 * it per client through the normal config API instead of a per-client env var, but
 * it is split out here into its own column and STRIPPED from the stored document.
 * That keeps it out of every GET response and out of the JSON blob a future reader
 * might log. Only the relevance push ever reads it.
 *
 * Validation is the controller's job (validate BEFORE calling put).
 */
import prisma from "../db/prisma";
import type { RelevanceConfigDoc } from "../relevance/types";

export interface StoredRelevanceConfig {
  client_id: string;
  config_version: number;
  /** Never contains hubspot_push.private_app_token. */
  document: RelevanceConfigDoc;
  /** True when a private-app token is on file. The value is never exposed. */
  private_app_token_set: boolean;
  updated_at: Date;
}

function toStored(row: {
  client_id: string;
  config_version: number;
  document: unknown;
  hubspot_private_app_token: string | null;
  updated_at: Date;
}): StoredRelevanceConfig {
  const doc = (row.document || {}) as RelevanceConfigDoc;
  return {
    client_id: row.client_id,
    config_version: row.config_version,
    document: { ...doc, client_id: row.client_id, config_version: row.config_version },
    private_app_token_set: !!(row.hubspot_private_app_token && row.hubspot_private_app_token.trim()),
    updated_at: row.updated_at,
  };
}

/** Remove the write-only secret from a document before it is persisted. */
function splitToken(document: RelevanceConfigDoc): {
  doc: RelevanceConfigDoc;
  token: string | undefined;
} {
  const push = document.hubspot_push;
  if (!push || push.private_app_token === undefined) return { doc: document, token: undefined };
  const { private_app_token, ...restPush } = push;
  return {
    doc: { ...document, hubspot_push: restPush } as RelevanceConfigDoc,
    token: private_app_token,
  };
}

export const relevanceConfigService = {
  async get(clientId: string): Promise<StoredRelevanceConfig | null> {
    const row = await prisma.relevanceConfig.findUnique({ where: { client_id: clientId } });
    return row ? toStored(row) : null;
  },

  /**
   * The private-app token for a client's relevance push, or null.
   * Deliberately a separate call so the token is only in memory where it is used.
   */
  async getPrivateAppToken(clientId: string): Promise<string | null> {
    const row = await prisma.relevanceConfig.findUnique({
      where: { client_id: clientId },
      select: { hubspot_private_app_token: true },
    });
    const t = row?.hubspot_private_app_token;
    return t && t.trim() ? t.trim() : null;
  },

  /**
   * Create or update. New client → version 1; existing → previous + 1. A
   * caller-supplied config_version is ignored (the server owns versioning).
   * Serializable so two concurrent PUTs can't compute the same next version and
   * silently clobber one another.
   *
   * Token semantics: absent → keep whatever is on file; "" → clear it; a value →
   * replace it. So a routine prompt edit never has to resend the secret.
   */
  async put(clientId: string, document: RelevanceConfigDoc): Promise<StoredRelevanceConfig> {
    const { doc, token } = splitToken(document);
    const row = await prisma.$transaction(
      async (tx) => {
        const existing = await tx.relevanceConfig.findUnique({ where: { client_id: clientId } });
        const nextVersion = existing ? existing.config_version + 1 : 1;
        const stored = { ...doc, client_id: clientId, config_version: nextVersion };
        const tokenValue =
          token === undefined
            ? undefined // leave the column untouched
            : token.trim()
              ? token.trim()
              : null; // explicit clear
        return tx.relevanceConfig.upsert({
          where: { client_id: clientId },
          update: {
            config_version: nextVersion,
            document: stored as object,
            ...(tokenValue === undefined ? {} : { hubspot_private_app_token: tokenValue }),
          },
          create: {
            client_id: clientId,
            config_version: nextVersion,
            document: stored as object,
            hubspot_private_app_token: tokenValue ?? null,
          },
        });
      },
      { isolationLevel: "Serializable" }
    );
    return toStored(row);
  },
};
