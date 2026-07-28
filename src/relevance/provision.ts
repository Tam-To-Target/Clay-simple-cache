/**
 * Provision the HubSpot properties the relevance scorer needs, on the client's
 * Signal object.
 *
 * WHY THIS LIVES HERE and not in the hubspot-provisioner app: the provisioner
 * authenticates with the public OAuth grant, and record access to the Signal
 * object (`0-162`, HubSpot's stock Services object) is not available to a public
 * app at any scope. This service already holds a per-client private-app token for
 * exactly that reason, so the same credential that writes the verdict also creates
 * the fields it writes into. One credential, one place, no reinstall.
 *
 * The plan is DERIVED FROM THE STORED CONFIG rather than hardcoded. So if a client
 * remaps `buyer_id` to `starbridge_buyer_id`, or renames the tier property, or uses
 * a custom tier ladder, provisioning creates exactly the properties that client's
 * push will write — the two can't drift.
 */
import { resolveFieldMap, DEFAULT_FIELD_MAP } from "./hubspot-fields";
import { resolveTiers } from "./validator";
import type { RelevanceConfigDoc } from "./types";

export const DEFAULT_SIGNAL_OBJECT_TYPE = "0-162";
export const DEFAULT_PROPERTY_GROUP = "starbridge_signals";
export const DEFAULT_PROPERTY_GROUP_LABEL = "StarBridge signals";

export interface PropertyDefinition {
  name: string;
  label: string;
  description: string;
  groupName: string;
  type: string;
  fieldType: string;
  options?: Array<{ label: string; value: string; displayOrder: number; hidden: boolean }>;
  hasUniqueValue?: boolean;
}

type Spec = {
  label: string;
  description: string;
  type: string;
  fieldType: string;
  /** Enumeration option values. */
  values?: string[];
  hasUniqueValue?: boolean;
};

/** Starbridge bridge filterTypes. */
const FILTER_TYPES = [
  "RFP", "Meeting", "Purchase", "Buyer", "TopBuyer", "Contact", "Signal",
  "Conference", "JobChange", "SequenceBuyer", "SequenceContact",
  "SequenceJobChange", "VendorPresence",
];

/** Underlying Starbridge entity types. */
const ENTITY_TYPES = [
  "Buyer", "Meeting", "RFP", "Purchase", "Contact", "JobChange", "Signal", "Conference",
];

/**
 * User-facing signal status. NOTE the space in "Not Interested" — Starbridge's
 * query-param vocabulary spells it "NotInterested", but these are the values that
 * actually land on a record.
 */
const SIGNAL_STATUSES = ["New", "Actioned", "Saved", "Not Interested", "Attending", "Sponsoring"];

/** One spec per canonical field in DEFAULT_FIELD_MAP. */
const SPECS: Record<string, Spec> = {
  name: {
    label: "Signal Name",
    description: "The signal's own title from Starbridge (row.name).",
    type: "string",
    fieldType: "text",
  },
  signal_id: {
    label: "Starbridge Signal ID",
    description:
      "Starbridge bridge-row UUID (row.rowId). The scorer's upsert key — must stay unique, or the push cannot locate its record.",
    type: "string",
    fieldType: "text",
    hasUniqueValue: true,
  },
  bridge_id: {
    label: "Bridge ID",
    description: "UUID of the Starbridge Bridge (monitoring definition) that produced this signal.",
    type: "string",
    fieldType: "text",
  },
  bridge_name: {
    label: "Bridge Name",
    description: "Display name of the Bridge. Denormalized — a rename in Starbridge does not backfill.",
    type: "string",
    fieldType: "text",
  },
  entity_id: {
    label: "Entity ID",
    description: "Starbridge UUID of the underlying entity (row.entity.id).",
    type: "string",
    fieldType: "text",
  },
  entity_type: {
    label: "Entity Type",
    description: "The underlying Starbridge entity type.",
    type: "enumeration",
    fieldType: "select",
    values: ENTITY_TYPES,
  },
  filter_type: {
    label: "Bridge Filter Type",
    description: "The class of buyer activity monitored. Selects which scoring prompt runs.",
    type: "enumeration",
    fieldType: "select",
    values: FILTER_TYPES,
  },
  buyer_id: {
    label: "Starbridge Buyer ID",
    description: "row.buyerId — join key to the Starbridge buyer and the crosswalk to the HubSpot Company.",
    type: "string",
    fieldType: "text",
  },
  buyer_name: {
    label: "Buyer Name",
    description: "Account name. Falls back to the signal name on Buyer-type signals, which carry no buyer:name.",
    type: "string",
    fieldType: "text",
  },
  buyer_state: {
    label: "Buyer State",
    description: "Full state name (buyer:stateName).",
    type: "string",
    fieldType: "text",
  },
  added_date: {
    label: "Added to Bridge",
    description: "When Starbridge added this row to the Bridge (op:added_date). Absent on Buyer-type signals.",
    type: "datetime",
    fieldType: "date",
  },
  created_at: {
    label: "Signal Created At",
    description: "row.createdAt — the only date present on every signal type.",
    type: "datetime",
    fieldType: "date",
  },
  updated_at: {
    label: "Signal Updated At",
    description: "row.updatedAt — last change in Starbridge.",
    type: "datetime",
    fieldType: "date",
  },
  signal_status: {
    label: "Signal Status",
    description:
      "User-facing status. Written when the record is created and never overwritten afterwards, so a rep's change is safe from a re-score.",
    type: "enumeration",
    fieldType: "select",
    values: SIGNAL_STATUSES,
  },
  synced_at: {
    label: "Synced to HubSpot At",
    description: "When the scorer last wrote this record. Set by the integration, not Starbridge.",
    type: "datetime",
    fieldType: "date",
  },
  contact_first_name: {
    label: "Contact First Name",
    description: "Normalized from the Bridge's contact-enrichment columns.",
    type: "string",
    fieldType: "text",
  },
  contact_last_name: {
    label: "Contact Last Name",
    description: "Normalized from the Bridge's contact-enrichment columns.",
    type: "string",
    fieldType: "text",
  },
  contact_title: {
    label: "Contact Job Title",
    description: "Normalized from the Bridge's contact-enrichment columns.",
    type: "string",
    fieldType: "text",
  },
  contact_email: {
    label: "Contact Email",
    description: "Normalized from the Bridge's contact-enrichment columns.",
    type: "string",
    fieldType: "text",
  },
  contact_phone: {
    label: "Contact Phone",
    description: "Normalized from the Bridge's contact-enrichment columns.",
    type: "string",
    fieldType: "phonenumber",
  },
};

const opts = (values: string[]) =>
  values.map((v, i) => ({ label: v, value: v, displayOrder: i, hidden: false }));

/**
 * HubSpot-defined properties are never created. `hs_name` is the obvious case: the
 * default map points `name` at it, and it already exists on every record.
 */
function isStockProperty(name: string): boolean {
  return name.startsWith("hs_");
}

export interface PropertyPlan {
  objectType: string;
  group: { name: string; label: string };
  properties: PropertyDefinition[];
  /** Mapped properties intentionally skipped, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Build the exact set of properties this client's config will write.
 *
 * Sources, in order of precedence: `hubspot_push.field_map` for the spine, the
 * three verdict field names, and the tier ladder's labels for the tier enum's
 * options — so the enum can never reject a value the scorer produces.
 */
export function buildPropertyPlan(config: RelevanceConfigDoc): PropertyPlan {
  const push = config.hubspot_push || ({} as NonNullable<RelevanceConfigDoc["hubspot_push"]>);
  const objectType = push.object_type || DEFAULT_SIGNAL_OBJECT_TYPE;
  const groupName = DEFAULT_PROPERTY_GROUP;
  const properties: PropertyDefinition[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  // ── The spine, from the resolved field map ────────────────────────────────
  const fieldMap = resolveFieldMap(push.field_map);
  for (const canonical of Object.keys(DEFAULT_FIELD_MAP)) {
    const propName = fieldMap[canonical];
    if (!propName) {
      skipped.push({ name: canonical, reason: "unmapped in field_map — the push will not write it" });
      continue;
    }
    if (isStockProperty(propName)) {
      skipped.push({ name: propName, reason: "HubSpot-defined property, already exists" });
      continue;
    }
    const spec = SPECS[canonical];
    if (!spec) continue;
    properties.push({
      name: propName,
      label: spec.label,
      description: spec.description,
      groupName,
      type: spec.type,
      fieldType: spec.fieldType,
      ...(spec.values ? { options: opts(spec.values) } : {}),
      ...(spec.hasUniqueValue ? { hasUniqueValue: true } : {}),
    });
  }

  // ── The verdict ───────────────────────────────────────────────────────────
  const tiers = resolveTiers(config);
  if (push.tier_field) {
    properties.push({
      name: push.tier_field,
      label: "Signal Tier",
      description:
        "AI tier. Options are generated from this client's tier ladder, so the enum can never reject a value the scorer writes.",
      groupName,
      type: "enumeration",
      fieldType: "select",
      options: opts(tiers.map((t) => t.label)),
    });
  }
  if (push.points_field) {
    properties.push({
      name: push.points_field,
      label: "Signal Score Points",
      description: `Point value of the tier (${tiers
        .map((t) => `${t.label}=${t.points}`)
        .join(", ")}). Derived in code from the tier, never chosen by the model.`,
      groupName,
      type: "number",
      fieldType: "number",
    });
  }
  if (push.reasoning_field) {
    properties.push({
      name: push.reasoning_field,
      label: "Signal AI Reasoning",
      description: "Short AI explanation citing the specific evidence that set the tier.",
      groupName,
      type: "string",
      fieldType: "textarea",
    });
  }

  return {
    objectType,
    group: { name: groupName, label: DEFAULT_PROPERTY_GROUP_LABEL },
    properties,
    skipped,
  };
}
