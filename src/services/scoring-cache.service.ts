/**
 * Score cache + history. Keyed by (client_id, config_version, values_hash) so
 * identical inputs under the same rubric never re-bill the reasoning model, and
 * every computed score is retained (historical rows are never rewritten when the
 * config bumps — they keep their old config_version).
 */
import prisma from "../db/prisma";
import type { PerCriterion } from "../scoring/types";

export interface CachedScore {
  final_score: number;
  config_version: number;
  recommendation: string | null;
  reasoning: string | null;
  per_criterion: PerCriterion[];
  pushed: boolean;
}

export const scoringCacheService = {
  async get(
    clientId: string,
    configVersion: number,
    valuesHash: string
  ): Promise<CachedScore | null> {
    const row = await prisma.scoreResult.findUnique({
      where: {
        client_id_config_version_values_hash: {
          client_id: clientId,
          config_version: configVersion,
          values_hash: valuesHash,
        },
      },
    });
    if (!row) return null;
    return {
      final_score: row.final_score,
      config_version: row.config_version,
      recommendation: row.recommendation,
      reasoning: row.reasoning,
      per_criterion: (row.per_criterion as unknown as PerCriterion[]) || [],
      pushed: row.pushed,
    };
  },

  /** Upsert the computed score. Called only when a result is cache-worthy. */
  async put(params: {
    clientId: string;
    configVersion: number;
    valuesHash: string;
    finalScore: number;
    recommendation: string | null;
    reasoning: string | null;
    perCriterion: PerCriterion[];
    pushed: boolean;
  }): Promise<void> {
    const data = {
      final_score: params.finalScore,
      recommendation: params.recommendation,
      reasoning: params.reasoning,
      per_criterion: params.perCriterion as unknown as object,
      pushed: params.pushed,
    };
    await prisma.scoreResult.upsert({
      where: {
        client_id_config_version_values_hash: {
          client_id: params.clientId,
          config_version: params.configVersion,
          values_hash: params.valuesHash,
        },
      },
      update: data,
      create: {
        client_id: params.clientId,
        config_version: params.configVersion,
        values_hash: params.valuesHash,
        ...data,
      },
    });
  },

  /** Mark an already-cached result as pushed (after a successful HubSpot push). */
  async markPushed(clientId: string, configVersion: number, valuesHash: string): Promise<void> {
    await prisma.scoreResult.updateMany({
      where: { client_id: clientId, config_version: configVersion, values_hash: valuesHash },
      data: { pushed: true },
    });
  },
};
