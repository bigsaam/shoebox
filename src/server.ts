import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { registerApiRoutes } from "./api.js";
import { registerAuthzRoute } from "./authz.js";
import { registerServeRoutes } from "./serve.js";
import { Store } from "./store.js";

export async function buildServer(cfg: Config): Promise<{ app: FastifyInstance; store: Store }> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // Behind the Cloudflare Tunnel; needed for req.ip (login rate limit) and req.protocol.
    trustProxy: true,
    bodyLimit: cfg.maxBundleBytes,
  });

  await app.register(cookie);
  await app.register(formbody);

  const store = new Store(cfg.dataDir);
  await store.init();

  registerApiRoutes(app, store, cfg);
  registerAuthzRoute(app, store, cfg);
  registerServeRoutes(app, store, cfg);

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).type("text/plain").send("not found");
  });

  return { app, store };
}

/** Delete expired bundles on a timer so a TTL means something without a cron. */
export function startSweeper(store: Store, everyMs = 3_600_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void store.prune().catch(() => {});
  }, everyMs);
  timer.unref();
  return timer;
}
