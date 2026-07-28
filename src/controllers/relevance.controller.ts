import { Request, Response } from "express";
import { validateRelevanceConfig, resolveTiers } from "../relevance/validator";
import { parseSignal, buildEvidence } from "../relevance/signal";
import type { ParsedSignal } from "../relevance/signal";
import {
  extractSignalFields,
  buildSignalProperties,
  resolveFieldMap,
  DEFAULT_CREATE_ONLY_FIELDS,
} from "../relevance/hubspot-fields";
import { hashValues } from "../scoring/engine";
import { buildPropertyPlan } from "../relevance/provision";
import { relevanceConfigService } from "../services/relevance-config.service";
import { relevanceCacheService } from "../services/relevance-cache.service";
import { classifySignal } from "../services/relevance-ai.service";
import { clientService } from "../services/client.service";
import {
  updateObjectProperties,
  searchObjectIdsByProperty,
  createObject,
  listProperties,
  ensurePropertyGroup,
  createProperty,
  HubspotApiError,
} from "../services/hubspot-contacts.service";
import { HubspotAccessError } from "../services/hubspot-token.service";
import type { RelevanceConfigDoc, RelevancePromptConfig, TierDefinition } from "../relevance/types";

/** HubSpot object holding Starbridge signals. On Hilight this is the stock
 *  Services object relabeled "Signals" — hence a numeric objectTypeId, not a
 *  friendly name. Overridable per client via hubspot_push.object_type. */
const DEFAULT_SIGNAL_OBJECT_TYPE = "0-162";
/** Unique property carrying Starbridge's row.rowId. */
const DEFAULT_SIGNAL_ID_FIELD = "sb_signal_id";

/**
 * AI-driven RELEVANCE scoring for Starbridge signals.
 *
 *   POST /relevance-score              — tier one signal.
 *   PUT  /relevance-config/:client_id  — create/update the per-signal-type prompts.
 *   GET  /relevance-config/:client_id  — read the current config (+ version).
 *
 * THE RULE (and how it differs from fit scoring): the model owns the TIER and
 * nothing else. Points are derived from the tier by table lookup in code, so the
 * model has judgment but never arithmetic. A tier outside the configured ladder
 * is an error, never coerced.
 *
 * The request body carries the Starbridge API response element VERBATIM
 * (`{ bridge, row }` from top-signals `result[]`) — callers do not reshape it.
 */
export const relevanceController = {
  /**
   * POST /relevance-score
   * Body: {
   *   client_id,
   *   signal: { bridge, row },          // Starbridge result[] element, verbatim
   *   push_to_hubspot?, hubspot_object_id?
   * }
   * `bridge`/`row` may also be sent at the top level instead of under `signal`.
   */
  async score(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body || {};
      const { client_id, push_to_hubspot } = body;

      if (!client_id || typeof client_id !== "string") {
        res.status(400).json({ error: "client_id is required" });
        return;
      }

      // Accept the Starbridge element either wrapped in `signal` or spread at the
      // top level, so a caller can pipe `result[i]` straight through.
      const raw = body.signal ?? (body.bridge || body.row ? { bridge: body.bridge, row: body.row } : null);
      if (!raw) {
        res.status(400).json({
          error: "signal is required — pass the Starbridge top-signals result[] element ({ bridge, row })",
        });
        return;
      }
      const parsedResult = parseSignal(raw);
      if (!parsedResult.ok) {
        res.status(422).json({ error: parsedResult.error });
        return;
      }
      const signal = parsedResult.signal;

      const stored = await relevanceConfigService.get(client_id);
      if (!stored) {
        res.status(404).json({ error: `No relevance config for client_id: ${client_id}` });
        return;
      }
      const config = stored.document;
      const configVersion = stored.config_version;

      if (!config.ai?.enabled) {
        // Unlike fit-score reasoning, this is not optional — there is no
        // deterministic fallback, so a disabled model means no score at all.
        res.status(422).json({
          error: "ai.enabled is false for this client — relevance scoring is AI-only and cannot proceed",
        });
        return;
      }

      // Resolve the prompt for this signal type. No entry and no default_prompt
      // is a 422: silently scoring a JobChange with a Meeting rubric would be
      // worse than refusing.
      const promptCfg = resolvePrompt(config, signal.filterType);
      if (!promptCfg) {
        res.status(422).json({
          error:
            `No prompt configured for signal type "${signal.filterType}" and no ai.default_prompt is set. ` +
            `Configured types: ${Object.keys(config.ai.prompts || {}).join(", ") || "(none)"}`,
        });
        return;
      }

      const tiers = resolveTiers(config);
      const evidence = buildEvidence(signal, promptCfg);
      // Hash the evidence only — config_version already invalidates on a prompt
      // edit, and Starbridge fills cells asynchronously so the same rowId
      // legitimately re-scores as evidence arrives.
      const payloadHash = hashValues(evidence as Record<string, unknown>);

      // Validate push preconditions BEFORE billing the model, so a push that
      // cannot land never costs a call (mirrors /fit-score).
      let pushTarget: PushTarget | null = null;
      if (push_to_hubspot === true) {
        const resolved = await resolvePushTarget(config, body, client_id);
        if (!resolved.ok) {
          res.status(422).json({ error: resolved.error });
          return;
        }
        pushTarget = resolved.target;
      }

      const cached = await relevanceCacheService.get(client_id, configVersion, payloadHash);

      let tier: number;
      let points: number;
      let reasoning: string | null;
      let modelUsed: string | undefined;

      if (cached) {
        tier = cached.tier;
        points = cached.points;
        reasoning = cached.reasoning;
      } else {
        const out = await classifySignal({
          businessContext: config.ai.business_context,
          rubric: promptCfg.prompt,
          evidence,
          tiers,
          model: promptCfg.model || config.ai.model,
          provider: config.ai.provider,
        });
        if (!out.ok) {
          // 502: the failure is upstream, and there is no score to return.
          res.status(502).json({ error: `Relevance classification failed: ${out.error}` });
          return;
        }
        tier = out.verdict.tier;
        reasoning = out.verdict.reasoning;
        modelUsed = out.model;
        // Points are OURS — derived from the tier, never read from the model.
        points = tierPoints(tiers, tier);

        await relevanceCacheService.put({
          clientId: client_id,
          configVersion,
          payloadHash,
          signalId: signal.signalId,
          filterType: signal.filterType,
          tier,
          points,
          reasoning,
          payload: evidence,
          pushed: false,
        });
      }

      const tierLabel = tiers.find((t) => t.tier === tier)?.label ?? `Tier ${tier}`;

      let pushed = false;
      let pushError: string | undefined;
      let pushAction: "created" | "updated" | undefined;
      let pushObjectId: string | undefined;
      let pushedProperties: string[] | undefined;
      if (pushTarget) {
        const result = await executePush(
          pushTarget,
          signal,
          tierLabel,
          points,
          reasoning,
          new Date().toISOString()
        );
        if (result.status === "ok") {
          pushed = true;
          pushAction = result.action;
          pushObjectId = result.objectId;
          pushedProperties = result.properties;
          await relevanceCacheService.markPushed(client_id, configVersion, payloadHash);
        } else {
          pushError = result.error;
        }
      }

      res.json({
        signal_id: signal.signalId,
        signal_type: signal.filterType,
        tier,
        tier_label: tierLabel,
        points,
        reasoning,
        config_version: configVersion,
        buyer: { id: signal.buyerId, name: signal.buyerName, state: signal.buyerState },
        evidence_fields: Object.keys(evidence.fields as object),
        cached: !!cached,
        pushed,
        ...(modelUsed ? { model: modelUsed } : {}),
        ...(pushAction ? { push_action: pushAction } : {}),
        ...(pushObjectId ? { hubspot_object_id: pushObjectId } : {}),
        ...(pushedProperties ? { pushed_properties: pushedProperties } : {}),
        ...(pushError ? { push_error: pushError } : {}),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },

  /** PUT /relevance-config/:client_id — validate, then persist with a version bump. */
  async putConfig(req: Request, res: Response): Promise<void> {
    try {
      const clientId = req.params.client_id;
      if (!clientId) {
        res.status(400).json({ error: "client_id path param is required" });
        return;
      }
      const body = (req.body || {}) as RelevanceConfigDoc;

      const validation = validateRelevanceConfig(body);
      if (!validation.valid) {
        res.status(422).json({ error: "Invalid relevance config", errors: validation.errors });
        return;
      }

      const stored = await relevanceConfigService.put(clientId, body);
      res.json({
        status: "ok",
        client_id: stored.client_id,
        config_version: stored.config_version,
        signal_types: Object.keys(stored.document.ai?.prompts || {}),
        private_app_token_set: stored.private_app_token_set,
        config: stored.document,
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },

  /**
   * POST /relevance-provision/:client_id
   * GET  /relevance-provision/:client_id   (plan + current status, no writes)
   *
   * Create the HubSpot properties this client's push writes, on their Signal
   * object. Lives here rather than in the hubspot-provisioner because the
   * provisioner authenticates with the public OAuth grant, which cannot reach the
   * Signal object at all — this service already holds the private-app token that
   * can, so the credential that writes the verdict also creates its fields.
   *
   * Idempotent: an existing property is left exactly as-is, never patched.
   */
  async provision(req: Request, res: Response): Promise<void> {
    try {
      const clientId = req.params.client_id;
      const dryRun = req.method === "GET";

      const stored = await relevanceConfigService.get(clientId);
      if (!stored) {
        res.status(404).json({ error: `No relevance config for client_id: ${clientId}` });
        return;
      }
      const plan = buildPropertyPlan(stored.document);

      const client = await clientService.getByExternalId(clientId);
      if (!client || !client.hubspot_portal_id) {
        res.status(422).json({ error: `Client ${clientId} has no connected HubSpot portal.` });
        return;
      }
      const token = await relevanceConfigService.getPrivateAppToken(clientId);
      if (!token) {
        res.status(422).json({
          error:
            "No HubSpot private-app token on file for this client. Set it via " +
            "PUT /relevance-config/:client_id as hubspot_push.private_app_token — the public OAuth " +
            "app cannot reach the Signal object at any scope.",
        });
        return;
      }

      // Always report what already exists, so a dry run is genuinely useful and a
      // real run can be verified afterwards.
      let existing: Set<string>;
      let uniqueOk: Record<string, boolean> = {};
      try {
        const live = await listProperties(client.hubspot_portal_id, plan.objectType, token);
        existing = new Set(live.map((p) => String(p.name)));
        for (const p of plan.properties) {
          if (!p.hasUniqueValue) continue;
          const found = live.find((l) => l.name === p.name);
          if (found) uniqueOk[p.name] = !!found.hasUniqueValue;
        }
      } catch (e) {
        res.status(502).json({
          error: `Could not read properties on ${plan.objectType}: ${e instanceof Error ? e.message : String(e)}`,
        });
        return;
      }

      const planned = plan.properties.map((p) => ({
        name: p.name,
        label: p.label,
        type: p.type,
        fieldType: p.fieldType,
        exists: existing.has(p.name),
        ...(p.hasUniqueValue ? { unique_required: true, unique_on_portal: uniqueOk[p.name] } : {}),
      }));

      if (dryRun) {
        res.json({
          client_id: clientId,
          object_type: plan.objectType,
          group: plan.group,
          total: planned.length,
          present: planned.filter((p) => p.exists).length,
          properties: planned,
          skipped: plan.skipped,
          dry_run: true,
        });
        return;
      }

      const groupResult = await ensurePropertyGroup(
        client.hubspot_portal_id,
        plan.objectType,
        plan.group.name,
        plan.group.label,
        token
      );

      let created = 0;
      let exists = 0;
      const failed: Array<{ name: string; error: string }> = [];
      for (const def of plan.properties) {
        try {
          const r = await createProperty(client.hubspot_portal_id, plan.objectType, def, token);
          if (r === "created") created++;
          else exists++;
        } catch (e) {
          // One bad property must not stop the rest.
          failed.push({ name: def.name, error: e instanceof Error ? e.message : String(e) });
        }
      }

      res.status(failed.length ? 207 : 200).json({
        client_id: clientId,
        object_type: plan.objectType,
        group: { ...plan.group, result: groupResult },
        created,
        already_existed: exists,
        failed,
        total: plan.properties.length,
        skipped: plan.skipped,
        // A pre-existing non-unique upsert key silently breaks the push, so say so.
        warnings: Object.entries(uniqueOk)
          .filter(([, ok]) => !ok)
          .map(([name]) => `${name} exists but is NOT unique — the push cannot reliably locate records. Recreate it as a unique property.`),
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },

  /** GET /relevance-config/:client_id — read/debug endpoint for the skill. */
  async getConfig(req: Request, res: Response): Promise<void> {
    try {
      const clientId = req.params.client_id;
      const stored = await relevanceConfigService.get(clientId);
      if (!stored) {
        res.status(404).json({ error: `No relevance config for client_id: ${clientId}` });
        return;
      }
      res.json({
        client_id: stored.client_id,
        config_version: stored.config_version,
        signal_types: Object.keys(stored.document.ai?.prompts || {}),
        private_app_token_set: stored.private_app_token_set,
        tiers: resolveTiers(stored.document),
        config: stored.document,
        updated_at: stored.updated_at,
      });
    } catch (error: any) {
      res.status(500).json({ error: error?.message || "Internal server error" });
    }
  },
};

/** Pick the rubric for a signal type, falling back to default_prompt. */
function resolvePrompt(config: RelevanceConfigDoc, filterType: string | null): RelevancePromptConfig | null {
  const prompts = config.ai?.prompts || {};
  if (filterType && prompts[filterType]) return prompts[filterType];
  return config.ai?.default_prompt ?? null;
}

/** Tier → points by table lookup. Throws only if the tier passed validation but
 *  isn't in the ladder, which classifySignal already prevents. */
function tierPoints(tiers: TierDefinition[], tier: number): number {
  const hit = tiers.find((t) => t.tier === tier);
  if (!hit) throw new Error(`tier ${tier} is not in the configured ladder`);
  return hit.points;
}

interface PushTarget {
  portalId: string;
  objectType: string;
  signalIdField: string;
  /** Explicit id from the caller; when null we resolve by signalIdField. */
  objectId: string | null;
  tierField: string;
  pointsField: string;
  reasoningField: string;
  createMissing: boolean;
  pipeline?: string;
  pipelineStage?: string;
  /** Canonical field → HubSpot property (defaults merged with config override). */
  fieldMap: Record<string, string>;
  /** Canonical fields written on create but never overwritten on update. */
  createOnly: Set<string>;
  /**
   * HubSpot private-app token for THIS endpoint only. Record access to the Signal
   * object is unavailable to a public OAuth app at any scope, so the push cannot
   * use the provisioner grant. Every other integration in this service still does.
   */
  privateAppToken: string;
}

type ResolveResult = { ok: true; target: PushTarget } | { ok: false; error: string };

/** Resolve push config WITHOUT touching HubSpot, so the caller can 422 before billing. */
async function resolvePushTarget(
  config: RelevanceConfigDoc,
  body: any,
  clientId: string
): Promise<ResolveResult> {
  const push = config.hubspot_push;
  if (!push || !push.enabled || !push.tier_field || !push.points_field || !push.reasoning_field) {
    return {
      ok: false,
      error:
        "push_to_hubspot requested but hubspot_push is not enabled/configured for this client " +
        "(need hubspot_push.enabled + tier_field + points_field + reasoning_field).",
    };
  }
  const client = await clientService.getByExternalId(clientId);
  if (!client || !client.hubspot_portal_id) {
    return { ok: false, error: `Client ${clientId} has no connected HubSpot portal — cannot push.` };
  }
  // The push cannot fall back to the OAuth grant: record read/search/write on the
  // Signal object returns "scope isn't available for public use" regardless of
  // granted scopes. Fail before billing the model rather than after.
  const privateAppToken = await relevanceConfigService.getPrivateAppToken(clientId);
  if (!privateAppToken) {
    return {
      ok: false,
      error:
        "push_to_hubspot requested but no HubSpot private-app token is on file for this client. " +
        "Set it via PUT /relevance-config/:client_id as hubspot_push.private_app_token — the " +
        "public OAuth app cannot reach Signal records at any scope.",
    };
  }
  const createMissing = push.create_missing !== false;
  if (createMissing && !push.pipeline_stage) {
    return {
      ok: false,
      error:
        "hubspot_push.create_missing is enabled but pipeline_stage is not configured — " +
        "the Signal object requires hs_pipeline_stage on create.",
    };
  }
  return {
    ok: true,
    target: {
      portalId: client.hubspot_portal_id,
      objectType: push.object_type || DEFAULT_SIGNAL_OBJECT_TYPE,
      signalIdField: push.signal_id_field || DEFAULT_SIGNAL_ID_FIELD,
      objectId: body.hubspot_object_id ? String(body.hubspot_object_id) : null,
      tierField: push.tier_field,
      pointsField: push.points_field,
      reasoningField: push.reasoning_field,
      createMissing,
      pipeline: push.pipeline,
      pipelineStage: push.pipeline_stage,
      fieldMap: resolveFieldMap(push.field_map),
      createOnly: new Set(push.create_only_fields ?? DEFAULT_CREATE_ONLY_FIELDS),
      privateAppToken,
    },
  };
}

type PushOutcome =
  | { status: "ok"; action: "created" | "updated"; objectId: string; properties: string[] }
  | { status: "failed"; error: string };

/**
 * UPSERT the Signal record: the verdict (tier/points/reasoning) plus the spine
 * properties — identity, name, dates, buyer, contact.
 *
 * Located by `signal_id_field`, which is unique, so a re-score lands on the same
 * record instead of duplicating. Two deliberate asymmetries:
 *
 *  - On UPDATE, `create_only_fields` are skipped (default: signal_status).
 *    Starbridge reports "New" forever; a rep moves it to Actioned in HubSpot, and
 *    re-pushing would silently undo that.
 *  - The wider Starbridge payload (the ~43 detail properties, the raw JSON blobs)
 *    is NOT written here. Those belong to the bulk sync; this path owns the spine.
 */
async function executePush(
  target: PushTarget,
  signal: ParsedSignal,
  tierLabel: string,
  points: number,
  reasoning: string | null,
  syncedAt: string
): Promise<PushOutcome> {
  const verdict: Record<string, any> = {
    [target.tierField]: tierLabel,
    [target.pointsField]: points,
    [target.reasoningField]: reasoning ?? "",
  };
  const fields = extractSignalFields(signal, syncedAt);

  try {
    let objectId = target.objectId;
    if (!objectId) {
      const ids = await searchObjectIdsByProperty(
        target.portalId,
        target.objectType,
        target.signalIdField,
        signal.signalId,
        target.privateAppToken
      );
      if (ids.length > 1) {
        return {
          status: "failed",
          error:
            `${ids.length} ${target.objectType} records share ${target.signalIdField}="${signal.signalId}" ` +
            `(${ids.join(", ")}) — refusing to guess. Dedupe them, or pass hubspot_object_id.`,
        };
      }
      if (!ids.length) {
        if (!target.createMissing) {
          return {
            status: "failed",
            error:
              `No ${target.objectType} record with ${target.signalIdField}="${signal.signalId}" and ` +
              `create_missing is disabled — sync the signal into HubSpot first.`,
          };
        }
        // CREATE: spine (including create-only fields) + verdict + pipeline.
        const createProps: Record<string, any> = {
          ...buildSignalProperties(fields, target.fieldMap, target.createOnly, true),
          ...verdict,
        };
        if (target.pipeline) createProps.hs_pipeline = target.pipeline;
        if (target.pipelineStage) createProps.hs_pipeline_stage = target.pipelineStage;
        const id = await createObject(
          target.portalId,
          target.objectType,
          createProps,
          target.privateAppToken
        );
        return { status: "ok", action: "created", objectId: id, properties: Object.keys(createProps) };
      }
      objectId = ids[0];
    }
    // UPDATE: spine minus create-only fields, + verdict. Pipeline is never
    // rewritten — stage is the record's own workflow state, not ours.
    const updateProps: Record<string, any> = {
      ...buildSignalProperties(fields, target.fieldMap, target.createOnly, false),
      ...verdict,
    };
    await updateObjectProperties(
      target.portalId,
      target.objectType,
      objectId,
      updateProps,
      target.privateAppToken
    );
    return { status: "ok", action: "updated", objectId, properties: Object.keys(updateProps) };
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
