/**
 * Signal → HubSpot property projection.
 *
 * The relevance push writes two things onto the Signal record: the verdict
 * (tier/points/reasoning) and the SPINE — the identity, name, date, buyer and
 * contact properties we designated as the ones worth keeping. Everything else
 * Starbridge sends is deliberately not written here (see the property-group
 * split in `Scoring Project/Starbridge Signal Tiering.md`).
 *
 * Canonical field names below are the config keys for `hubspot_push.field_map`,
 * so a client can point any of them at a differently-named property without a
 * deploy. Defaults match the `sb_*` properties built on Hilight's portal.
 */
import type { ParsedSignal } from "./signal";

/** Canonical field name → default HubSpot property. */
export const DEFAULT_FIELD_MAP: Record<string, string> = {
  name: "hs_name",
  signal_id: "sb_signal_id",
  bridge_id: "sb_bridge_id",
  bridge_name: "sb_bridge_name",
  entity_id: "sb_entity_id",
  entity_type: "sb_entity_type",
  filter_type: "sb_filter_type",
  buyer_id: "sb_buyer_id",
  buyer_name: "sb_buyer_name",
  buyer_state: "sb_buyer_state",
  added_date: "sb_added_date",
  created_at: "sb_row_created_at",
  updated_at: "sb_row_updated_at",
  signal_status: "sb_signal_status",
  synced_at: "sb_synced_at",
  contact_first_name: "sb_contact_first_name",
  contact_last_name: "sb_contact_last_name",
  contact_title: "sb_contact_title",
  contact_email: "sb_contact_email",
  contact_phone: "sb_contact_phone",
};

export const FIELD_NAMES = Object.keys(DEFAULT_FIELD_MAP);

/**
 * Fields written when the record is CREATED but never overwritten afterwards.
 *
 * `signal_status` is here for a concrete reason: Starbridge's `common:status` is
 * an Input column that reads "New" on every signal we have seen, while HubSpot is
 * where a rep actually moves it to Actioned/Saved/Not Interested. Writing
 * Starbridge's copy on every re-score would silently reset the rep's work.
 */
export const DEFAULT_CREATE_ONLY_FIELDS = ["signal_status"];

/** Enum guards — an unexpected option would 400 the whole push, so we drop it. */
const VALID_ENTITY_TYPES = new Set([
  "Buyer", "Meeting", "RFP", "Purchase", "Contact", "JobChange", "Signal", "Conference",
]);
const VALID_FILTER_TYPES = new Set([
  "RFP", "Meeting", "Purchase", "Buyer", "TopBuyer", "Contact", "Signal", "Conference",
  "JobChange", "SequenceBuyer", "SequenceContact", "SequenceJobChange", "VendorPresence",
]);
const VALID_STATUSES = new Set([
  "New", "Actioned", "Saved", "Not Interested", "Attending", "Sponsoring",
]);

/**
 * HubSpot rejects Starbridge's nanosecond precision
 * (`2026-07-27T04:38:58.148935331Z`) — truncate to milliseconds.
 */
export function toHubspotDateTime(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(t);
  if (!m) return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
  const ms = (m[3] || "000").slice(0, 3).padEnd(3, "0");
  return `${m[1]}T${m[2]}.${ms}Z`;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return null;
  const s = String(v).trim();
  return s || null;
}

/** Pull a contact attribute from the normalized columns, or from web_contact. */
function contactField(signal: ParsedSignal, key: string): string | null {
  const direct = str(signal.columns[key]);
  if (direct) return direct;
  const wc = signal.columns["op_template:web_contact"];
  if (wc && typeof wc === "object" && !Array.isArray(wc)) {
    return str((wc as Record<string, unknown>)[key]);
  }
  return null;
}

/**
 * Project a parsed signal onto canonical field values. Nulls mean "no value" and
 * are never written (an absent field must stay absent, not become blank).
 *
 * `syncedAt` is supplied by the caller so the value is identical across a batch.
 */
export function extractSignalFields(
  signal: ParsedSignal,
  syncedAt: string
): Record<string, string | null> {
  const entityType = signal.entityType && VALID_ENTITY_TYPES.has(signal.entityType) ? signal.entityType : null;
  const filterType = signal.filterType && VALID_FILTER_TYPES.has(signal.filterType) ? signal.filterType : null;
  const status = signal.signalStatus && VALID_STATUSES.has(signal.signalStatus) ? signal.signalStatus : null;

  return {
    // `name` falls back to the buyer name so a created record is never unnamed —
    // hs_name is a required property on the Signal object.
    name: str(signal.rowName) || str(signal.buyerName) || `Starbridge signal ${signal.signalId}`,
    signal_id: signal.signalId,
    bridge_id: str(signal.bridgeId),
    bridge_name: str(signal.bridgeName),
    entity_id: str(signal.entityId),
    entity_type: entityType,
    filter_type: filterType,
    buyer_id: str(signal.buyerId),
    buyer_name: str(signal.buyerName),
    buyer_state: str(signal.buyerState),
    added_date: toHubspotDateTime(signal.columns["op:added_date"]),
    created_at: toHubspotDateTime(signal.createdAt),
    updated_at: toHubspotDateTime(signal.updatedAt),
    signal_status: status,
    synced_at: toHubspotDateTime(syncedAt),
    contact_first_name: contactField(signal, "firstName"),
    contact_last_name: contactField(signal, "lastName"),
    contact_title: contactField(signal, "jobTitle"),
    contact_email: contactField(signal, "emailAddress"),
    contact_phone: contactField(signal, "phoneNumber"),
  };
}

/**
 * Build the HubSpot properties payload from canonical values.
 *
 * @param isCreate  create → write everything; update → skip createOnly fields.
 */
export function buildSignalProperties(
  fields: Record<string, string | null>,
  fieldMap: Record<string, string>,
  createOnly: Set<string>,
  isCreate: boolean
): Record<string, string> {
  const props: Record<string, string> = {};
  for (const [canonical, value] of Object.entries(fields)) {
    if (value === null) continue;
    if (!isCreate && createOnly.has(canonical)) continue;
    const prop = fieldMap[canonical];
    if (!prop) continue; // explicitly unmapped → intentionally not written
    props[prop] = value;
  }
  return props;
}

/** Merge a config override over the defaults. An empty-string mapping disables a field. */
export function resolveFieldMap(override?: Record<string, string>): Record<string, string> {
  const map: Record<string, string> = { ...DEFAULT_FIELD_MAP };
  for (const [k, v] of Object.entries(override || {})) {
    if (v === "" || v === null) delete map[k];
    else map[k] = v;
  }
  return map;
}
