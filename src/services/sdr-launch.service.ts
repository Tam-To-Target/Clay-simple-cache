/**
 * GTMOS (SDR Launch) internal API client.
 *
 * GTMOS is the single source of truth for customer identity (slug ↔ portal),
 * SDR→PhoneBurner dialing assignment, and user accounts/access. This service is
 * how the Contact Platform consumes that — REPLACING the old direct connection
 * to the GTMOS database (SDR_LAUNCH_DATABASE_URL). We hold no authoritative
 * copy of identity here.
 *
 * Config:
 *   SDR_LAUNCH_INTERNAL_URL     base URL of GTMOS (e.g. https://…railway.app)
 *   SDR_LAUNCH_INTERNAL_SECRET  shared secret (GTMOS INTERNAL_API_SECRET)
 */

export interface SdrLaunchPbMember {
  pbMemberId: string;
  name: string | null;
  email: string | null;
  status: string | null;
}

export interface SdrLaunchClient {
  id: string;
  slug: string;
  name: string;
  status: string;
  hubspotPortalId: string | null;
  salesforceAccountId: string | null;
  crmPlatform: string | null;
  website: string | null;
  clientReferenceName: string | null;
  pbMembers?: SdrLaunchPbMember[];
}

export interface TokenIntrospection {
  valid: boolean;
  global?: boolean;
  user?: { id: string; email: string; role: string; fullName: string | null };
  clientSlugs?: string[];
}

export interface SdrPhoneburnerToken {
  /** PhoneBurner member id (matches phoneburner_members.pb_member_id). */
  pbMemberId: string;
  /** Decrypted personal access token — read/delete that SDR's own PB book. */
  token: string;
  email: string | null;
  status: string;
}

export interface SdrEmailbisonWorkspace {
  /** EmailBison integer workspace id (the tenant the bearer key maps to). */
  workspaceId: number;
  workspaceName: string | null;
  /** GTMOS client id (uuid) this workspace maps to — NOT this repo's Client.id. */
  clientId: string;
  /** Decrypted per-workspace EmailBison API key (Bearer for send.tamtotarget.com). */
  apiKey: string;
}

function config(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.SDR_LAUNCH_INTERNAL_URL;
  const secret = process.env.SDR_LAUNCH_INTERNAL_SECRET;
  if (!baseUrl || !secret) {
    throw new Error(
      "SDR_LAUNCH_INTERNAL_URL and SDR_LAUNCH_INTERNAL_SECRET must be set to reach the GTMOS internal API"
    );
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), secret };
}

/** Fetch the customer roster from GTMOS. */
export async function fetchClients(opts?: {
  pbMembers?: boolean;
  windowDays?: number;
}): Promise<SdrLaunchClient[]> {
  const { baseUrl, secret } = config();
  const params = new URLSearchParams();
  if (opts?.pbMembers) params.set("pb_members", "1");
  if (opts?.windowDays) params.set("pb_window_days", String(opts.windowDays));
  const qs = params.toString();

  const res = await fetch(`${baseUrl}/api/internal/clients${qs ? `?${qs}` : ""}`, {
    headers: { "X-Internal-Secret": secret },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GTMOS /api/internal/clients failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { clients?: SdrLaunchClient[] };
  return json.clients ?? [];
}

/**
 * Fetch every active SDR's PhoneBurner personal access token from GTMOS (the
 * source of truth for these secrets). Used by the DNC purge, which must act with
 * each SDR's OWN token. Throws on a config/transport failure.
 */
export async function fetchPhoneburnerTokens(): Promise<SdrPhoneburnerToken[]> {
  const { baseUrl, secret } = config();
  const res = await fetch(`${baseUrl}/api/internal/phoneburner-tokens`, {
    headers: { "X-Internal-Secret": secret },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GTMOS /api/internal/phoneburner-tokens failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { tokens?: SdrPhoneburnerToken[] };
  return json.tokens ?? [];
}

/**
 * Fetch every client-mapped EmailBison workspace + its decrypted API key from
 * GTMOS (the source of truth for these secrets, encrypted at rest). Used by the
 * EmailBison DNC suppression service to blocklist a client's DNC contacts in
 * that client's sending workspace. Throws on a config/transport failure.
 */
export async function fetchEmailbisonWorkspaces(): Promise<SdrEmailbisonWorkspace[]> {
  const { baseUrl, secret } = config();
  const res = await fetch(`${baseUrl}/api/internal/emailbison-tokens`, {
    headers: { "X-Internal-Secret": secret },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GTMOS /api/internal/emailbison-tokens failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { workspaces?: SdrEmailbisonWorkspace[] };
  return json.workspaces ?? [];
}

/**
 * Validate an end-user's `sdr_live_…` token against GTMOS and learn which
 * customers they may act on. Never throws on an invalid token — returns
 * { valid: false }. Throws only on a configuration / transport failure.
 */
export async function introspectToken(token: string): Promise<TokenIntrospection> {
  const { baseUrl, secret } = config();
  const res = await fetch(`${baseUrl}/api/internal/introspect-token`, {
    method: "POST",
    headers: { "X-Internal-Secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GTMOS token introspection failed: HTTP ${res.status} ${body}`);
  }
  return (await res.json()) as TokenIntrospection;
}
