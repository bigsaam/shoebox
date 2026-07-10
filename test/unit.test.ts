import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, parseDuration, parseSize } from "../src/config.js";
import { safeEqual, signToken, verifyToken } from "../src/crypto.js";
import { ID_PATTERN, isValidId, newId, newSecret } from "../src/ids.js";
import { isSafeEntry, resolveWithin } from "../src/store.js";
import { idFromHost, linkFor, secretLinkFor } from "../src/links.js";

const SECRET = "test-session-secret";

test("parseDuration accepts units and rejects junk", () => {
  assert.equal(parseDuration("30d"), 30 * 86_400_000);
  assert.equal(parseDuration("12h"), 12 * 3_600_000);
  assert.equal(parseDuration("90m"), 90 * 60_000);
  assert.throws(() => parseDuration("soon"));
  assert.throws(() => parseDuration("30"));
  assert.throws(() => parseDuration("30y"));
});

test("parseSize accepts units and rejects junk", () => {
  assert.equal(parseSize("100mb"), 100 * 1024 ** 2);
  assert.equal(parseSize("1gb"), 1024 ** 3);
  assert.throws(() => parseSize("big"));
});

test("safeEqual compares without throwing on length mismatch", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("token round-trips and carries its scope", () => {
  const tok = signToken("all", Date.now() + 10_000, SECRET);
  assert.deepEqual(verifyToken(tok, SECRET), { scope: "all" });
});

test("token rejects tampering, expiry, and the wrong secret", () => {
  const exp = Date.now() + 10_000;
  assert.equal(verifyToken(signToken("all", exp, SECRET) + "x", SECRET), null);
  assert.equal(verifyToken(signToken("all", Date.now() - 1, SECRET), SECRET), null);
  assert.equal(verifyToken(signToken("all", exp, SECRET), "other-secret"), null);
  assert.equal(verifyToken("garbage", SECRET), null);
  assert.equal(verifyToken("a.b.c", SECRET), null);
});

test("a bundle token cannot be replayed against another bundle", () => {
  // The scope is inside the signature, so swapping the scope prefix invalidates it.
  const tok = signToken("bcdfghjk", Date.now() + 10_000, SECRET);
  const claims = verifyToken(tok, SECRET);
  assert.equal(claims?.scope, "bcdfghjk");

  const forged = tok.replace("bcdfghjk", "zzzzzzzz");
  assert.equal(verifyToken(forged, SECRET), null);
});

test("ids use the unambiguous alphabet", () => {
  for (let i = 0; i < 200; i++) {
    const id = newId();
    assert.match(id, ID_PATTERN);
    assert.equal(isValidId(id), true);
    assert.equal(/[aeiou01lo]/.test(id), false);
  }
  assert.equal(isValidId("../../etc"), false);
  assert.equal(isValidId("_health"), false);
  assert.equal(isValidId("short"), false);
});

test("secrets are 128-bit hex", () => {
  assert.match(newSecret(), /^[0-9a-f]{32}$/);
});

test("resolveWithin refuses to escape the bundle root", () => {
  const root = "/srv/data/bcdfghjk";
  assert.equal(resolveWithin(root, "index.html"), "/srv/data/bcdfghjk/index.html");
  assert.equal(resolveWithin(root, "assets/app.js"), "/srv/data/bcdfghjk/assets/app.js");

  // Traversal is normalised away, never escaping the root.
  for (const evil of ["../../etc/passwd", "..%2f..%2fetc", "/etc/passwd", "a/../../../etc/passwd"]) {
    const out = resolveWithin(root, evil);
    assert.ok(out === null || out.startsWith(root), `${evil} escaped to ${out}`);
  }

  assert.equal(resolveWithin(root, "x\0.html"), null);
});

test("isSafeEntry rejects traversal", () => {
  assert.equal(isSafeEntry("index.html"), true);
  assert.equal(isSafeEntry("app/main.html"), true);
  assert.equal(isSafeEntry("../secrets"), false);
  assert.equal(isSafeEntry("/etc/passwd"), false);
  assert.equal(isSafeEntry(""), false);
});

// --- host resolution -------------------------------------------------------

function cfgWith(hostTemplate: string | null) {
  return {
    hostTemplate,
    publicScheme: hostTemplate ? "https" : "http",
    baseUrl: "http://localhost:8080",
  } as unknown as import("../src/config.js").Config;
}

test("idFromHost extracts a valid id and rejects everything else", () => {
  const cfg = cfgWith("{id}.preview.enzoiwith.us");
  assert.equal(idFromHost(cfg, "bcdfghjk.preview.enzoiwith.us"), "bcdfghjk");
  assert.equal(idFromHost(cfg, "BCDFGHJK.Preview.Enzoiwith.US"), "bcdfghjk");
  assert.equal(idFromHost(cfg, "bcdfghjk.preview.enzoiwith.us:8080"), "bcdfghjk");

  assert.equal(idFromHost(cfg, "preview.enzoiwith.us"), null, "apex is not a bundle");
  assert.equal(idFromHost(cfg, "short.preview.enzoiwith.us"), null);
  assert.equal(idFromHost(cfg, "aeiouaei.preview.enzoiwith.us"), null, "vowels are not in the alphabet");
  assert.equal(idFromHost(cfg, "bcdfghjk.evil.com"), null, "suffix must match");
  assert.equal(idFromHost(cfg, "bcdfghjk.preview.enzoiwith.us.evil.com"), null);
  assert.equal(idFromHost(cfg, undefined), null);
  assert.equal(idFromHost(cfgWith(null), "bcdfghjk.preview.enzoiwith.us"), null, "path mode has no host ids");
});

test("linkFor uses the bundle subdomain, never the publishing host", () => {
  const sub = cfgWith("{id}.preview.enzoiwith.us");
  // Published over Tailscale, but the link is still the public one.
  assert.equal(linkFor(sub, "bcdfghjk", "http://manz-utils:8080"), "https://bcdfghjk.preview.enzoiwith.us/");
  assert.equal(
    secretLinkFor(sub, "bcdfghjk", "abc", "http://manz-utils:8080"),
    "https://bcdfghjk.preview.enzoiwith.us/?secret=abc",
  );
  // A non-index entry has to appear in the link; Caddy resolves / with try_files.
  assert.equal(linkFor(sub, "bcdfghjk", "x", "app.html"), "https://bcdfghjk.preview.enzoiwith.us/app.html");

  const path_ = cfgWith(null);
  assert.equal(linkFor(path_, "bcdfghjk", "http://x"), "http://localhost:8080/bcdfghjk/");
});

test("a share-<id> template parses, and neighbours on the same domain do not", () => {
  const cfg = cfgWith("share-{id}.enzoiwith.us");
  assert.equal(idFromHost(cfg, "share-bcdfghjk.enzoiwith.us"), "bcdfghjk");
  assert.equal(linkFor(cfg, "bcdfghjk", "x"), "https://share-bcdfghjk.enzoiwith.us/");

  // Sibling services must never be mistaken for bundles.
  for (const host of [
    "mytube.enzoiwith.us",
    "tripwala.enzoiwith.us",
    "enzoiwith.us",
    "share-.enzoiwith.us",
    "share-short.enzoiwith.us",
    "xshare-bcdfghjk.enzoiwith.us",
    "share-bcdfghjk.evil.enzoiwith.us",
    "share-bcdfghjk.enzoiwith.us.evil.com",
  ]) {
    assert.equal(idFromHost(cfg, host), null, `${host} must not resolve to a bundle`);
  }
});

test("cookie sharing is refused when the id lives inside a hostname label", () => {
  const base = {
    SHOEBOX_PASSWORD: "p",
    SHOEBOX_API_TOKEN: "t",
    SHOEBOX_SESSION_SECRET: "s",
  } as NodeJS.ProcessEnv;

  // .enzoiwith.us would also be sent to every other service on the domain.
  assert.throws(
    () => loadConfig({ ...base, SHOEBOX_HOST_TEMPLATE: "share-{id}.enzoiwith.us", SHOEBOX_COOKIE_DOMAIN: ".enzoiwith.us" }),
    /cannot be used with SHOEBOX_HOST_TEMPLATE/,
  );

  // Its own parent is fine: that domain spans bundles and nothing else.
  const ok = loadConfig({
    ...base,
    SHOEBOX_HOST_TEMPLATE: "{id}.preview.enzoiwith.us",
    SHOEBOX_COOKIE_DOMAIN: ".preview.enzoiwith.us",
  });
  assert.equal(ok.cookieDomain, ".preview.enzoiwith.us");

  // And a share- template without cookie sharing starts normally.
  assert.equal(loadConfig({ ...base, SHOEBOX_HOST_TEMPLATE: "share-{id}.enzoiwith.us" }).cookieDomain, null);
});

test("a host template must contain {id} exactly once", () => {
  const base = { SHOEBOX_PASSWORD: "p", SHOEBOX_API_TOKEN: "t", SHOEBOX_SESSION_SECRET: "s" } as NodeJS.ProcessEnv;
  assert.throws(() => loadConfig({ ...base, SHOEBOX_HOST_TEMPLATE: "preview.example.com" }), /must contain \{id\}/);
  assert.throws(() => loadConfig({ ...base, SHOEBOX_HOST_TEMPLATE: "{id}.{id}.example.com" }), /exactly once/);
});
