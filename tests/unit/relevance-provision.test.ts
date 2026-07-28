import { describe, it, expect } from "vitest";
import { buildPropertyPlan, DEFAULT_SIGNAL_OBJECT_TYPE } from "../../src/relevance/provision";
import type { RelevanceConfigDoc } from "../../src/relevance/types";

const cfg = (over: Partial<RelevanceConfigDoc> = {}): RelevanceConfigDoc => ({
  client_id: "hilight",
  ai: {
    enabled: true,
    business_context: "Hilight sells staff recognition and culture analytics to K-12 districts.",
    prompts: { Meeting: { prompt: "Tier 1 when the board funded staff-culture work." } },
  },
  hubspot_push: {
    enabled: true,
    tier_field: "sb_tier",
    points_field: "sb_score_points",
    reasoning_field: "sb_ai_reasoning",
    pipeline_stage: "stage-1",
  },
  ...over,
});

const names = (p: ReturnType<typeof buildPropertyPlan>) => p.properties.map((x) => x.name);
const byName = (p: ReturnType<typeof buildPropertyPlan>, n: string) =>
  p.properties.find((x) => x.name === n)!;

describe("buildPropertyPlan — defaults", () => {
  it("plans the spine plus the three verdict properties", () => {
    const p = buildPropertyPlan(cfg());
    expect(p.objectType).toBe(DEFAULT_SIGNAL_OBJECT_TYPE);
    expect(p.group.name).toBe("starbridge_signals");
    // 20 canonical fields, minus `name` (stock hs_name), plus 3 verdict props.
    expect(p.properties).toHaveLength(22);
    expect(names(p)).toContain("sb_signal_id");
    expect(names(p)).toContain("sb_tier");
    expect(names(p)).toContain("sb_score_points");
    expect(names(p)).toContain("sb_ai_reasoning");
  });

  it("never tries to create a HubSpot-defined property", () => {
    // `name` maps to hs_name, which already exists on every record — creating it
    // would fail every run.
    const p = buildPropertyPlan(cfg());
    expect(names(p)).not.toContain("hs_name");
    expect(p.skipped.map((s) => s.name)).toContain("hs_name");
    expect(names(p).some((n) => n.startsWith("hs_"))).toBe(false);
  });

  it("marks the upsert key unique", () => {
    // A non-unique signal id silently breaks the push's record lookup.
    expect(byName(buildPropertyPlan(cfg()), "sb_signal_id").hasUniqueValue).toBe(true);
    const others = buildPropertyPlan(cfg()).properties.filter((p) => p.hasUniqueValue);
    expect(others.map((o) => o.name)).toEqual(["sb_signal_id"]);
  });

  it("gives every property a group, type and fieldType", () => {
    for (const prop of buildPropertyPlan(cfg()).properties) {
      expect(prop.groupName).toBe("starbridge_signals");
      expect(prop.type).toBeTruthy();
      expect(prop.fieldType).toBeTruthy();
      expect(prop.label).toBeTruthy();
      expect(prop.description).toBeTruthy();
    }
  });

  it("uses datetime for every date field", () => {
    const p = buildPropertyPlan(cfg());
    for (const n of ["sb_added_date", "sb_row_created_at", "sb_row_updated_at", "sb_synced_at"]) {
      expect(byName(p, n).type).toBe("datetime");
      expect(byName(p, n).fieldType).toBe("date");
    }
  });
});

describe("buildPropertyPlan — derived from config, not hardcoded", () => {
  // The whole point: provisioning and the push read the same config, so the
  // properties created are exactly the ones that will be written.
  it("follows a field_map rename", () => {
    const c = cfg();
    c.hubspot_push!.field_map = { buyer_id: "starbridge_buyer_id" };
    const p = buildPropertyPlan(c);
    expect(names(p)).toContain("starbridge_buyer_id");
    expect(names(p)).not.toContain("sb_buyer_id");
  });

  it("omits a field the push will not write", () => {
    const c = cfg();
    c.hubspot_push!.field_map = { synced_at: "" };
    const p = buildPropertyPlan(c);
    expect(names(p)).not.toContain("sb_synced_at");
    expect(p.skipped.map((s) => s.name)).toContain("synced_at");
  });

  it("follows renamed verdict fields", () => {
    const c = cfg();
    c.hubspot_push!.tier_field = "signal_tier_custom";
    c.hubspot_push!.points_field = "signal_points_custom";
    c.hubspot_push!.reasoning_field = "signal_why_custom";
    const p = buildPropertyPlan(c);
    expect(names(p)).toContain("signal_tier_custom");
    expect(names(p)).toContain("signal_points_custom");
    expect(names(p)).toContain("signal_why_custom");
    expect(names(p)).not.toContain("sb_tier");
  });

  it("generates the tier enum from the client's ladder", () => {
    // Hardcoding Tier 1/2/3 would make the enum reject a custom label the scorer
    // writes, and the push would 400.
    const c = cfg({
      tiers: [
        { tier: 1, points: 90, label: "Hot", meaning: "call now" },
        { tier: 2, points: 40, label: "Warm", meaning: "queue it" },
      ],
    });
    const tier = byName(buildPropertyPlan(c), "sb_tier");
    expect(tier.options?.map((o) => o.value)).toEqual(["Hot", "Warm"]);
  });

  it("defaults the tier enum to the standard ladder", () => {
    const tier = byName(buildPropertyPlan(cfg()), "sb_tier");
    expect(tier.options?.map((o) => o.value)).toEqual(["Tier 1", "Tier 2", "Tier 3"]);
  });

  it("records the ladder in the points description", () => {
    expect(byName(buildPropertyPlan(cfg()), "sb_score_points").description).toContain("Tier 1=100");
  });

  it("follows a custom object_type", () => {
    const c = cfg();
    c.hubspot_push!.object_type = "2-99887766";
    expect(buildPropertyPlan(c).objectType).toBe("2-99887766");
  });

  it("skips verdict properties that are not configured", () => {
    const c = cfg({ hubspot_push: { enabled: false } });
    const p = buildPropertyPlan(c);
    expect(names(p)).not.toContain("sb_tier");
    // …but the spine is still planned, so a config can be provisioned before push
    // is switched on.
    expect(names(p)).toContain("sb_signal_id");
  });

  it("plans enum options for the Starbridge type fields", () => {
    const p = buildPropertyPlan(cfg());
    expect(byName(p, "sb_filter_type").options?.map((o) => o.value)).toContain("JobChange");
    expect(byName(p, "sb_entity_type").options?.map((o) => o.value)).toContain("Meeting");
    // "Not Interested" WITH the space — the API's query param spells it without one.
    expect(byName(p, "sb_signal_status").options?.map((o) => o.value)).toContain("Not Interested");
  });

  it("produces no duplicate property names", () => {
    const n = names(buildPropertyPlan(cfg()));
    expect(new Set(n).size).toBe(n.length);
  });
});
