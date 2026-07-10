import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { checkBundleSecret, isAuthorized, issueCookie } from "./auth.js";
import { idFromHost } from "./links.js";
import { contentTypeFor } from "./mime.js";
import { Store, resolveWithin } from "./store.js";
import { isValidId } from "./ids.js";

/**
 * The built-in file server. Used for local development and the standalone compose
 * file. In the homelab deployment Caddy serves the bundles and this is disabled
 * with SHOEBOX_SERVE_FILES=false — shoebox then only answers /_/authz.
 */

function cleanUrl(req: FastifyRequest): string {
  const url = new URL(req.url, "http://x");
  url.searchParams.delete("secret");
  return url.pathname + (url.search === "?" ? "" : url.search);
}

export function registerServeRoutes(app: FastifyInstance, store: Store, cfg: Config): void {
  if (!cfg.serveFiles) return;

  const gate = async (
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
  ): Promise<"ok" | "handled"> => {
    if (isAuthorized(req, id, cfg)) return "ok";

    const secret = (req.query as Record<string, string | undefined>).secret;
    if (secret) {
      const meta = await store.read(id);
      if (meta && !Store.isExpired(meta) && checkBundleSecret(secret, meta.secret)) {
        issueCookie(reply, id, cfg);
        reply.redirect(cleanUrl(req), 302);
        return "handled";
      }
    }
    reply.redirect(`/_/login?next=${encodeURIComponent(cleanUrl(req))}`, 302);
    return "handled";
  };

  const send = async (
    req: FastifyRequest,
    reply: FastifyReply,
    id: string,
    rest: string,
  ): Promise<FastifyReply> => {
    const meta = await store.read(id);
    if (!meta) {
      reply.callNotFound();
      return reply;
    }
    if (Store.isExpired(meta)) {
      void store.remove(id);
      reply.callNotFound();
      return reply;
    }
    if ((await gate(req, reply, id)) === "handled") return reply;

    const root = store.bundleDir(id);
    const requested = rest === "" ? meta.entry : decodeURIComponent(rest);
    let target = resolveWithin(root, requested);
    if (!target) return reply.code(403).send("forbidden");

    let stat = await fsp.stat(target).catch(() => null);
    if (stat?.isDirectory()) {
      target = resolveWithin(root, path.posix.join(requested, "index.html"));
      stat = target ? await fsp.stat(target).catch(() => null) : null;
    }
    if (!target || !stat?.isFile()) {
      reply.callNotFound();
      return reply;
    }

    const isEntry = rest === "" || requested === meta.entry;
    if (isEntry) void store.touch(id);

    return reply
      .header("content-type", contentTypeFor(target))
      .header("content-length", stat.size)
      .header("cache-control", isEntry ? "private, no-cache" : "private, max-age=3600")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .send(fs.createReadStream(target));
  };

  if (cfg.hostTemplate) {
    // Subdomain mode: the id comes from the Host header, so every bundle is its own origin.
    const fromHost = async (req: FastifyRequest, reply: FastifyReply, rest: string) => {
      const id = idFromHost(cfg, req.hostname);
      if (!id) {
        reply.callNotFound();
        return reply;
      }
      return send(req, reply, id, rest);
    };
    app.get("/", async (req, reply) => fromHost(req, reply, ""));
    app.get("/*", async (req, reply) => fromHost(req, reply, (req.params as { "*": string })["*"]));
    return;
  }

  // Path mode: /<id>/... on a single origin. No index — bundles are not enumerable.
  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.callNotFound();
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return reply.redirect(`/${id}/${qs}`, 302);
  });

  app.get("/:id/*", async (req, reply) => {
    const { id, "*": rest = "" } = req.params as { id: string; "*"?: string };
    if (!isValidId(id)) return reply.callNotFound();
    return send(req, reply, id, rest);
  });
}
