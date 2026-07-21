/**
 * Slug aliases — reconcile our client `external_id` with GTMOS's `slug` and any
 * legacy/alternate spellings a caller might pass.
 *
 * Two of our client slugs diverge from GTMOS's (a rename or a typo that stuck),
 * which made the convention backfill skip them. This maps:
 *   - our external_id → the GTMOS slug (for the backfill's history lookup);
 *   - a GTMOS/legacy slug → our canonical external_id (so the upload endpoint
 *     still resolves the right customer when handed a variant).
 *
 * Keep this list small and explicit — it's a divergence patch, not a fuzzy
 * matcher. `clients:generate` should eventually converge the slugs; until then
 * these keep uploads + seeding correct.
 */

interface ClientAlias {
  /** GTMOS `clients.slug` for this customer, when it differs from our external_id. */
  gtmos?: string;
  /** Alternate inbound slugs that should resolve to this canonical external_id. */
  aliases?: string[];
}

const CLIENT_ALIASES: Record<string, ClientAlias> = {
  bridgeit: { gtmos: "bridge-it", aliases: ["bridge-it"] },
  gtg: { gtmos: "geographic-technologies-group", aliases: ["geographic-technologies-group"] },
  studer: { gtmos: "studer-education", aliases: ["studer-education"] },
  // Likely a typo dup of `studer`; still map its history to Studer Education.
  studor: { gtmos: "studer-education", aliases: [] },
};

/** The GTMOS slug to look up history under for one of our clients. */
export function gtmosSlugFor(clientExternalId: string): string {
  return CLIENT_ALIASES[clientExternalId]?.gtmos ?? clientExternalId;
}

const CANONICAL_BY_ALIAS: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [canonical, cfg] of Object.entries(CLIENT_ALIASES)) {
    for (const a of cfg.aliases ?? []) m[a] = canonical;
  }
  return m;
})();

/** Resolve an inbound slug (possibly a GTMOS/legacy spelling) to our canonical
 *  client external_id. Returns the input unchanged when it's not a known alias. */
export function canonicalClientSlug(input: string): string {
  return CANONICAL_BY_ALIAS[input] ?? input;
}
