/**
 * Signal → Company association resolution.
 *
 * A tiered signal with no company on it is close to useless: it cannot roll up
 * to an account, cannot be filtered by owner, and never reaches the rep who
 * works that district. So the push resolves a company for every signal it
 * writes.
 *
 * The hard part is not "find a company" — it is "find the RIGHT company without
 * inventing one". Three facts about this data drive every decision below, all
 * observed on Hilight's portal (22493085):
 *
 *  1. `starbridge_buyer_id` on Company is NOT unique. Real collisions exist:
 *     Schenectady City School District has two records under one buyer id
 *     (`schenectady.k12.ny.us` and `schenectadyschools.org`), and buyer id
 *     `f663f78c-…` is stamped on two genuinely DIFFERENT districts (Cherokee
 *     County NC and Cherokee County SC). So a lookup must handle 0, 1 or N.
 *  2. Starbridge emits buyers at three granularities that collapse onto one
 *     domain — district, individual school, and *program*. Blanket-creating a
 *     company per unmatched buyer produced 5 junk records out of 6 when it was
 *     measured, which is why creation is off by default and gated behind config.
 *  3. Buyer state arrives as a full name ("New York") while HubSpot stores an
 *     abbreviation ("NY"), so any state comparison must normalize both sides.
 *
 * Everything here is pure — no HubSpot calls — so the tie-break rules can be
 * tested against the real collisions rather than mocked ones.
 */

/** Company match strategies, in the order they are attempted. */
export type AssociationStrategy = "buyer_id" | "domain" | "name";

export const DEFAULT_STRATEGIES: AssociationStrategy[] = ["buyer_id", "domain", "name"];

/** What to do when a strategy returns more than one company. */
export type OnMultiple = "primary" | "all" | "skip";

export interface AssociationConfig {
  enabled: boolean;
  /** Object to associate to. Default "0-2" (companies). */
  object_type: string;
  /** Ordered ladder; the first strategy that returns any candidate wins. */
  strategies: AssociationStrategy[];
  /** Company property holding Starbridge's buyerId. */
  buyer_id_property: string;
  /** Company property holding the domain. */
  domain_property: string;
  /** Company property holding the account name. */
  name_property: string;
  /** Company property holding the state, used ONLY to disambiguate N>1. */
  state_property: string;
  /** null → use HubSpot's default association type for the pair. */
  association_type_id: number | null;
  on_multiple: OnMultiple;
  /**
   * Create a company when nothing matches. Default FALSE and deliberately so —
   * see fact 2 in the header. Turning this on trades junk records for coverage.
   */
  create_missing_company: boolean;
}

export const DEFAULT_ASSOCIATION_CONFIG: AssociationConfig = {
  enabled: true,
  object_type: "0-2",
  strategies: DEFAULT_STRATEGIES,
  buyer_id_property: "starbridge_buyer_id",
  domain_property: "domain",
  name_property: "name",
  state_property: "state",
  association_type_id: null,
  on_multiple: "primary",
  create_missing_company: false,
};

/** Merge a per-client override over the defaults. */
export function resolveAssociationConfig(override?: Partial<AssociationConfig> | null): AssociationConfig {
  if (!override) return { ...DEFAULT_ASSOCIATION_CONFIG };
  const merged = { ...DEFAULT_ASSOCIATION_CONFIG, ...override };
  if (!Array.isArray(merged.strategies) || !merged.strategies.length) {
    merged.strategies = DEFAULT_STRATEGIES;
  }
  return merged;
}

// ── State normalization ────────────────────────────────────────────────────

const STATE_ABBREV: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "puerto rico": "PR",
};

/**
 * "New York" → "NY", "ny" → "NY", "" → null. Both sides of a state comparison
 * must go through this: Starbridge sends the full name, HubSpot stores either.
 */
export function normalizeState(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  if (STATE_ABBREV[s]) return STATE_ABBREV[s];
  if (/^[a-z]{2}$/.test(s)) return s.toUpperCase();
  return null;
}

// ── Domain extraction ──────────────────────────────────────────────────────

/**
 * Free-mail and platform domains never identify an account. Matching a company
 * on one would attach the signal to whatever junk record owns "gmail.com".
 */
const NON_ACCOUNT_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
  "aol.com", "icloud.com", "me.com", "msn.com", "comcast.net", "verizon.net", "att.net",
  "protonmail.com", "mail.com", "example.com",
]);

/** Strip scheme/host cruft: "https://www.Vineland.org/about" → "vineland.org". */
export function normalizeDomain(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let s = String(value).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.replace(/^www\./, "");
  s = s.replace(/:\d+$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return null;
  if (NON_ACCOUNT_DOMAINS.has(s)) return null;
  return s;
}

/** Domain part of an email address, subject to the same account-domain rules. */
export function domainFromEmail(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1 || at === s.length - 1) return null;
  return normalizeDomain(s.slice(at + 1));
}

/**
 * Column keys that have carried a buyer domain or website across Hilight's
 * bridges. Checked in order; the contact email is last because a contact can
 * work at a different entity than the buyer (a consultant, a vendor rep).
 */
const DOMAIN_COLUMN_KEYS = [
  "buyer:domain", "buyer:website", "buyer:websiteUrl", "domain", "website", "websiteUrl", "url",
];
const EMAIL_COLUMN_KEYS = ["emailAddress", "email", "contactEmail"];

/**
 * Best available domain for a signal, or null. Reads the normalized column map
 * plus the `op_template:web_contact` object, which is where contact-enrichment
 * bridges hide the email.
 */
export function extractDomain(
  columns: Record<string, unknown>,
  contactEmail?: string | null
): string | null {
  for (const key of DOMAIN_COLUMN_KEYS) {
    const d = normalizeDomain(columns[key]);
    if (d) return d;
  }
  for (const key of EMAIL_COLUMN_KEYS) {
    const d = domainFromEmail(columns[key]);
    if (d) return d;
  }
  const wc = columns["op_template:web_contact"];
  if (wc && typeof wc === "object" && !Array.isArray(wc)) {
    const rec = wc as Record<string, unknown>;
    for (const key of DOMAIN_COLUMN_KEYS) {
      const d = normalizeDomain(rec[key]);
      if (d) return d;
    }
    for (const key of EMAIL_COLUMN_KEYS) {
      const d = domainFromEmail(rec[key]);
      if (d) return d;
    }
  }
  return domainFromEmail(contactEmail);
}

// ── Candidate resolution ───────────────────────────────────────────────────

export interface CompanyCandidate {
  id: string;
  properties: Record<string, any>;
}

/**
 * Machine-readable cause when a signal ends up without a company. The `warning`
 * text is for a human reading one response; THIS is what a caller branches on to
 * decide "the account is missing from the CRM" vs "our matching refused a bad
 * candidate" — two situations that need completely different follow-up.
 */
export type AssociationReason =
  /** The signal carries no buyerId, no domain and no buyer name to match on. */
  | "no_match_key"
  /** Every rung was searched and no company matched. The account is not in the CRM. */
  | "no_company_found"
  /** A name matched, but in the wrong state — refused as a wrong match. */
  | "state_mismatch"
  /** Several companies matched and on_multiple="skip". */
  | "ambiguous_match"
  /** No company existed, so one was created (create_missing_company: true). */
  | "company_created"
  /** The association call itself errored. */
  | "hubspot_error";

export interface PickResult {
  /** Companies to associate. Empty when nothing could be resolved safely. */
  chosen: string[];
  /** Non-fatal explanation of a collision or a refusal, surfaced in the response. */
  warning?: string;
  /** Set when `chosen` is empty — why. */
  reason?: AssociationReason;
}

/**
 * Choose which candidate(s) to associate.
 *
 * First a disqualification: on the `name` rung, a candidate whose state is known
 * and DISAGREES with the buyer's is discarded outright, even if it is the only
 * one. Everything after that is ranking among plausible candidates:
 *
 *  1. **State agreement** — the only signal that distinguishes two genuinely
 *     different districts sharing a buyer id (Cherokee NC vs Cherokee SC).
 *     Candidates with no state are not eliminated, only out-ranked, because a
 *     blank state is missing data rather than a contradiction.
 *  2. **Carries the buyer id** — when we matched by name or domain, a record
 *     already stamped with this buyer id is the Starbridge-linked one.
 *  3. **Lowest record id** — the oldest record, which on this portal is
 *     consistently the original and the one with the history on it.
 *
 * Rule 3 always terminates, so "primary" mode never silently drops a signal;
 * the losers are named in `warning` so the duplicates can be cleaned up.
 */
export function pickCompanies(
  candidates: CompanyCandidate[],
  opts: {
    buyerState?: string | null;
    buyerId?: string | null;
    config: AssociationConfig;
    strategy: AssociationStrategy;
  }
): PickResult {
  const { buyerState, buyerId, config, strategy } = opts;
  if (!candidates.length) return { chosen: [] };

  // A name match across a state boundary is simply wrong, and district names
  // repeat heavily in K-12: "Lincoln County School District" in North Carolina
  // matched a Mississippi company on this portal by exact name. So for the weak
  // rung a KNOWN state on both sides that disagrees disqualifies the candidate
  // outright — even when it is the only one. buyer_id and domain are exempt:
  // both are authoritative identifiers, and a state disagreement there means
  // stale CRM data, not the wrong district.
  const requireState = strategy === "name";
  const wantStateEarly = normalizeState(buyerState);
  if (requireState && wantStateEarly) {
    const kept = candidates.filter((c) => {
      const s = normalizeState(c.properties?.[config.state_property]);
      return s === null || s === wantStateEarly;
    });
    if (!kept.length) {
      const seen = candidates
        .map((c) => `${c.id} (${normalizeState(c.properties?.[config.state_property]) ?? "no state"})`)
        .join(", ");
      return {
        chosen: [],
        warning:
          `Name matched ${candidates.length} company/companies — ${seen} — but none is in ` +
          `${wantStateEarly}. District names repeat across states, so this was treated as a wrong ` +
          `match rather than associated.`,
        reason: "state_mismatch",
      };
    }
    candidates = kept;
  }

  if (candidates.length === 1) return { chosen: [candidates[0].id] };

  const ids = candidates.map((c) => c.id).join(", ");
  if (config.on_multiple === "skip") {
    return {
      chosen: [],
      warning:
        `${candidates.length} companies matched by ${strategy} (${ids}) and on_multiple="skip" — ` +
        `not associated. Dedupe them, or set on_multiple to "primary".`,
      reason: "ambiguous_match",
    };
  }
  if (config.on_multiple === "all") {
    return {
      chosen: candidates.map((c) => c.id),
      warning: `${candidates.length} companies matched by ${strategy} (${ids}) — associated to all (on_multiple="all").`,
    };
  }

  let pool = candidates;

  const wantState = normalizeState(buyerState);
  if (wantState) {
    const agree = pool.filter((c) => normalizeState(c.properties?.[config.state_property]) === wantState);
    if (agree.length) pool = agree;
  }

  if (pool.length > 1 && buyerId && strategy !== "buyer_id") {
    const stamped = pool.filter((c) => c.properties?.[config.buyer_id_property] === buyerId);
    if (stamped.length) pool = stamped;
  }

  if (pool.length > 1) {
    pool = [...pool].sort((a, b) => {
      const na = Number(a.id);
      const nb = Number(b.id);
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return a.id.localeCompare(b.id);
    });
  }

  const winner = pool[0];
  const rejected = candidates.filter((c) => c.id !== winner.id).map((c) => c.id);
  return {
    chosen: [winner.id],
    warning:
      `${candidates.length} companies matched by ${strategy} — associated to ${winner.id}, ` +
      `ignored ${rejected.join(", ")}. These look like duplicate company records; dedupe them in HubSpot.`,
  };
}
