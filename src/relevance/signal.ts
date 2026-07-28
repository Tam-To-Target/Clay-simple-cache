/**
 * Parse a RAW Starbridge signal into the shape the scorer needs.
 *
 * The request payload is the Starbridge API response element verbatim — one
 * item from `GET /api/external/feed/all/top-signals` → `result[]`, i.e.
 * `{ bridge, row }`. We do not ask callers to reshape it; the awkwardness of
 * Starbridge's schema is absorbed here.
 *
 * Three properties of that schema drive everything below:
 *
 *  1. There is NO fixed signal schema. `bridge.columns[]` IS the schema and
 *     `row.columns{}` is data keyed by column DISPLAY NAME. So a value can only
 *     be interpreted by joining the two.
 *  2. Contact-enrichment columns are keyed with a PER-BRIDGE UUID prefix
 *     (`5c9c9c39-…:firstName`). The UUID differs per bridge; the suffix is the
 *     stable part, so we normalize by stripping the prefix.
 *  3. `AiAnalysis` columns have NO `key` at all — only a display name. They
 *     cannot be addressed by key, so they are collected separately.
 */

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** `<uuid>:firstName` → `firstName`; `<uuid>$basis:reasoning` → `$basis:reasoning`. */
export function normalizeColumnKey(key: string): string {
  if (!UUID_PREFIX.test(key)) return key;
  if (key.includes("$basis")) return "$basis:reasoning";
  const i = key.indexOf(":");
  return i >= 0 ? key.slice(i + 1) : key;
}

export interface ParsedSignal {
  signalId: string;
  /** `row.name` — the signal's own title (e.g. "East Brunswick Board of Education
   *  Meeting"). Kept separate from buyerName, which falls back to it. */
  rowName: string | null;
  bridgeId: string | null;
  bridgeName: string | null;
  filterType: string | null;
  entityType: string | null;
  entityId: string | null;
  buyerId: string | null;
  buyerName: string | null;
  buyerState: string | null;
  signalStatus: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Normalized key → value, for every populated non-identity column. */
  columns: Record<string, unknown>;
  /** Keyless `AiAnalysis` columns, by display name. */
  aiColumns: Record<string, unknown>;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/**
 * Column keys promoted to top-level identity fields. Excluded from `columns` so
 * the model isn't handed the same fact twice (once as identity, once as data).
 */
const IDENTITY_KEYS = new Set(["common:status", "buyer:name", "buyer:stateName"]);

export type ParseResult = { ok: true; signal: ParsedSignal } | { ok: false; error: string };

/**
 * Parse `{ bridge, row }`. Returns an error (never throws) when the payload
 * isn't a recognizable Starbridge signal, so the controller can 422 cleanly.
 */
export function parseSignal(input: unknown): ParseResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "signal must be an object shaped { bridge, row }" };
  }
  const sig = input as Record<string, any>;
  const bridge = sig.bridge;
  const row = sig.row;
  if (!row || typeof row !== "object") {
    return { ok: false, error: "signal.row is required (pass the Starbridge result[] element verbatim)" };
  }
  if (!row.rowId || typeof row.rowId !== "string") {
    return { ok: false, error: "signal.row.rowId is required — it is the signal's identity" };
  }
  if (!bridge || typeof bridge !== "object") {
    return { ok: false, error: "signal.bridge is required — bridge.columns is the schema for row.columns" };
  }

  // Display name → raw key, from the bridge definition. Columns whose `key` is
  // absent are AiAnalysis columns (see header note 3).
  const keyByName = new Map<string, string | null>();
  const cols = Array.isArray(bridge.columns) ? bridge.columns : [];
  for (const c of cols) {
    if (c && typeof c.name === "string") keyByName.set(c.name, typeof c.key === "string" ? c.key : null);
  }

  const columns: Record<string, unknown> = {};
  const aiColumns: Record<string, unknown> = {};
  let signalStatus: string | null = null;
  let buyerName: string | null = null;
  let buyerState: string | null = null;

  const rowCols = row.columns && typeof row.columns === "object" ? row.columns : {};
  for (const [name, cell] of Object.entries(rowCols as Record<string, any>)) {
    const value = cell && typeof cell === "object" ? cell.value : cell;
    if (isEmpty(value)) continue;

    const raw = keyByName.has(name) ? keyByName.get(name) : undefined;
    if (raw === null || raw === undefined) {
      // No key → AiAnalysis column (or a column absent from the bridge schema).
      aiColumns[name] = value;
      continue;
    }
    if (raw === "common:status") signalStatus = String(value);
    else if (raw === "buyer:name") buyerName = String(value);
    else if (raw === "buyer:stateName") buyerState = String(value);

    if (IDENTITY_KEYS.has(raw)) continue;
    columns[normalizeColumnKey(raw)] = value;
  }

  const entity = row.entity && typeof row.entity === "object" ? row.entity : {};

  // `buyer:name` does not exist on Buyer-type bridges (they carry
  // buyer:parentName instead), so fall back to the row name rather than
  // handing the model an unnamed account.
  if (!buyerName && typeof row.name === "string" && row.name.trim()) buyerName = row.name.trim();

  return {
    ok: true,
    signal: {
      signalId: row.rowId,
      rowName: typeof row.name === "string" && row.name.trim() ? row.name.trim() : null,
      bridgeId: typeof bridge.bridgeId === "string" ? bridge.bridgeId : null,
      bridgeName: typeof bridge.name === "string" ? bridge.name : null,
      filterType: typeof bridge.filterType === "string" ? bridge.filterType : null,
      entityType: typeof entity.type === "string" ? entity.type : null,
      entityId: typeof entity.id === "string" ? entity.id : null,
      buyerId: typeof row.buyerId === "string" ? row.buyerId : null,
      buyerName,
      buyerState,
      signalStatus,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null,
      columns,
      aiColumns,
    },
  };
}

/**
 * The evidence block handed to the model. Deliberately JSON, not spliced into
 * the prompt: the prompt text stays the operator's and the facts stay ours.
 *
 * `include_keys` (whitelist) wins over `exclude_keys` (blacklist) when both are
 * set. Both operate on NORMALIZED keys.
 */
export function buildEvidence(
  signal: ParsedSignal,
  opts: { include_keys?: string[]; exclude_keys?: string[] } = {}
): Record<string, unknown> {
  const { include_keys, exclude_keys } = opts;
  let entries = Object.entries(signal.columns);
  if (include_keys && include_keys.length) {
    const allow = new Set(include_keys);
    entries = entries.filter(([k]) => allow.has(k));
  } else if (exclude_keys && exclude_keys.length) {
    const deny = new Set(exclude_keys);
    entries = entries.filter(([k]) => !deny.has(k));
  }

  const evidence: Record<string, unknown> = {
    signal_type: signal.filterType,
    entity_type: signal.entityType,
    buyer: { name: signal.buyerName, state: signal.buyerState },
    bridge_name: signal.bridgeName,
    signal_first_seen: signal.createdAt,
    fields: Object.fromEntries(entries),
  };
  if (Object.keys(signal.aiColumns).length) {
    // Surfaced separately and labelled: these are another model's opinion, not
    // primary evidence, so the prompt can weigh them accordingly.
    evidence.prior_ai_columns = signal.aiColumns;
  }
  return evidence;
}
