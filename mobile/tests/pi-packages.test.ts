import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { TEAM_METHODS } from "../link-host/team.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { InstalledPiPackage, PiPackageListing, PiPackageVersion } from "../src/link/types";

test("a paired phone browses, reviews, installs and switches a Pi package", async (t) => {
  const backend = new MockBackend();
  assert.ok(backend.capabilities.includes("pi-packages-v1"));
  const dir = mkdtempSync(join(tmpdir(), "botkins-pi-link-"));
  const host = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  t.after(async () => {
    await host.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  await host.setEnabled(true);
  const fetcher = fetch as unknown as FetchLike;
  const pairing = await pair(
    fetcher,
    { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code },
    { name: "Phone", platform: "ios" },
  );
  const client = new LinkClient(pairing, { fetch: fetcher, onParts() {}, onState() {} });
  t.after(() => client.stop());
  const page = await client.call<{ packages: PiPackageListing[] }>("piPackages.browse", { query: "garden" });
  const { name, version } = await client.call<PiPackageVersion>("piPackages.preview", page.packages[0].name);
  const installed = { name, version, enabled: true };
  assert.deepEqual(await client.call("piPackages.install", name, version), installed);
  assert.deepEqual(await client.call("piPackages.list"), [installed]);
  assert.equal((await client.call<InstalledPiPackage>("piPackages.setEnabled", name, version, false)).enabled, false);
  assert.deepEqual(await client.call("piPackages.setEnabled", name, version, true), installed);
  await assert.rejects(client.call("piPackages.setEnabled", name, version, "false"), /on or off/);
  await assert.rejects(client.call("piPackages.install", "../package", version), /catalog/);
  assert.deepEqual(TEAM_METHODS["piPackages.install"], ["plugins", "install"]);
  assert.deepEqual(TEAM_METHODS["piPackages.setEnabled"], ["plugins", "manage"]);
});
