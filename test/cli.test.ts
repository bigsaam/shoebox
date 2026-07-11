import assert from "node:assert/strict";
import { test } from "node:test";
// The CLI is dependency-free JS; import just the pure helper. Importing the module
// must not run a command — see the `import.meta.main`-style guard at its foot.
import { resolveTtl } from "../bin/shoebox.mjs";

test("no --ttl flag defaults to 90d, so throwaway bundles don't accumulate forever", () => {
  assert.equal(resolveTtl(undefined), "90d");
});

test("an explicit --ttl is passed through untouched (the server validates it)", () => {
  assert.equal(resolveTtl("30d"), "30d");
  assert.equal(resolveTtl("1ms"), "1ms");
});

test("--ttl never opts back into a permanent bundle (header omitted)", () => {
  // null => the CLI sends no x-shoebox-ttl header => the server keeps it forever.
  assert.equal(resolveTtl("never"), null);
  assert.equal(resolveTtl("none"), null);
  assert.equal(resolveTtl("off"), null);
  assert.equal(resolveTtl("NEVER"), null);
});
