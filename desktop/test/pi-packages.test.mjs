import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiPackages } from "../desktop/providers/pi/packages.mjs";

const name = "@garden/pi-rose";
const version = "1.2.3";
const listing =
  '<article data-package-card="true" data-package-name="@garden/pi-rose" data-package-types="skill"><p class="packages-desc">Roses &amp; gardens</p></article><a class="pagination-link" href="/packages?page=2">Next →</a>';
const detail = "<dt>Package</dt><dd><code>@garden/pi-rose</code></dd><dt>Version</dt><dd><code>1.2.3</code></dd>";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-pi-market-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const urls = [],
    installs = [];
  const options = {
    dataDir: dir,
    fetch: async (input) => {
      const url = new URL(input);
      urls.push(url);
      return new Response(url.pathname === "/packages" ? listing : detail);
    },
    install: async (source, agentDir) => {
      installs.push(source);
      const pkg = join(agentDir, "npm", "node_modules", name);
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }));
    },
  };
  return { market: new PiPackages(options), options, urls, installs };
}

test("browse the Pi catalog with its own filter and pagination", async (t) => {
  const { market, urls } = setup(t);
  const found = await market.browse({ query: "rose & co", page: 1 });
  assert.deepEqual(found, { packages: [{ name, description: "Roses & gardens", types: ["skill"] }], nextPage: 2 });
  assert.equal(urls[0].origin, "https://pi.dev");
  assert.equal(urls[0].searchParams.get("name"), "rose & co");
});

test("install the reviewed version once and keep activation across restarts", async (t) => {
  const { market, options, installs } = setup(t);
  assert.deepEqual(await market.preview(name), { name, version });
  await assert.rejects(market.install(name, "1.2.2"), /changed/);
  await Promise.all([market.install(name, version), market.install(name, version)]);
  assert.deepEqual(installs, ["npm:@garden/pi-rose@1.2.3"]);
  assert.deepEqual(market.list(), [{ name, version, enabled: true }]);
  assert.equal(market.activePaths().length, 1);
  market.setEnabled(name, version, false);
  await assert.rejects(market.install(name, version), /switched off/);
  const reopened = new PiPackages(options);
  assert.deepEqual(reopened.activePaths(), []);
  assert.throws(() => reopened.setEnabled(name, "1.2.2", true), /version/);
  reopened.setEnabled(name, version, true);
  assert.ok(reopened.activePaths()[0].endsWith(join("node_modules", name)));
});

test("failed installs publish nothing and unsafe sources never reach Pi", async (t) => {
  const { options } = setup(t);
  let count = 0;
  const market = new PiPackages({
    ...options,
    install: async () => {
      count++;
      throw new Error("registry unavailable");
    },
  });
  for (const source of ["../folder", "git:example", "pi;bad", "--help", "pkg@latest"]) {
    await assert.rejects(market.install(source, version));
  }
  assert.equal(count, 0);
  await assert.rejects(market.install(name, version), /registry unavailable/);
  assert.deepEqual(market.list(), []);
  assert.deepEqual(market.activePaths(), []);
  await new PiPackages(options).install(name, version);
});
