import { Request, Response } from "express";
import { validateConfig } from "../scoring/validator";
import { computeScore, hashValues, findMissingRequiredKeys } from "../scoring/engine";
import { isBlank } from "../scoring/criteria";
import { scoringConfigService } from "../services/scoring-config.service";
import { scoringCacheService } from "../services/scoring-cache.service";
import { generateReasoning } from "../services/reasoning.service";
import { clientService } from "../services/client.service";
import {
  updateObjectProperties,
  searchCompanyIdsByDomain,
  createObject,
  getObjectProperties,
  HubspotApiError,
} from "../services/hubspot-contacts.service";
import { HubspotAccessError } from "../services/hubspot-token.service";
import { normalizeDomain } from "../services/normalization";
import type { ScoringConfigDoc } from "../scoring/types";

/** Required account-identity properties on every /fit-score call (outside
 *  `values`). They are our primary HubSpot ID properties and are written to the
 *  record on push. */
const REQUIRED_IDENTITY = ["account_name", "account_domain", "starbridge_id"] as const;
type IdentityKey = (typeof REQUIRED_IDENTITY)[number];

/** Fallback identity → HubSpot property mapping when a config doesn't override.
 *  name/domain are HubSpot Company defaults; starbridge_id is custom but assumed
 *  to exist on the portal. */
const DEFAULT_IDENTITY_MAP: Record<IdentityKey, string> = {
  account_name: "name",
  account_domain: "domain",
  starbridge_id: "starbridge_id",
};

/** Scored entities are always districts → HubSpot Companies. */
const FIT_OBJECT_TYPE = "companies";

/**
 * Config-driven FIT scoring (one of several score types — hence /fit-score).
 *
 *   POST /fit-score         — score one target against a client's rubric.
 *   PUT  /config/:client_id — create/update a rubric (validate-before-persist).
 *   GET  /config/:client_id — read the current rubric (+ resolved version).
 *
 * THE RULE: scoring is deterministic in the engine. The model only writes the
 * narrative; it can never move the score or the recommendation.
 */
export const scoringController = {
  /**
   * POST /fit-score
   * Body: {
   *   client_id, values: {...},
   *   account_name, account_domain, starbridge_id,   // REQUIRED identity props
   *   reasoning?: boolean,                            // default true; false = skip
   *   push_to_hubspot?, hubspot_object_id?, hubspot_object_type?
   * }
   */
  async fitScore(req: Request, res: Response): Promise<void> {
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

      // Required account-identity properties (outside `values`). Missing any →
      // 422; these are our HubSpot ID properties and get pushed to the record.
      const identity: Record<IdentityKey, string> = {} as any;
      const missingIdentity = REQUIRED_IDENTITY.filter((k) => isBlank(body[k]));
      if (missingIdentity.length) {
        res.status(422).json({
          error: "Missing required account identity properties",
          missing_fields: missingIdentity,
        });
        return;
      }
      for (const k of REQUIRED_IDENTITY) identity[k] = String(body[k]).trim();
      // Normalize the domain to a bare host (strip scheme/www/path/port) so it
      // matches HubSpot's stored `domain` and dedupes across URL formats
      // (e.g. "http://www.elks.net" and "https://elks.net/" → "elks.net").
      identity.account_domain = normalizeDomain(identity.account_domain) || identity.account_domain.toLowerCase();

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

      // Reasoning is ON by default (subject to the config), but a caller can turn
      // it OFF per-call with { "reasoning": false } — e.g. for cheap/fast bulk
      // scoring. The flag can only suppress; it cannot force reasoning on when
      // the config has it disabled.
      const reasoningOff = body.reasoning === false || body.reasoning === "false";
      const reasoningOn = !!config.reasoning?.enabled && !reasoningOff;

      // Validate push preconditions BEFORE computing/billing. A push that can't
      // happen (unconfigured, or no target record) must not waste a model call
      // and must not discard a score we already paid to compute — so we 422
      // here, before any work.
      let pushTarget: PushTarget | null = null;
      if (push_to_hubspot === true) {
        const resolved = await resolvePushTarget(config, body, client_id, identity);
        if (!resolved.ok) {
          res.status(422).json({ error: resolved.error });
          return;
        }
        pushTarget = resolved.target;
      }

      // ── Load any cached result. A cached row whose reasoning is still null
      // while reasoning is ON for THIS call is a prior failed/skipped narrative —
      // recompute just the reasoning (the deterministic score never changes). ──
      const existing = await scoringCacheService.get(client_id, configVersion, valuesHash);
      const needsReasoningRetry = reasoningOn && existing != null && existing.reasoning == null;
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

        if (reasoningOn) {
          const r = await generateReasoning({
            reasoning: config.reasoning || { enabled: false },
            finalScore,
            recommendation,
            perCriterion,
          });
          reasoning = r.reasoning;
          reasoningError = r.error;
        } else {
          // Reasoning turned off for this call — don't generate. Keep any prior
          // narrative if one is already cached (free), else null.
          reasoning = existing?.reasoning ?? null;
        }

        // ALWAYS persist the deterministic result — it is the audit trail and
        // the value we may write to a customer's CRM, so it must never be lost
        // just because the (regenerable) narrative failed or was skipped.
        // Preserve a prior `pushed` flag across a recompute.
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
      let pushAction: "created" | "updated" | undefined;
      let pushObjectId: string | undefined;
      if (pushTarget) {
        const result = await executePush(pushTarget, finalScore, reasoning, identity);
        if (result.status === "ok") {
          pushed = true;
          pushAction = result.action;
          pushObjectId = result.objectId;
          await scoringCacheService.markPushed(client_id, configVersion, valuesHash);
        } else {
          pushError = result.error;
        }
      }

      res.json({
        final_score: finalScore,
        config_version: configVersion,
        account: identity,
        per_criterion: perCriterion,
        recommendation,
        reasoning,
        cached: fullHit,
        pushed,
        ...(pushAction ? { push_action: pushAction } : {}),
        ...(pushObjectId ? { hubspot_object_id: pushObjectId } : {}),
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

/** A fully-resolved, ready-to-write HubSpot target for a score push. Scored
 *  entities are always Companies. `objectId` may be null — then we resolve the
 *  company by normalized domain (update if found, create if not). */
interface PushTarget {
  portalId: string;
  objectId: string | null;
  domain: string;
  scoreField: string;
  reasoningField: string;
  /** Resolved identity → HubSpot property mapping (config override or defaults). */
  identityMap: Record<IdentityKey, string>;
  /** When true, backfill EMPTY identity props on update (never overwrite). */
  backfillIdentity: boolean;
}

type ResolveResult = { ok: true; target: PushTarget } | { ok: false; error: string };

/**
 * Resolve everything a push needs — WITHOUT touching HubSpot — so the caller can
 * 422 before we compute/bill a score. The target FIELDS + identity mapping come
 * from the pre-configured hubspot_push block (or defaults). The target RECORD is
 * either an explicit `hubspot_object_id`, or (when absent) resolved from the
 * normalized account domain at push time. Never accepts a token.
 */
async function resolvePushTarget(
  config: ScoringConfigDoc,
  body: any,
  clientId: string,
  identity: Record<IdentityKey, string>
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
  const client = await clientService.getByExternalId(clientId);
  if (!client || !client.hubspot_portal_id) {
    return { ok: false, error: `Client ${clientId} has no connected HubSpot portal — cannot push.` };
  }
  // Identity mapping: config override merged over the HubSpot-default map.
  const cfgMap = push.identity_fields || {};
  const identityMap: Record<IdentityKey, string> = {
    account_name: cfgMap.account_name || DEFAULT_IDENTITY_MAP.account_name,
    account_domain: cfgMap.account_domain || DEFAULT_IDENTITY_MAP.account_domain,
    starbridge_id: cfgMap.starbridge_id || DEFAULT_IDENTITY_MAP.starbridge_id,
  };
  return {
    ok: true,
    target: {
      portalId: client.hubspot_portal_id,
      objectId: body.hubspot_object_id ? String(body.hubspot_object_id) : null,
      domain: identity.account_domain,
      scoreField: push.score_field,
      reasoningField: push.reasoning_field,
      identityMap,
      backfillIdentity: !!push.backfill_identity,
    },
  };
}

type PushOutcome =
  | { status: "ok"; action: "created" | "updated"; objectId: string }
  | { status: "failed"; error: string };

/**
 * Write the score + reasoning + mapped identity props onto the client's Company.
 * Target resolution: explicit object id → update it; otherwise search Companies
 * by the normalized domain → update the match (create if none exists). Domain is
 * our dedupe key, so a re-push lands on the same record instead of duplicating.
 */
async function executePush(
  target: PushTarget,
  finalScore: number,
  reasoning: string | null,
  identity: Record<IdentityKey, string>
): Promise<PushOutcome> {
  // On UPDATE we write the score + reasoning, and — only if backfill_identity is
  // on — identity props that are currently EMPTY on the record (never overwrite
  // a non-empty value). Default (flag off): score + reasoning only. This avoids
  // clobbering the CRM's canonical identity, since our request's account_name can
  // legitimately differ (e.g. "Burlingame Elementary School District" vs the
  // CRM's "Burlingame School District").
  const scoreProps: Record<string, any> = {
    [target.scoreField]: finalScore,
    [target.reasoningField]: reasoning ?? "",
  };

  // Build the update payload for an existing company id, applying empty-only
  // identity backfill when enabled.
  const buildUpdateProps = async (objectId: string): Promise<Record<string, any>> => {
    const props: Record<string, any> = { ...scoreProps };
    if (target.backfillIdentity) {
      const fields = REQUIRED_IDENTITY.map((k) => target.identityMap[k]);
      const current = await getObjectProperties(target.portalId, FIT_OBJECT_TYPE, objectId, fields);
      for (const k of REQUIRED_IDENTITY) {
        const field = target.identityMap[k];
        const cur = current[field];
        if (cur === undefined || cur === null || String(cur).trim() === "") props[field] = identity[k];
      }
    }
    return props;
  };

  try {
    // Explicit id wins → update (with optional empty-only backfill).
    if (target.objectId) {
      const props = await buildUpdateProps(target.objectId);
      await updateObjectProperties(target.portalId, FIT_OBJECT_TYPE, target.objectId, props);
      return { status: "ok", action: "updated", objectId: target.objectId };
    }
    // Otherwise resolve by domain (our dedupe key).
    const ids = await searchCompanyIdsByDomain(target.portalId, target.domain);
    if (ids.length >= 1) {
      // On the rare duplicate, write to the first and let the response report it.
      const props = await buildUpdateProps(ids[0]);
      await updateObjectProperties(target.portalId, FIT_OBJECT_TYPE, ids[0], props);
      return { status: "ok", action: "updated", objectId: ids[0] };
    }
    // No existing company for this domain → CREATE one carrying identity + score.
    const createProps: Record<string, any> = { ...scoreProps };
    for (const k of REQUIRED_IDENTITY) createProps[target.identityMap[k]] = identity[k];
    const id = await createObject(target.portalId, FIT_OBJECT_TYPE, createProps);
    return { status: "ok", action: "created", objectId: id };
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
