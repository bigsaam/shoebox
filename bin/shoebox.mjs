#!/usr/bin/env node
// shoebox CLI — publish throwaway static bundles to a password-gated preview server.
// Deliberately dependency-free: it shells out to system `tar` so it runs from anywhere,
// on the Mac or the homelab box, without a node_modules next to it.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const CONFIG_PATH = path.join(homedir(), ".config", "shoebox", "config.json");
const MAX_BYTES = 100 * 1024 * 1024;

const die = (msg) => {
  console.error(`shoebox: ${msg}`);
  process.exit(1);
};

/** Resolve an `op://` reference through the 1Password CLI, matching the homelab convention. */
function resolveSecret(value) {
  if (!value?.startsWith("op://")) return value;
  try {
    return execFileSync("op", ["read", value], { encoding: "utf8" }).trim();
  } catch {
    die(`could not read ${value} — is the 1Password CLI signed in?`);
  }
}

function loadConfig() {
  let file = {};
  if (existsSync(CONFIG_PATH)) file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const url = (process.env.SHOEBOX_URL ?? file.url ?? "").replace(/\/+$/, "");
  const token = resolveSecret(process.env.SHOEBOX_API_TOKEN ?? file.token ?? "");
  if (!url || !token) {
    die("not configured. Run: shoebox init --url https://preview.example.com --token <token>");
  }
  return { url, token };
}

async function api(cfg, method, route, { body, headers } = {}) {
  const res = await fetch(`${cfg.url}${route}`, {
    method,
    headers: { authorization: `Bearer ${cfg.token}`, ...headers },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text.slice(0, 300) };
  }
  if (!res.ok) die(`${method} ${route} → ${res.status}: ${json.error ?? text.slice(0, 200)}`);
  return json;
}

/**
 * gzip a directory's contents.
 *
 * `COPYFILE_DISABLE=1` stops macOS `tar` from emitting an AppleDouble `._<name>` sidecar
 * for every file that carries extended attributes. Those sidecars embed the xattrs
 * verbatim — `com.apple.metadata:kMDItemWhereFroms` records the URL a file was downloaded
 * from — so publishing them leaks where an artifact came from. Ignored by GNU tar on Linux.
 * The server strips them too (`isMacMetadata`); this just stops us sending them.
 */
function tarball(dir) {
  const buf = execFileSync("tar", ["czf", "-", "-C", dir, "."], {
    maxBuffer: MAX_BYTES,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (buf.length > MAX_BYTES) die(`bundle too large: ${buf.length} bytes`);
  return buf;
}

/**
 * gzip tarball of a directory's contents. A single file is staged as index.html
 * first: the server serves `/` with try_files, so every bundle needs one.
 */
function pack(target) {
  if (statSync(target).isDirectory()) return tarball(target);

  const stage = mkdtempSync(path.join(tmpdir(), "shoebox-"));
  try {
    copyFileSync(target, path.join(stage, "index.html"));
    return tarball(stage);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function defaultEntry(target) {
  if (!statSync(target).isDirectory()) return "index.html";
  if (!existsSync(path.join(target, "index.html"))) {
    die(`${target} has no index.html — pass --entry <file> to pick the page to serve`);
  }
  return "index.html";
}

/**
 * Resolve the `--ttl` flag into an `x-shoebox-ttl` header value, or null to omit it.
 *
 * Bundles are throwaway by construction, so an unbounded default is how the disk fills.
 * We default to 90 days — long enough to revisit a shared link, bounded enough that
 * forgotten artifacts sweep themselves away. `--ttl never` (or none/off) opts back into a
 * permanent bundle: null omits the header, and the server treats an absent TTL as forever.
 */
export function resolveTtl(flag) {
  if (flag === undefined) return "90d";
  if (["never", "none", "off"].includes(flag.toLowerCase())) return null;
  return flag;
}

async function cmdPut(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ttl: { type: "string" },
      name: { type: "string" },
      entry: { type: "string" },
      update: { type: "string" },
      api: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  const target = positionals[0];
  if (!target) {
    die("usage: shoebox put <file-or-dir> [--update <id>] [--ttl 90d|never] [--entry index.html] [--json]");
  }
  if (!existsSync(target)) die(`no such path: ${target}`);

  const updateId = values.update;
  if (updateId !== undefined && !/^[bcdfghjkmnpqrstvwxyz23456789]{8}$/.test(updateId)) {
    die(`not a valid bundle id: ${updateId}`);
  }

  const cfg = loadConfig();
  if (values.entry && !statSync(target).isDirectory()) {
    die("--entry only applies to a directory; a single file is always served at /");
  }
  const entry = values.entry ?? defaultEntry(target);
  const headers = {
    "content-type": "application/gzip",
    "x-shoebox-name": values.name ?? path.basename(path.resolve(target)),
    "x-shoebox-entry": entry,
  };
  if (updateId) {
    // On update, omitting --ttl leaves the existing expiry untouched; the raw flag
    // (including "never") is forwarded so the server can reset it from now.
    if (values.ttl !== undefined) headers["x-shoebox-ttl"] = values.ttl;
  } else {
    const ttl = resolveTtl(values.ttl);
    if (ttl) headers["x-shoebox-ttl"] = ttl;
  }
  // --api <url> gives the bundle a same-origin backend at /api/*; --api none clears it.
  // On publish it defaults to off; on update, omitting it leaves the current one as-is.
  if (values.api !== undefined) headers["x-shoebox-api"] = values.api;

  const out = updateId
    ? await api(cfg, "PUT", `/_/api/bundles/${updateId}`, { body: pack(target), headers })
    : await api(cfg, "POST", "/_/api/bundles", { body: pack(target), headers });

  if (values.json) return console.log(JSON.stringify(out, null, 2));
  console.log(`${updateId ? "updated  " : "published"}  ${out.name}`);
  console.log(`  link     ${out.url}`);
  console.log(`  bypass   ${out.secretUrl}`);
  console.log(`  expires  ${out.expiresAt ?? "never"}`);
  if (out.apiUpstream) console.log(`  backend  /api/* → ${out.apiUpstream}`);
  console.log(
    updateId
      ? `\nSame link and password as before — anything you already shared still works.`
      : `\nShare the link plus the shared password, or send the bypass link on its own.`,
  );
}

async function cmdLs(argv) {
  const { values } = parseArgs({ args: argv, options: { json: { type: "boolean", default: false } } });
  const bundles = await api(loadConfig(), "GET", "/_/api/bundles");
  if (values.json) return console.log(JSON.stringify(bundles, null, 2));
  if (bundles.length === 0) return console.log("shoebox is empty");
  for (const b of bundles) {
    const age = Math.round((Date.now() - Date.parse(b.createdAt)) / 86_400_000);
    const exp = b.expiresAt ? `expires ${b.expiresAt.slice(0, 10)}` : "";
    console.log(
      `${b.id}  ${String(b.name).padEnd(28)} ${String(age + "d").padStart(4)}  ${String(b.views).padStart(4)} views  ${exp}`,
    );
  }
}

async function cmdRm(argv) {
  if (!argv[0]) die("usage: shoebox rm <id>");
  const out = await api(loadConfig(), "DELETE", `/_/api/bundles/${argv[0]}`);
  console.log(`removed ${out.removed.join(", ")}`);
}

async function cmdPrune(argv) {
  const { values } = parseArgs({ args: argv, options: { "older-than": { type: "string" } } });
  const body = JSON.stringify(values["older-than"] ? { olderThan: values["older-than"] } : {});
  const out = await api(loadConfig(), "POST", "/_/api/prune", {
    body,
    headers: { "content-type": "application/json" },
  });
  console.log(out.removed.length ? `removed ${out.removed.join(", ")}` : "nothing to prune");
}

function cmdInit(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { url: { type: "string" }, token: { type: "string" } },
  });
  if (!values.url || !values.token) die("usage: shoebox init --url <url> --token <token|op://...>");
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({ url: values.url.replace(/\/+$/, ""), token: values.token }, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(`wrote ${CONFIG_PATH}`);
}

const USAGE = `shoebox — publish throwaway static bundles

  shoebox put <file-or-dir> [--ttl 30d] [--entry index.html] [--name x] [--json]
  shoebox put <file-or-dir> --update <id>   # replace a bundle, keeping its link
  shoebox put <file-or-dir> --api <url>     # same-origin backend at /api/* → <url>
  shoebox ls [--json]
  shoebox rm <id>
  shoebox prune [--older-than 30d]
  shoebox init --url <url> --token <token|op://vault/item/field>

Config: ~/.config/shoebox/config.json, or SHOEBOX_URL / SHOEBOX_API_TOKEN.
`;

// Only dispatch when run as a program. When imported (by a test), export the helpers
// above and do nothing — `pathToFileURL(argv[1])` is how a module knows it is the entry.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const commands = { put: cmdPut, ls: cmdLs, rm: cmdRm, prune: cmdPrune, init: cmdInit };
  if (!cmd || !commands[cmd]) {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
  await commands[cmd](rest);
}
