import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { safeEqual, signToken, verifyToken } from "./crypto.js";

export const ALL_SCOPE = "all";

export function cookieName(scope: string): string {
  return scope === ALL_SCOPE ? "sb_all" : `sb_${scope}`;
}

export function issueCookie(reply: FastifyReply, scope: string, cfg: Config): void {
  const expiresAt = Date.now() + cfg.sessionTtlMs;
  reply.setCookie(cookieName(scope), signToken(scope, expiresAt, cfg.sessionSecret), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.publicScheme === "https",
    maxAge: Math.floor(cfg.sessionTtlMs / 1000),
    // Host-only by default: in subdomain mode a session for one bundle is not even
    // transmitted to another. Setting cookieDomain trades that for one password prompt.
    ...(cfg.cookieDomain ? { domain: cfg.cookieDomain } : {}),
  });
}

/** True when the request already carries a valid cookie for `scope`. */
function hasScope(req: FastifyRequest, scope: string, cfg: Config): boolean {
  const raw = req.cookies[cookieName(scope)];
  if (!raw) return false;
  const claims = verifyToken(raw, cfg.sessionSecret);
  return claims !== null && claims.scope === scope;
}

/** Password grants "all"; a bundle secret grants only that bundle. */
export function isAuthorized(req: FastifyRequest, bundleId: string | null, cfg: Config): boolean {
  if (hasScope(req, ALL_SCOPE, cfg)) return true;
  return bundleId !== null && hasScope(req, bundleId, cfg);
}

export function checkPassword(candidate: string, cfg: Config): boolean {
  return safeEqual(candidate, cfg.password);
}

export function checkBundleSecret(candidate: string, expected: string): boolean {
  return safeEqual(candidate, expected);
}

export function checkApiToken(req: FastifyRequest, cfg: Config): boolean {
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return safeEqual(header.slice(prefix.length), cfg.apiToken);
}

/**
 * Fixed-window limiter for the login form. Not a general-purpose limiter — it exists
 * so a leaked preview link cannot be turned into an unbounded password oracle.
 */
export class LoginLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  /** Called on a successful login so a legitimate user is not penalised. */
  reset(key: string): void {
    this.hits.delete(key);
  }
}
