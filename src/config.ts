import path from "node:path";

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  password: string;
  apiToken: string;
  sessionSecret: string;
  sessionTtlMs: number;
  maxBundleBytes: number;
  /** Origin used when printing path-mode links. Falls back to the request host. */
  baseUrl: string | null;
  /** e.g. "{id}.preview.enzoiwith.us". Set => every bundle is its own origin. */
  hostTemplate: string | null;
  publicScheme: "http" | "https";
  /** Set to share one password session across bundle subdomains. Unset = host-only cookies. */
  cookieDomain: string | null;
  /** False when Caddy serves the files and shoebox only authorizes. */
  serveFiles: boolean;
}

const DURATION = /^(\d+)\s*(ms|s|m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parse "30d", "12h", "90m". Throws on anything else so typos fail loudly. */
export function parseDuration(input: string): number {
  const m = DURATION.exec(input.trim());
  if (!m) throw new Error(`invalid duration: ${input} (expected e.g. 30d, 12h, 90m)`);
  const unit = UNIT_MS[m[2]!.toLowerCase()];
  if (unit === undefined) throw new Error(`invalid duration unit: ${m[2]}`);
  return Number(m[1]) * unit;
}

const SIZE = /^(\d+)\s*(b|kb|mb|gb)$/i;
const SIZE_BYTES: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };

export function parseSize(input: string): number {
  const m = SIZE.exec(input.trim());
  if (!m) throw new Error(`invalid size: ${input} (expected e.g. 100mb)`);
  const unit = SIZE_BYTES[m[2]!.toLowerCase()];
  if (unit === undefined) throw new Error(`invalid size unit: ${m[2]}`);
  return Number(m[1]) * unit;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `${name} is required. Copy .env.example to .env and fill it in, or export it in the environment.`,
    );
  }
  return v;
}

function parseHostTemplate(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase();
  if (!t.includes("{id}")) {
    throw new Error(`SHOEBOX_HOST_TEMPLATE must contain {id}, got: ${raw}`);
  }
  if (t.indexOf("{id}") !== t.lastIndexOf("{id}")) {
    throw new Error("SHOEBOX_HOST_TEMPLATE must contain {id} exactly once");
  }
  return t;
}

/**
 * With a template like `share-{id}.example.com` the id lives *inside* a label, so any
 * cookie domain wide enough to span bundles is `.example.com` — which would also send
 * the session cookie to every other service on that domain. Refuse it outright.
 * `{id}.preview.example.com` has no such problem: `.preview.example.com` spans only bundles.
 */
function validateCookieDomain(cookieDomain: string | null, hostTemplate: string | null): void {
  if (!cookieDomain || !hostTemplate) return;
  const prefix = hostTemplate.split("{id}")[0]!;
  if (prefix !== "") {
    throw new Error(
      `SHOEBOX_COOKIE_DOMAIN cannot be used with SHOEBOX_HOST_TEMPLATE="${hostTemplate}". ` +
        `The id is inside a hostname label, so any cookie domain broad enough to cover ` +
        `every bundle would also be sent to every other service on that domain. ` +
        `Leave it unset (one password prompt per bundle), or move bundles to their own ` +
        `parent, e.g. "{id}.preview.example.com".`,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hostTemplate = parseHostTemplate(env.SHOEBOX_HOST_TEMPLATE);
  const scheme = env.SHOEBOX_PUBLIC_SCHEME ?? (hostTemplate ? "https" : "http");
  if (scheme !== "http" && scheme !== "https") {
    throw new Error(`SHOEBOX_PUBLIC_SCHEME must be http or https, got: ${scheme}`);
  }
  validateCookieDomain(env.SHOEBOX_COOKIE_DOMAIN || null, hostTemplate);
  return {
    port: Number(env.SHOEBOX_PORT ?? 8080),
    host: env.SHOEBOX_HOST ?? "0.0.0.0",
    dataDir: path.resolve(env.SHOEBOX_DATA_DIR ?? "./data"),
    password: required("SHOEBOX_PASSWORD", env),
    apiToken: required("SHOEBOX_API_TOKEN", env),
    sessionSecret: required("SHOEBOX_SESSION_SECRET", env),
    sessionTtlMs: parseDuration(env.SHOEBOX_SESSION_TTL ?? "30d"),
    maxBundleBytes: parseSize(env.SHOEBOX_MAX_BUNDLE_SIZE ?? "100mb"),
    baseUrl: env.SHOEBOX_BASE_URL?.replace(/\/+$/, "") || null,
    hostTemplate,
    publicScheme: scheme,
    cookieDomain: env.SHOEBOX_COOKIE_DOMAIN || null,
    serveFiles: env.SHOEBOX_SERVE_FILES !== "false",
  };
}
