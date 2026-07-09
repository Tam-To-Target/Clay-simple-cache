import { Request, Response } from "express";
import { validateConfig } from "../scoring/validator";
import { computeScore, hashValues, findMissingRequiredKeys } from "../scoring/engine";
import { scoringConfigService } from "../services/scoring-config.service";
import { scoringCacheService } from "../services/scoring-cache.service";
import { generateReasoning } from "../services/reasoning.service";
import { clientService } from "../services/client.service";
import { updateObjectProperties, HubspotApiError } from "../services/hubspot-contacts.service";
import { HubspotAccessError } from "../services/hubspot-token.service";
import type { ScoringConfigDoc } from "../scoring/types";

/**
 * Config-driven fit scoring.
 *
 *   POST /score            — score one target against a client's rubric.
 *   PUT  /config/:client_id — create/update a rubric (validate-before-persist).
 *   GET  /config/:client_id — read the current rubric (+ resolved version).
 *
 * THE RULE: scoring is deterministic in the engine. The model only writes the
 * narrative; it can never move the score or the recommendation.
 */
export const scoringController = {
  /**
   * POST /score
   * Body: { client_id, values: {...}, push_to_hubspot?, hubspot_object_id?,
   *         hubspot_object_type? }
   */
  async score(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body || {};
      const { client_id, values, push_to_hubspot } = body;

      if (!client_id || typeof client_id !== "string") {
        res.status(400).json({ error: "client_id is required" });
        return;
      }
      if (!values || typeof values !== "object" || Array.isArray(values)) {
        res.status(400).json({ error: "values must be an object of { criterion_key: value }" });
        return;
      }

      const stored = await scoringConfigService.get(client_id);
      if (!stored) {
        res.status(404).json({ error: `No scoring config for client_id: ${client_id}` });
        return;
      }
      const config = stored.document;

      // 422 — the caller didn't send required criterion keys AT ALL. (A key
      // that's present but null/blank is scored with missing:true instead.)
      const missingKeys = findMissingRequiredKeys(config, values);
      if (missingKeys.length) {
        res.status(422).json({
          error: "Missing required criterion values",
          missing_keys: missingKeys,
        });
        return;
      }

      const valuesHash = hashValues(values);
      const configVersion = stored.config_version;
      const reasoningRequested = !!config.reasoning?.enabled;

      // Validate push preconditions BEFORE computing/billing. A push that can't
      // happen (unconfigured, or no target record) must not waste a model call
      // and must not discard a score we already paid to compute — so we 422
      // here, before any work. (Honors the spec's "push requested but not
      // configured → 422" while never billing for a doomed request.)
      let pushTarget: PushTarget | null = null;
      if (push_to_hubspot === true) {
        const resolved = await resolvePushTarget(config, body, client_id);
        if (!resolved.ok) {
          res.status(422).json({ error: resolved.error });
          return;
        }
        pushTarget = resolved.target;
      }

      // ── Load any cached result. A cached row whose reasoning is still null
      // while reasoning is enabled is a prior FAILED narrative — recompute just
      // the reasoning (the deterministic score itself never changes). ─────────
      const existing = await scoringCacheService.get(client_id, configVersion, valuesHash);
      const needsReasoningRetry = reasoningRequested && existing != null && existing.reasoning == null;
      const fullHit = existing != null && !needsReasoningRetry;

      let finalScore: number;
      let perCriterion;
      let recommendation: string | null;
      let reasoning: string | null;
      let reasoningError: string | undefined;

      if (fullHit) {
        finalScore = existing.final_score;
        perCriterion = existing.per_criterion;
        recommendation = existing.recommendation;
        reasoning = existing.reasoning;
      } else {
        const engine = computeScore(config, values);
        finalScore = engine.final_score;
        perCriterion = engine.per_criterion;
        recommendation = engine.recommendation;

        const r = await generateReasoning({
          reasoning: config.reasoning || { enabled: false },
          finalScore,
          recommendation,
          perCriterion,
        });
        reasoning = r.reasoning;
        reasoningError = r.error;

        // ALWAYS persist the deterministic result — it is the audit trail and
        // the value we may write to a customer's CRM, so it must never be lost
        // just because the (regenerable) narrative failed. Reasoning may be null
        // (disabled or a transient failure); a later identical call retries the
        // reasoning only. Preserve a prior `pushed` flag across a retry.
        await scoringCacheService.put({
          clientId: client_id,
          configVersion,
          valuesHash,
          finalScore,
          recommendation,
          reasoning,
          perCriterion,
          pushed: existing?.pushed ?? false,
        });
      }

      // ── Optional HubSpot push (preconditions already validated above). ─────
      let pushed = false;
      let pushError: string | undefined;
      if (pushTarget) {
        const result = await executePush(pushTarget, finalScore, reasoning);
        if (result.status === "ok") {
          pushed = true;
          await scoringCacheService.markPushed(client_id, configVersion, valuesHash);
        } else {
          pushError = result.error;
        }
      }

      res.json({
        final_score: finalScore,
        config_version: configVersion,
        per_criterion: perCriterion,
        recommendation,
        reasoning,
        cached: fullHit,
        pushed,
        ...(reasoningError ? { reasoning_error: reasoningError } : {}),
        ...(pushError ? { push_error: pushError } : {}),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },

  /** PUT /config/:client_id — validate, then persist with a version bump. */
  async putConfig(req: Request, res: Response): Promise<void> {
    try {
      const clientId = req.params.client_id;
      if (!clientId) {
        res.status(400).json({ error: "client_id path param is required" });
        return;
      }
      const body = (req.body || {}) as ScoringConfigDoc;

      const validation = validateConfig(body);
      if (!validation.valid) {
        // Never store an invalid config — surface a per-field error list.
        res.status(422).json({ error: "Invalid config", errors: validation.errors });
        return;
      }

      const stored = await scoringConfigService.put(clientId, body);
      res.json({
        status: "ok",
        client_id: stored.client_id,
        config_version: stored.config_version,
        config: stored.document,
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },

  /** GET /config/:client_id — the config-authoring skill's read/debug endpoint. */
  async getConfig(req: Request, res: Response): Promise<void> {
    try {
      const clientId = req.params.client_id;
      const stored = await scoringConfigService.get(clientId);
      if (!stored) {
        res.status(404).json({ error: `No scoring config for client_id: ${clientId}` });
        return;
      }
      res.json({
        client_id: stored.client_id,
        config_version: stored.config_version,
        config: stored.document,
        updated_at: stored.updated_at,
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },
};

/** A fully-resolved, ready-to-write HubSpot target for a score push. */
interface PushTarget {
  portalId: string;
  objectType: string;
  objectId: string;
  scoreField: string;
  reasoningField: string;
}

type ResolveResult = { ok: true; target: PushTarget } | { ok: false; error: string };

/**
 * Resolve everything a push needs — WITHOUT touching HubSpot — so the caller can
 * 422 before we compute/bill a score. The target FIELDS come from the
 * pre-configured hubspot_push block; the target RECORD id comes per-call (values
 * carry metrics, not identity). Never accepts a token.
 */
async function resolvePushTarget(
  config: ScoringConfigDoc,
  body: any,
  clientId: string
): Promise<ResolveResult> {
  const push = config.hubspot_push;
  if (!push || !push.enabled || !push.score_field || !push.reasoning_field) {
    return {
      ok: false,
      error:
        "push_to_hubspot requested but hubspot_push is not enabled/configured for this client " +
        "(need hubspot_push.enabled + score_field + reasoning_field).",
    };
  }
  const objectId = body.hubspot_object_id;
  if (!objectId) {
    return {
      ok: false,
      error: "push_to_hubspot requires hubspot_object_id (the target HubSpot record to write onto).",
    };
  }
  const client = await clientService.getByExternalId(clientId);
  if (!client || !client.hubspot_portal_id) {
    return { ok: false, error: `Client ${clientId} has no connected HubSpot portal — cannot push.` };
  }
  return {
    ok: true,
    target: {
      portalId: client.hubspot_portal_id,
      objectType: body.hubspot_object_type || "contacts",
      objectId: String(objectId),
      scoreField: push.score_field,
      reasoningField: push.reasoning_field,
    },
  };
}

type PushOutcome = { status: "ok" } | { status: "failed"; error: string };

/** PATCH the score + reasoning onto the resolved record. */
async function executePush(
  target: PushTarget,
  finalScore: number,
  reasoning: string | null
): Promise<PushOutcome> {
  const properties: Record<string, any> = {
    [target.scoreField]: finalScore,
    [target.reasoningField]: reasoning ?? "",
  };
  try {
    await updateObjectProperties(target.portalId, target.objectType, target.objectId, properties);
    return { status: "ok" };
  } catch (e) {
    if (e instanceof HubspotAccessError) {
      return { status: "failed", error: `HubSpot access not active: ${e.message}` };
    }
    if (e instanceof HubspotApiError) {
      return { status: "failed", error: e.message };
    }
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}
