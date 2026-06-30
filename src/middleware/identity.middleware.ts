/**
 * Identity middleware (Phase 2).
 *
 * Scopes an endpoint to the customers an END USER may act on, using GTMOS as the
 * single source of truth for users + access. The caller forwards the user's
 * `sdr_live_…` token in `X-User-Token`; we introspect it against GTMOS and
 * attach `req.identity`.
 *
 * This is distinct from authMiddleware (the static API_KEY for service/admin
 * callers). A route can require BOTH — API_KEY to authenticate the calling
 * service, X-User-Token to scope the action to a user's customers — or just
 * this one for user-driven surfaces (e.g. TAM-list building from Claude).
 */
import { Request, Response, NextFunction } from "express";
import { introspectToken } from "../services/sdr-launch.service";

export interface Identity {
  userId: string;
  email: string;
  role: string;
  /** Global roles (superadmin/admin) may act on every customer. */
  global: boolean;
  /** Customer slugs this user may act on (full roster when global). */
  clientSlugs: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: Identity;
    }
  }
}

/** True if the identity may act on the given customer slug. */
export function canAccessSlug(identity: Identity, slug: string): boolean {
  return identity.global || identity.clientSlugs.includes(slug);
}

export async function requireIdentity(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.headers["x-user-token"];
  const value = Array.isArray(token) ? token[0] : token;
  if (!value) {
    res.status(401).json({ error: "Unauthorized: missing X-User-Token" });
    return;
  }

  try {
    const result = await introspectToken(value);
    if (!result.valid || !result.user) {
      res.status(401).json({ error: "Unauthorized: invalid user token" });
      return;
    }
    req.identity = {
      userId: result.user.id,
      email: result.user.email,
      role: result.user.role,
      global: !!result.global,
      clientSlugs: result.clientSlugs ?? [],
    };
    next();
  } catch (err: any) {
    // A transport/config failure talking to GTMOS is a 502, not a 401 — the
    // token might be perfectly valid; we just couldn't verify it.
    res.status(502).json({ error: `Identity verification failed: ${err?.message || err}` });
  }
}
