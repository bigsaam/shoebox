import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as tar from "tar";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

/**
 * Contract tests for `GET /_/authz`, Caddy's forward_auth target.
 *
 * Caddy's rule: a 2xx lets the request through to the file server; anything else
 * is copied verbatim to the browser, headers and all. Every assertion below is
 * really an assertion about what the browser ends up seeing.
 */

const PASSWORD = "correct-horse";
const TOKEN = "api-token-abc";
const TEMPLATE = "{id}.preview.example.com";

let app: FastifyInstance;
let dataDir: string;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-authz-"));
  const cfg: Config = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    password: PASSWORD,
    apiToken: TOKEN,
    sessionSecret: "session-secret",
    sessionTtlMs: 60_000,
    maxBundleBytes: 5 * 1024 * 1024,
    baseUrl: null,
    hostTemplate: TEMPLATE,
    publicScheme: "https",
    cookieDomain: null,
    serveFiles: false, // Caddy serves; shoebox only authorizes.
  };
  ({ app } = await buildServer(cfg));
  await app.ready();
});

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function tarball(files: Record<string, string>): Promise<Buffer> {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-src-"));
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(src, rel)), { recursive: true });
    await fs.writeFile(path.join(src, rel), body);
  }
  const chunks: Buffer[] = [];
  for await (const c of tar.c({ gzip: true, cwd: src }, ["."])) chunks.push(Buffer.from(c as Uint8Array));
  await fs.rm(src, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

async function publish() {
  const res = await app.inject({
    method: "POST",
    url: "/_/api/bundles",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/gzip",
      "x-shoebox-name": "t",
    },
    payload: await tarball({ "index.html": "<h1>hi</h1>", "assets/app.js": "1" }),
  });
  return res.json() as { id: string; secret: string; url: string; secretUrl: string };
}

/** What Caddy sends: the original request described in X-Forwarded-* headers. */
function authz(host: string, uri: string, cookie?: string) {
  return app.inject({
    method: "GET",
    url: "/_/authz",
    headers: {
      "x-forwarded-host": host,
      "x-forwarded-uri": uri,
      "x-forwarded-method": "GET",
      ...(cookie ? { cookie } : {}),
    },
  });
}

test("publish returns the bundle's own subdomain, not the API host", async () => {
  const b = await publish();
  assert.equal(b.url, `https://${b.id}.preview.example.com/`);
  assert.equal(b.secretUrl, `${b.url}?secret=${b.secret}`);
});

test("an unknown or malformed host is 404, never a login prompt", async () => {
  assert.equal((await authz("preview.example.com", "/")).statusCode, 404, "apex");
  assert.equal((await authz("nosuchid1.preview.example.com", "/")).statusCode, 404, "bad alphabet");
  assert.equal((await authz("bcdfghjk.evil.com", "/")).statusCode, 404, "wrong suffix");
});

test("a bundle that exists but has no session redirects to login", async () => {
  const b = await publish();
  const res = await authz(`${b.id}.preview.example.com`, "/");
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location as string, /^\/_\/login\?next=/);
});

test("a valid secret mints a cookie and redirects to the clean URL", async () => {
  const b = await publish();
  const res = await authz(`${b.id}.preview.example.com`, `/?secret=${b.secret}`);

  assert.equal(res.statusCode, 302, "non-2xx so Caddy copies it to the browser");
  assert.equal(res.headers.location, "/", "the secret must not survive in the URL");

  const cookie = res.cookies.find((c) => c.name === `sb_${b.id}`);
  assert.ok(cookie, "expected a bundle-scoped cookie");
  assert.equal(cookie!.httpOnly, true);
  assert.equal(cookie!.secure, true, "publicScheme is https");
  assert.equal(cookie!.domain, undefined, "host-only: this cookie must not reach sibling bundles");
});

test("the minted cookie then authorizes the page AND its assets", async () => {
  const b = await publish();
  const grant = await authz(`${b.id}.preview.example.com`, `/?secret=${b.secret}`);
  const c = grant.cookies.find((x) => x.name === `sb_${b.id}`)!;
  const cookie = `sb_${b.id}=${c.value}`;

  // This is the case nginx secure_link cannot express: the asset request carries
  // no query string, only the cookie.
  for (const uri of ["/", "/assets/app.js"]) {
    const res = await authz(`${b.id}.preview.example.com`, uri, cookie);
    assert.equal(res.statusCode, 200, `${uri} should be allowed`);
  }
});

test("a wrong secret does not authorize", async () => {
  const b = await publish();
  const res = await authz(`${b.id}.preview.example.com`, "/?secret=deadbeef");
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location as string, /^\/_\/login/);
});

test("one bundle's cookie cannot open another, even renamed", async () => {
  const a = await publish();
  const b = await publish();
  const grant = await authz(`${a.id}.preview.example.com`, `/?secret=${a.secret}`);
  const value = grant.cookies.find((x) => x.name === `sb_${a.id}`)!.value;

  const res = await authz(`${b.id}.preview.example.com`, "/", `sb_${b.id}=${value}`);
  assert.equal(res.statusCode, 302, "scope is inside the signature");
});

test("the shared password authorizes, and its cookie is host-only", async () => {
  const b = await publish();
  const login = await app.inject({
    method: "POST",
    url: "/_/login",
    payload: `password=${encodeURIComponent(PASSWORD)}&next=/`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const c = login.cookies.find((x) => x.name === "sb_all")!;
  assert.equal(c.domain, undefined, "without cookieDomain, one password does not span bundles");

  const res = await authz(`${b.id}.preview.example.com`, "/", `sb_all=${c.value}`);
  assert.equal(res.statusCode, 200);
});

test("an expired bundle is 404 even with a correct secret", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/_/api/bundles",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/gzip",
      "x-shoebox-ttl": "1ms",
    },
    payload: await tarball({ "index.html": "x" }),
  });
  const b = res.json();
  await new Promise((r) => setTimeout(r, 5));
  const gone = await authz(`${b.id}.preview.example.com`, `/?secret=${b.secret}`);
  assert.equal(gone.statusCode, 404);
});

test("with serveFiles=false there is no file route to leak anything", async () => {
  const b = await publish();
  const res = await app.inject({ method: "GET", url: `/${b.id}/index.html` });
  assert.equal(res.statusCode, 404, "shoebox must not serve bundles in Caddy mode");
});

test("metadata never lives inside the directory Caddy roots", async () => {
  const b = await publish();
  const served = await fs.readdir(path.join(dataDir, "bundles", b.id));
  assert.deepEqual(served.sort(), ["assets", "index.html"]);
  assert.ok((await fs.stat(path.join(dataDir, "meta", `${b.id}.json`))).isFile());
});
