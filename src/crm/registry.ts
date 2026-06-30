/**
 * Resolve a CrmAdapter by platform name. Adding a CRM is one registration here
 * plus a new adapter file. GTMOS keeps a parallel registry against the same
 * contract (lib/crm/registry.ts).
 */
import type { CrmAdapter } from "./adapter";
import { hubSpotCrmAdapter } from "./hubspot.adapter";

const ADAPTERS: Record<string, CrmAdapter> = {
  hubspot: hubSpotCrmAdapter,
};

/** Adapter for a platform string (case-insensitive), or null if unsupported. */
export function getCrmAdapter(platform: string | null | undefined): CrmAdapter | null {
  if (!platform) return null;
  return ADAPTERS[platform.toLowerCase()] ?? null;
}

export function supportedCrmPlatforms(): string[] {
  return Object.keys(ADAPTERS);
}
