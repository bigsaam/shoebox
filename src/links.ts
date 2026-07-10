import type { Config } from "./config.js";
import { isValidId } from "./ids.js";

/**
 * Two ways to address a bundle:
 *
 *   path mode       http://localhost:8080/<id>/        (no host template; local dev)
 *   subdomain mode  https://<id>.preview.example.com/  (SHOEBOX_HOST_TEMPLATE)
 *
 * Subdomain mode is what production wants: every bundle is its own browser origin,
 * so one bundle's JavaScript can never read another's, and its session cookie is
 * host-only. There is no web index in either mode — the only way to enumerate
 * bundles is the token-authenticated API.
 */

export function hasSubdomains(cfg: Config): boolean {
  return cfg.hostTemplate !== null;
}

export function bundleHost(cfg: Config, id: string): string | null {
  if (!cfg.hostTemplate) return null;
  return cfg.hostTemplate.replace("{id}", id);
}

/** Host header minus any port, lowercased. */
export function normalizeHost(host: string | undefined): string {
  return (host ?? "").split(":")[0]!.toLowerCase();
}

/** Recover the bundle id from the request host, or null when this is the apex. */
export function idFromHost(cfg: Config, host: string | undefined): string | null {
  if (!cfg.hostTemplate) return null;
  const h = normalizeHost(host);

  const [prefix, suffix] = cfg.hostTemplate.toLowerCase().split("{id}") as [string, string];
  if (!h.startsWith(prefix) || !h.endsWith(suffix)) return null;

  const id = h.slice(prefix.length, h.length - suffix.length);
  return isValidId(id) ? id : null;
}

/**
 * The link handed to a human. Never derived from the publishing request's host,
 * so publishing over Tailscale still yields the public URL.
 *
 * Caddy resolves `/` with `try_files … index.html` and cannot read our metadata,
 * so a bundle whose entry is not index.html gets that filename in its link.
 */
export function linkFor(cfg: Config, id: string, requestOrigin: string, entry = "index.html"): string {
  const suffix = entry === "index.html" ? "" : entry;
  const host = bundleHost(cfg, id);
  if (host) return `${cfg.publicScheme}://${host}/${suffix}`;
  return `${cfg.baseUrl ?? requestOrigin}/${id}/${suffix}`;
}

export function secretLinkFor(
  cfg: Config,
  id: string,
  secret: string,
  requestOrigin: string,
  entry = "index.html",
): string {
  return `${linkFor(cfg, id, requestOrigin, entry)}?secret=${secret}`;
}
