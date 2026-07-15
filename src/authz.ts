import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { checkBundleSecret, isAuthorized, issueCookie } from "./auth.js";
import { idFromHost } from "./links.js";
import { notFoundPage } from "./pages.js";
import { Store } from "./store.js";

/**
 * `GET /_/authz` — Caddy's `forward_auth` target.
 *
 * Caddy replays the original request's method/host/uri as X-Forwarded-* headers.
 * We answer:
 *
 *   200  → Caddy serves the file
 *   302  → Caddy copies our response (and Set-Cookie) straight to the browser
 *   404  → no such bundle, or expired
 *
 * The interesting case is the 302 on a valid `?secret=`: we mint a cookie and
 * redirect to the clean URL. That is the whole reason this service exists rather
 * than `basic_auth` or nginx's `secure_link` — the browser's *subsequent* requests
 * for `assets/app.js` carry no query string, so the one-time token has to become
 * a cookie or every asset 403s.
 */

function forwardedUri(req: FastifyRequest): string {
  const raw = (req.headers["x-forwarded-uri"] as string | undefined) ?? "/";
  return raw.startsWith("/") ? raw : "/";
}

function forwardedHost(req: FastifyRequest): string {
  return ((req.headers["x-forwarded-host"] as string | undefined) ?? req.hostname) || "";
}

/** Drop `secret` from the original URI so the token never lingers in the address bar. */
function cleanUri(uri: string): string {
  const url = new URL(uri, "http://x");
  url.searchParams.delete("secret");
  const qs = url.search === "?" ? "" : url.search;
  return url.pathname + qs;
}

function secretFrom(uri: string): string | null {
  return new URL(uri, "http://x").searchParams.get("secret");
}

export function registerAuthzRoute(app: FastifyInstance, store: Store, cfg: Config): void {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const uri = forwardedUri(req);
    const id = idFromHost(cfg, forwardedHost(req));
    if (!id) return reply.code(404).type("text/html").send(notFoundPage());

    const meta = await store.read(id);
    if (!meta) return reply.code(404).type("text/html").send(notFoundPage());
    if (Store.isExpired(meta)) {
      void store.remove(id);
      return reply.code(404).type("text/html").send(notFoundPage());
    }

    if (isAuthorized(req, id, cfg)) {
      // Only the entry page counts as a view; assets would inflate it.
      if (cleanUri(uri) === "/" || cleanUri(uri) === `/${meta.entry}`) void store.touch(id);
      return reply.code(200).send();
    }

    const secret = secretFrom(uri);
    if (secret && checkBundleSecret(secret, meta.secret)) {
      issueCookie(reply, id, cfg);
      return reply.redirect(cleanUri(uri), 302);
    }

    return reply.redirect(`/_/login?next=${encodeURIComponent(cleanUri(uri))}`, 302);
  };

  // Fastify exposes a HEAD route for every GET, which is what forward_auth probes with.
  app.get("/_/authz", handler);
}
