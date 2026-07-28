/**
 * Relevance verdict cache + history. Keyed by (client_id, config_version,
 * payload_hash) so re-scoring an unchanged signal under the same prompts never
 * re-bills the model.
 *
 * Note the hash is over the payload we ACTUALLY SEND the model, not the raw
 * Starbridge signal: Starbridge fills cells asynchronously, so the same rowId
 * legitimately produces different evidence over time and must re-score. A
 * prompt edit bumps config_version, which also invalidates — by construction.
 */
import prisma from "../db/prisma";

export interface CachedVerdict {
  tier: number;
  points: number;
  reasoning: string | null;
  config_version: number;
  pushed: boolean;
}

export const relevanceCacheService = {
  async get(clientId: string, configVersion: number, payloadHash: string): Promise<CachedVerdict | null> {
    const row = await prisma.relevanceResult.findUnique({
      where: {
        client_id_config_version_payload_hash: {
          client_id: clientId,
          config_version: configVersion,
          payload_hash: payloadHash,
        },
      },
    });
    if (!row) return null;
    return {
      tier: row.tier,
      points: row.points,
      reasoning: row.reasoning,
      config_version: row.config_version,
      pushed: row.pushed,
    };
  },

  async put(params: {
    clientId: string;
    configVersion: number;
    payloadHash: string;
    signalId: string;
    filterType: string | null;
    tier: number;
    points: number;
    reasoning: string | null;
    payload: unknown;
    pushed: boolean;
  }): Promise<void> {
    const data = {
      signal_id: params.signalId,
      filter_type: params.filterType,
      tier: params.tier,
      points: params.points,
      reasoning: params.reasoning,
      payload: (params.payload ?? {}) as object,
      pushed: params.pushed,
    };
    await prisma.relevanceResult.upsert({
      where: {
        client_id_config_version_payload_hash: {
          client_id: params.clientId,
          config_version: params.configVersion,
          payload_hash: params.payloadHash,
        },
      },
      update: data,
      create: {
        client_id: params.clientId,
        config_version: params.configVersion,
        payload_hash: params.payloadHash,
        ...data,
      },
    });
  },

  async markPushed(clientId: string, configVersion: number, payloadHash: string): Promise<void> {
    await prisma.relevanceResult.updateMany({
      where: { client_id: clientId, config_version: configVersion, payload_hash: payloadHash },
      data: { pushed: true },
    });
  },
};
