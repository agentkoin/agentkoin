import { test } from "node:test";
import assert from "node:assert/strict";
test("dry-run guard disables fetch", async () => {
  const orig = globalThis.fetch;
  await import("../doorknock/no-net.mjs?" + Date.now());
  assert.throws(() => globalThis.fetch("https://example.com"));
  globalThis.fetch = orig;
});
