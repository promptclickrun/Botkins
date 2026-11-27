import assert from "node:assert/strict";
import test from "node:test";
import { isSameSite, MULTI_LABEL_SUFFIXES } from "../src/site.mjs";

test("isSameSite compares scheme and registrable domain, so a login subdomain passes and another site fails", () => {
  assert.equal(isSameSite("https://login.example.com/session", "https://www.example.com"), true);
  assert.equal(isSameSite("https://www.example.com/login", "https://www.example.com"), true);
  assert.equal(isSameSite("https://accounts.example.co.uk/x", "https://www.example.co.uk"), true);

  assert.equal(isSameSite("https://evil.example/collect", "https://www.example.com"), false);
  assert.equal(isSameSite("https://example.com.evil.net/x", "https://www.example.com"), false);
  assert.equal(isSameSite("http://login.example.com/x", "https://www.example.com"), false, "a downgrade to HTTP is another site");
  assert.equal(isSameSite("https://user:pw@login.example.com/x", "https://www.example.com"), false);
  assert.equal(isSameSite("https://other.co.uk/x", "https://www.example.co.uk"), false, "a public suffix is not a shared site");
  assert.equal(isSameSite("https://bob.github.io/x", "https://alice.github.io"), false, "each tenant of a shared host is its own site");
  assert.equal(isSameSite("javascript:alert(1)", "https://www.example.com"), false);

  assert.equal(isSameSite("http://127.0.0.1:4000/x", "http://127.0.0.1:4000"), true);
  assert.equal(isSameSite("http://127.0.0.1:9/x", "http://127.0.0.1:4000"), false, "an IP literal compares by origin");
});

test("the extension's public-suffix list matches the desktop's registrableDomain list", async () => {
  const { readFileSync } = await import("node:fs");
  const desktop = readFileSync(new URL("../../desktop/desktop/link/domain-match.mjs", import.meta.url), "utf8");
  const block = desktop.slice(desktop.indexOf("const MULTI_LABEL_SUFFIXES = new Set(["), desktop.indexOf("]);", desktop.indexOf("const MULTI_LABEL_SUFFIXES")));
  const desktopSuffixes = [...block.matchAll(/"([a-z0-9.-]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...MULTI_LABEL_SUFFIXES].sort(), desktopSuffixes);
});
