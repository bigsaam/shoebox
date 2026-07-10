import fsp from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { parseDuration } from "./config.js";
import { ALL_SCOPE, checkApiToken, checkPassword, cookieName, issueCookie, LoginLimiter } from "./auth.js";
import { loginPage } from "./pages.js";
import { linkFor, secretLinkFor } from "./links.js";
import { Store, isSafeEntry, resolveWithin } from "./store.js";
import { isValidId } from "./ids.js";

const limiter = new LoginLimiter();

function originOf(req: FastifyRequest, cfg: Config): string {
  return cfg.baseUrl ?? `${req.protocol}://${req.headers.host}`;
}

/** Only same-site absolute paths; never an attacker-supplied origin. */
function safeNext(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

/** Counts bytes and aborts the stream once the configured ceiling is crossed. */
function limitBytes(max: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > max) return cb(new Error(`bundle exceeds ${max} bytes`));
      cb(null, chunk);
    },
  });
}

function requireToken(req: FastifyRequest, reply: FastifyReply, cfg: Config): boolean {
  if (checkApiToken(req, cfg)) return true;
  reply.code(401).send({ error: "unauthorized" });
  return false;
}

export function registerApiRoutes(app: FastifyInstance, store: Store, cfg: Config): void {
  // Hand the upload straight to the handler as a stream; never buffer a bundle in memory.
  for (const ct of ["application/gzip", "application/octet-stream"]) {
    app.addContentTypeParser(ct, (_req, payload, done) => done(null, payload));
  }

  app.get("/_/health", async () => ({ ok: true }));

  app.get("/robots.txt", async (_req, reply) =>
    reply.type("text/plain").send("User-agent: *\nDisallow: /\n"),
  );

  app.get("/_/login", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    return reply.type("text/html").send(loginPage(safeNext(q.next), q.failed === "1"));
  });

  app.post("/_/login", async (req, reply) => {
    const key = req.ip;
    if (!limiter.allow(key)) return reply.code(429).send("too many attempts, wait a minute");

    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const next = safeNext(body.next);
    if (!body.password || !checkPassword(body.password, cfg)) {
      return reply.redirect(`/_/login?failed=1&next=${encodeURIComponent(next)}`, 302);
    }
    limiter.reset(key);
    issueCookie(reply, ALL_SCOPE, cfg);
    return reply.redirect(next, 302);
  });

  app.post("/_/logout", async (_req, reply) =>
    reply.clearCookie(cookieName(ALL_SCOPE), { path: "/" }).redirect("/_/login", 302),
  );

  app.get("/_/api/bundles", async (req, reply) => {
    if (!requireToken(req, reply, cfg)) return reply;
    const origin = originOf(req, cfg);
    const bundles = await store.list();
    return reply.send(
      bundles.map((b) => ({
        ...b,
        url: linkFor(cfg, b.id, origin, b.entry),
        secretUrl: secretLinkFor(cfg, b.id, b.secret, origin, b.entry),
      })),
    );
  });

  app.post("/_/api/bundles", async (req, reply) => {
    if (!requireToken(req, reply, cfg)) return reply;

    const h = req.headers as Record<string, string | undefined>;
    const name = (h["x-shoebox-name"] ?? "bundle").slice(0, 200);
    const entry = h["x-shoebox-entry"] ?? "index.html";
    if (!isSafeEntry(entry)) return reply.code(400).send({ error: "invalid entry" });

    let ttlMs: number | null = null;
    if (h["x-shoebox-ttl"]) {
      try {
        ttlMs = parseDuration(h["x-shoebox-ttl"]);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }

    const id = await store.allocate();
    const dir = store.bundleDir(id);
    try {
      await pipeline(
        req.body as unknown as Readable,
        limitBytes(cfg.maxBundleBytes),
        createGunzip(),
        tar.x({
          cwd: dir,
          strict: true,
          preservePaths: false,
          // Symlinks and hardlinks are the classic tar escape; refuse both.
          filter: (_p, stat) =>
            "type" in stat && (stat.type === "File" || stat.type === "Directory"),
        }),
      );

      const entryPath = resolveWithin(dir, entry);
      if (!entryPath || !(await fsp.stat(entryPath).catch(() => null))?.isFile()) {
        throw new Error(`entry not found in bundle: ${entry}`);
      }

      const meta = store.newBundle(id, name, entry, ttlMs);
      Object.assign(meta, await store.stats(dir));
      await store.writeMeta(meta);

      const origin = originOf(req, cfg);
      return reply.code(201).send({
        ...meta,
        url: linkFor(cfg, id, origin, meta.entry),
        secretUrl: secretLinkFor(cfg, id, meta.secret, origin, meta.entry),
      });
    } catch (err) {
      await store.remove(id);
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete("/_/api/bundles/:id", async (req, reply) => {
    if (!requireToken(req, reply, cfg)) return reply;
    const { id } = req.params as { id: string };
    if (!isValidId(id)) return reply.code(400).send({ error: "invalid id" });
    return (await store.remove(id))
      ? reply.send({ removed: [id] })
      : reply.code(404).send({ error: "not found" });
  });

  app.post("/_/api/prune", async (req, reply) => {
    if (!requireToken(req, reply, cfg)) return reply;
    const body = (req.body ?? {}) as { olderThan?: string };
    let olderThanMs: number | null = null;
    if (body.olderThan) {
      try {
        olderThanMs = parseDuration(body.olderThan);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    return reply.send({ removed: await store.prune(olderThanMs) });
  });
}
