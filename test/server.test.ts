import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import * as tar from "tar";
import type { FastifyInstance } from "fastify";
import type { Config } from "../src/config.js";
import { buildServer } from "../src/server.js";

const PASSWORD = "correct-horse";
const TOKEN = "api-token-abc";

let app: FastifyInstance;
let dataDir: string;
let cfg: Config;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-test-"));
  cfg = {
    port: 0,
    host: "127.0.0.1",
    dataDir,
    password: PASSWORD,
    apiToken: TOKEN,
    sessionSecret: "session-secret",
    sessionTtlMs: 60_000,
    maxBundleBytes: 5 * 1024 * 1024,
    baseUrl: "https://preview.example.com",
    hostTemplate: null,
    publicScheme: "https",
    cookieDomain: null,
    serveFiles: true,
  };
  ({ app } = await buildServer(cfg));
  await app.ready();
});

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** Build a gzipped tarball in memory from a {path: contents} map. */
async function tarball(files: Record<string, string>): Promise<Buffer> {
  const src = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-src-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(src, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }
  const chunks: Buffer[] = [];
  const stream = tar.c({ gzip: true, cwd: src }, ["."]);
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  await fs.rm(src, { recursive: true, force: true });
  return Buffer.concat(chunks);
}

async function publish(files: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/_/api/bundles",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/gzip",
      "x-shoebox-name": "test",
      ...headers,
    },
    payload: await tarball(files),
  });
  return res;
}

test("health needs no auth", async () => {
  const res = await app.inject({ method: "GET", url: "/_/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test("the API rejects a missing or wrong bearer token", async () => {
  assert.equal((await app.inject({ method: "GET", url: "/_/api/bundles" })).statusCode, 401);
  const bad = await app.inject({
    method: "GET",
    url: "/_/api/bundles",
    headers: { authorization: "Bearer nope" },
  });
  assert.equal(bad.statusCode, 401);
});

test("publish returns a link and a bypass link on the configured origin", async () => {
  const res = await publish({ "index.html": "<h1>hi</h1>" });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.match(body.id, /^[bcdfghjkmnpqrstvwxyz23456789]{8}$/);
  assert.equal(body.url, `https://preview.example.com/${body.id}/`);
  assert.equal(body.secretUrl, `${body.url}?secret=${body.secret}`);
  assert.equal(body.files, 1);
  assert.ok(body.bytes > 0);
});

test("an anonymous visitor is sent to the login page", async () => {
  const { id } = (await publish({ "index.html": "<h1>hi</h1>" })).json();
  const res = await app.inject({ method: "GET", url: `/${id}/` });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location as string, /^\/_\/login\?next=/);
});

test("the shared password unlocks every bundle", async () => {
  const { id } = (await publish({ "index.html": "<h1>hi</h1>" })).json();
  const login = await app.inject({
    method: "POST",
    url: "/_/login",
    payload: `password=${encodeURIComponent(PASSWORD)}&next=/${id}/`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(login.statusCode, 302);
  assert.equal(login.headers.location, `/${id}/`);

  const cookie = login.cookies.find((c) => c.name === "sb_all");
  assert.ok(cookie, "expected an sb_all cookie");
  assert.equal(cookie!.httpOnly, true);

  const page = await app.inject({
    method: "GET",
    url: `/${id}/`,
    headers: { cookie: `sb_all=${cookie!.value}` },
  });
  assert.equal(page.statusCode, 200);
  assert.equal(page.body, "<h1>hi</h1>");
});

test("a wrong password bounces back to the form", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/_/login",
    payload: "password=wrong&next=/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location as string, /failed=1/);
  assert.equal(res.cookies.length, 0);
});

test("the secret link grants access, sets a cookie, and strips the token from the URL", async () => {
  const { id, secret } = (await publish({ "index.html": "<h1>hi</h1>" })).json();
  const res = await app.inject({ method: "GET", url: `/${id}/?secret=${secret}` });

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `/${id}/`, "the secret must not survive in the URL");

  const cookie = res.cookies.find((c) => c.name === `sb_${id}`);
  assert.ok(cookie, "expected a bundle-scoped cookie");

  // The cookie alone is now enough to load the page and its assets.
  const page = await app.inject({
    method: "GET",
    url: `/${id}/`,
    headers: { cookie: `sb_${id}=${cookie!.value}` },
  });
  assert.equal(page.statusCode, 200);
});

test("a wrong secret does not grant access", async () => {
  const { id } = (await publish({ "index.html": "<h1>hi</h1>" })).json();
  const res = await app.inject({ method: "GET", url: `/${id}/?secret=deadbeef` });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location as string, /^\/_\/login/);
});

test("a bundle cookie does not unlock a different bundle", async () => {
  const a = (await publish({ "index.html": "<h1>a</h1>" })).json();
  const b = (await publish({ "index.html": "<h1>b</h1>" })).json();

  const grant = await app.inject({ method: "GET", url: `/${a.id}/?secret=${a.secret}` });
  const cookie = grant.cookies.find((c) => c.name === `sb_${a.id}`)!;

  // Present A's token under B's cookie name: the scope inside the signature must reject it.
  const res = await app.inject({
    method: "GET",
    url: `/${b.id}/`,
    headers: { cookie: `sb_${b.id}=${cookie.value}` },
  });
  assert.equal(res.statusCode, 302, "A's grant must not open B");
});

test("assets load with the same cookie, and traversal is refused", async () => {
  const { id, secret } = (
    await publish({ "index.html": "<h1>hi</h1>", "assets/app.js": "console.log(1)" })
  ).json();
  const grant = await app.inject({ method: "GET", url: `/${id}/?secret=${secret}` });
  const cookie = `sb_${id}=${grant.cookies.find((c) => c.name === `sb_${id}`)!.value}`;

  const asset = await app.inject({ method: "GET", url: `/${id}/assets/app.js`, headers: { cookie } });
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers["content-type"] as string, /text\/javascript/);

  // Metadata lives outside the served tree entirely, so there is nothing to serve.
  const meta = await app.inject({ method: "GET", url: `/${id}/.shoebox.json`, headers: { cookie } });
  assert.equal(meta.statusCode, 404, "metadata is not inside the bundle");
  const inBundle = await fs.readdir(path.join(dataDir, "bundles", id));
  assert.equal(inBundle.includes(".shoebox.json"), false, "secret must not sit in the served directory");
  assert.ok((await fs.stat(path.join(dataDir, "meta", `${id}.json`))).isFile());

  for (const evil of ["/../../etc/passwd", "/..%2f..%2f.shoebox.json"]) {
    const res = await app.inject({ method: "GET", url: `/${id}${evil}`, headers: { cookie } });
    assert.ok(res.statusCode >= 400, `${evil} should not succeed, got ${res.statusCode}`);
  }
});

test("publish fails when the entry file is absent, leaving nothing behind", async () => {
  const before = (await app.inject({
    method: "GET",
    url: "/_/api/bundles",
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json().length;

  const res = await publish({ "other.html": "<h1>x</h1>" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /entry not found/);

  const after = (await app.inject({
    method: "GET",
    url: "/_/api/bundles",
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json().length;
  assert.equal(after, before, "a failed publish must not leave a bundle");
});

test("an expired bundle is gone", async () => {
  const res = await publish({ "index.html": "<h1>hi</h1>" }, { "x-shoebox-ttl": "1ms" });
  const { id, secret } = res.json();
  await new Promise((r) => setTimeout(r, 5));
  const page = await app.inject({ method: "GET", url: `/${id}/?secret=${secret}` });
  assert.equal(page.statusCode, 404);
});

test("delete and prune remove bundles", async () => {
  const { id } = (await publish({ "index.html": "<h1>hi</h1>" })).json();
  const del = await app.inject({
    method: "DELETE",
    url: `/_/api/bundles/${id}`,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.json().removed, [id]);

  const listed = (await app.inject({
    method: "GET",
    url: "/_/api/bundles",
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json() as Array<{ id: string }>;
  assert.equal(listed.some((b) => b.id === id), false, "deleted bundle must not be listed");

  const gone = await app.inject({ method: "GET", url: `/${id}/` });
  assert.equal(gone.statusCode, 404, "deleted bundle must 404, not prompt for a password");

  const prune = await app.inject({
    method: "POST",
    url: "/_/api/prune",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    payload: { olderThan: "0ms" },
  });
  assert.equal(prune.statusCode, 200);
  assert.ok(Array.isArray(prune.json().removed));
});

test("robots.txt disallows everything", async () => {
  const res = await app.inject({ method: "GET", url: "/robots.txt" });
  assert.match(res.body, /Disallow: \//);
});

test("the bare id redirects to the trailing-slash form, preserving the secret", async () => {
  const { id, secret } = (await publish({ "index.html": "<h1>hi</h1>" })).json();

  const plain = await app.inject({ method: "GET", url: `/${id}` });
  assert.equal(plain.statusCode, 302);
  assert.equal(plain.headers.location, `/${id}/`);

  const withSecret = await app.inject({ method: "GET", url: `/${id}?secret=${secret}` });
  assert.equal(withSecret.statusCode, 302);
  assert.equal(withSecret.headers.location, `/${id}/?secret=${secret}`);
});
