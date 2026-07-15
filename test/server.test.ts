import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
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

async function update(id: string, files: Record<string, string>, headers: Record<string, string> = {}) {
  return app.inject({
    method: "PUT",
    url: `/_/api/bundles/${id}`,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/gzip",
      ...headers,
    },
    payload: await tarball(files),
  });
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

test("update replaces content in place, keeping the id, secret, link, and view count", async () => {
  const created = (await publish({ "index.html": "<h1>v1</h1>", "old.js": "1" })).json();

  // Put a non-zero view count on disk so we can prove an update preserves it.
  const metaPath = path.join(dataDir, "meta", `${created.id}.json`);
  const meta0 = JSON.parse(await fs.readFile(metaPath, "utf8"));
  meta0.views = 5;
  await fs.writeFile(metaPath, JSON.stringify(meta0));

  const res = await update(created.id, { "index.html": "<h1>v2</h1>", "new.js": "2" });
  assert.equal(res.statusCode, 200);
  const body = res.json();

  assert.equal(body.id, created.id, "id is preserved");
  assert.equal(body.secret, created.secret, "secret is preserved — the bypass link still works");
  assert.equal(body.url, created.url);
  assert.equal(body.createdAt, created.createdAt, "createdAt is preserved");
  assert.equal(body.views, 5, "view count survives an update");
  assert.equal(body.files, 2);

  // The new content is served, and a file dropped in v2 is really gone.
  assert.deepEqual(await bundleFiles(created.id), ["index.html", "new.js"]);
  const grant = await app.inject({ method: "GET", url: `/${created.id}/?secret=${created.secret}` });
  const cookie = `sb_${created.id}=${grant.cookies.find((c) => c.name === `sb_${created.id}`)!.value}`;
  const page = await app.inject({ method: "GET", url: `/${created.id}/`, headers: { cookie } });
  assert.equal(page.body, "<h1>v2</h1>");
});

test("updating a bundle that does not exist is a 404", async () => {
  const res = await update("bcdfghjk", { "index.html": "<h1>x</h1>" });
  assert.equal(res.statusCode, 404);
});

test("a rejected update leaves the previous content intact", async () => {
  const created = (await publish({ "index.html": "<h1>keep me</h1>" })).json();

  // No index.html and no --entry → the update must fail entry validation.
  const res = await update(created.id, { "other.html": "<h1>nope</h1>" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /entry not found/);

  // The live bundle is untouched: still one file, still the original content.
  assert.deepEqual(await bundleFiles(created.id), ["index.html"]);
  const grant = await app.inject({ method: "GET", url: `/${created.id}/?secret=${created.secret}` });
  const cookie = `sb_${created.id}=${grant.cookies.find((c) => c.name === `sb_${created.id}`)!.value}`;
  const page = await app.inject({ method: "GET", url: `/${created.id}/`, headers: { cookie } });
  assert.equal(page.body, "<h1>keep me</h1>");
});

test("update leaves expiry alone unless a ttl is given, and can reset or clear it", async () => {
  const created = (await publish({ "index.html": "<h1>hi</h1>" })).json(); // no ttl → null
  assert.equal(created.expiresAt, null);

  const kept = (await update(created.id, { "index.html": "<h1>hi2</h1>" })).json();
  assert.equal(kept.expiresAt, null, "no ttl header leaves expiry untouched");

  const dated = (
    await update(created.id, { "index.html": "<h1>hi3</h1>" }, { "x-shoebox-ttl": "1h" })
  ).json();
  assert.ok(dated.expiresAt && Date.parse(dated.expiresAt) > Date.now(), "a ttl resets expiry from now");

  const cleared = (
    await update(created.id, { "index.html": "<h1>hi4</h1>" }, { "x-shoebox-ttl": "never" })
  ).json();
  assert.equal(cleared.expiresAt, null, "'never' clears expiry again");
});

test("update requires the api token", async () => {
  const created = (await publish({ "index.html": "<h1>hi</h1>" })).json();
  const res = await app.inject({
    method: "PUT",
    url: `/_/api/bundles/${created.id}`,
    headers: { "content-type": "application/gzip" },
    payload: await tarball({ "index.html": "<h1>x</h1>" }),
  });
  assert.equal(res.statusCode, 401);
});

test("robots.txt disallows everything", async () => {
  const res = await app.inject({ method: "GET", url: "/robots.txt" });
  assert.match(res.body, /Disallow: \//);
});

test("the branded 404 page is served at /_/notfound", async () => {
  const res = await app.inject({ method: "GET", url: "/_/notfound" });
  assert.equal(res.statusCode, 404);
  assert.match(res.headers["content-type"] as string, /text\/html/);
  assert.match(res.body, /Nothing here/);
  assert.match(res.body, /noindex/); // must not be indexable
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

/** Every file inside a bundle, as posix-relative paths. */
async function bundleFiles(id: string): Promise<string[]> {
  const root = path.join(dataDir, "bundles", id);
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  await walk(root);
  return out.sort();
}

// macOS `tar` writes an AppleDouble `._<name>` sidecar for any file carrying extended
// attributes, and those sidecars embed the xattrs verbatim — including
// `com.apple.metadata:kMDItemWhereFroms`, i.e. the URL the file was downloaded from.
// Publishing them would serve a viewer the internal URL a report came from. The upload
// endpoint is the trust boundary: any client can send such a tarball, not just our CLI.
test("AppleDouble sidecars and Finder junk never land in a bundle", async () => {
  const res = await publish({
    "index.html": "<h1>hi</h1>",
    "._index.html": "Mac OS X kMDItemWhereFroms https://internal.example.com/confidential",
    "assets/app.js": "console.log(1)",
    "assets/._app.js": "com.apple.quarantine",
    "._.": "directory xattrs",
    ".DS_Store": "Finder layout, names siblings that were never published",
  });
  assert.equal(res.statusCode, 201);

  assert.deepEqual(await bundleFiles(res.json().id), ["assets/app.js", "index.html"]);
});

test("a bundle whose every member is AppleDouble junk fails, rather than publishing empty", async () => {
  const res = await publish({ "._index.html": "junk", ".DS_Store": "junk" });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /entry not found/);
});

// ── Per-bundle /api backend ────────────────────────────────────────────────
// These run against a second app configured in subdomain mode (so idFromHost can
// recover the bundle from the Host header) with a throwaway upstream server.

/** Run `fn` against a fresh subdomain-mode app. */
async function withApiApp(
  fn: (a: FastifyInstance) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shoebox-api-"));
  const c: Config = { ...cfg, dataDir: dir, hostTemplate: "{id}.preview.example.com", serveFiles: false };
  const { app: a } = await buildServer(c);
  await a.ready();
  try {
    await fn(a);
  } finally {
    await a.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A throwaway upstream that records the last request and echoes the body back. */
async function stubUpstream(): Promise<{ url: string; last: () => any; close: () => Promise<void> }> {
  let last: any = null;
  const srv = http.createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      last = { method: rq.method, url: rq.url, contentType: rq.headers["content-type"], body };
      rs.writeHead(201, { "content-type": "application/json" });
      rs.end(JSON.stringify({ ok: true, echo: body }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as import("node:net").AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    last: () => last,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

async function passwordCookie(a: FastifyInstance): Promise<string> {
  const login = await a.inject({
    method: "POST",
    url: "/_/login",
    payload: `password=${encodeURIComponent(PASSWORD)}&next=/`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  return `sb_all=${login.cookies.find((c) => c.name === "sb_all")!.value}`;
}

async function publishTo(a: FastifyInstance, extra: Record<string, string> = {}) {
  return a.inject({
    method: "POST",
    url: "/_/api/bundles",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/gzip",
      "x-shoebox-name": "t",
      ...extra,
    },
    payload: await tarball({ "index.html": "<h1>hi</h1>" }),
  });
}

test("a bundle's /api is proxied to its upstream — prefix stripped, method + body + query preserved", async () => {
  await withApiApp(async (a) => {
    const up = await stubUpstream();
    try {
      const pub = await publishTo(a, { "x-shoebox-api": up.url });
      assert.equal(pub.statusCode, 201);
      assert.equal(pub.json().apiUpstream, up.url);
      const id = pub.json().id;
      const host = `${id}.preview.example.com`;
      const cookie = await passwordCookie(a);

      const post = await a.inject({
        method: "POST",
        url: "/api/vote-batch",
        headers: { host, cookie, "content-type": "application/json" },
        payload: JSON.stringify({ name: "Sam", choices: [] }),
      });
      assert.equal(post.statusCode, 201, "upstream status is passed through");
      assert.equal(post.json().ok, true);
      assert.equal(up.last().method, "POST");
      assert.equal(up.last().url, "/vote-batch", "the /api prefix is stripped");
      assert.deepEqual(JSON.parse(up.last().body), { name: "Sam", choices: [] });

      const get = await a.inject({ method: "GET", url: "/api/votes?x=1", headers: { host, cookie } });
      assert.equal(get.statusCode, 201);
      assert.equal(up.last().url, "/votes?x=1", "query string is preserved");
    } finally {
      await up.close();
    }
  });
});

test("/api on a bundle without a backend is a 404", async () => {
  await withApiApp(async (a) => {
    const id = (await publishTo(a)).json().id;
    const cookie = await passwordCookie(a);
    const res = await a.inject({
      method: "GET",
      url: "/api/x",
      headers: { host: `${id}.preview.example.com`, cookie },
    });
    assert.equal(res.statusCode, 404);
  });
});

test("/api is gated by the bundle's auth — no cookie, no proxy", async () => {
  await withApiApp(async (a) => {
    const up = await stubUpstream();
    try {
      const id = (await publishTo(a, { "x-shoebox-api": up.url })).json().id;
      const res = await a.inject({
        method: "GET",
        url: "/api/votes",
        headers: { host: `${id}.preview.example.com` },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(up.last(), null, "the upstream must never be hit unauthenticated");
    } finally {
      await up.close();
    }
  });
});

test("update can add and clear a bundle's /api backend", async () => {
  await withApiApp(async (a) => {
    const up = await stubUpstream();
    try {
      const id = (await publishTo(a)).json().id;
      const host = `${id}.preview.example.com`;
      const cookie = await passwordCookie(a);
      const hit = () => a.inject({ method: "GET", url: "/api/x", headers: { host, cookie } });

      assert.equal((await hit()).statusCode, 404, "no backend at first");

      const add = await a.inject({
        method: "PUT",
        url: `/_/api/bundles/${id}`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/gzip", "x-shoebox-api": up.url },
        payload: await tarball({ "index.html": "<h1>v2</h1>" }),
      });
      assert.equal(add.json().apiUpstream, up.url);
      assert.equal((await hit()).statusCode, 201, "backend reachable after update");

      const clear = await a.inject({
        method: "PUT",
        url: `/_/api/bundles/${id}`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/gzip", "x-shoebox-api": "none" },
        payload: await tarball({ "index.html": "<h1>v3</h1>" }),
      });
      assert.equal(clear.json().apiUpstream, null);
      assert.equal((await hit()).statusCode, 404, "backend cleared");
    } finally {
      await up.close();
    }
  });
});

test("a non-http api upstream is rejected at publish", async () => {
  await withApiApp(async (a) => {
    const res = await publishTo(a, { "x-shoebox-api": "file:///etc/passwd" });
    assert.equal(res.statusCode, 400);
  });
});
