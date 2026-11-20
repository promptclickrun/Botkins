import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Workspace } from "./starter.mjs";
import { fakeClient } from "./fake-copilot.mjs";
import { Folders, deviceArgs } from "../desktop/folders.mjs";
import { LinkHost } from "../desktop/link/index.mjs";
import { LinkClient, pair } from "../desktop/remote/link-client.mjs";
import { PLUGINS, pluginHandlers } from "../desktop/plugins.mjs";
import { SavedCredentials } from "../desktop/savedcredentials.mjs";

function filesIn(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

test("a paired phone manages plugin scope, versions and credentials over the production methods", { timeout: 45000 }, async (t) => {
  // The link really runs on loopback. Only the built-in GitHub catalogs are fixtures here.
  const networkFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, init) => {
    const endpoint = new URL(typeof url === "string" || url instanceof URL ? url : url.url);
    if (endpoint.hostname === "raw.githubusercontent.com") return Promise.resolve(Response.json({ plugins: [] }));
    assert.equal(endpoint.hostname, "127.0.0.1");
    return networkFetch(url, init);
  });
  const root = mkdtempSync(join(tmpdir(), "botkins-plugin-wire-"));
  const home = join(root, "home");
  const source = join(home, "market");
  const folder = join(source, "plugins", "garden");
  mkdirSync(join(source, ".github", "plugin"), { recursive: true });
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(source, ".github/plugin/marketplace.json"),
    JSON.stringify({
      name: "garden-market",
      plugins: [{ name: "garden", source: "plugins/garden" }],
    }),
  );
  const manifest = (version) =>
    JSON.stringify({
      name: "garden",
      version,
      userConfig: { GARDEN_KEY: { title: "Garden key", sensitive: true, required: true }, ACCOUNT: { title: "Account" } },
    });
  writeFileSync(join(folder, "plugin.json"), manifest("1.0.0"));
  const captured = [],
    logs = [];
  const markers = ["fixture-initial-93cd67", "fixture-replaced-44e569"];
  let host, phone;
  const ws = new Workspace(join(root, "workspace"), fakeClient().client, () => host?.changed());
  const handlers = pluginHandlers(ws.plugins, new SavedCredentials({ get: () => host.credentials }));
  const folders = new Folders({ home, volumes: [] });
  host = new LinkHost({
    dir: join(root, "wire"),
    port: 0,
    relay: false,
    log: (line) => logs.push(line),
    backend: {
      info: () => ({ app: "botkins" }),
      capabilities: [PLUGINS],
      snapshot: () => ws.snapshot(),
      subscribe: () => () => {},
      call: async (name, args) => handlers[name](...(await deviceArgs(folders, name, args))),
    },
  });
  t.after(async () => {
    phone?.stop();
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const ref = await host.credentials.save({ name: "Garden service", value: markers[1] });
  await host.setEnabled(true);
  const device = await pair(
    fetch,
    { hosts: ["127.0.0.1:" + host.port], code: host.startPairing().code },
    { name: "Fixture phone", platform: "ios" },
  );
  phone = new LinkClient(device, {
    fetch,
    onState() {},
    onParts(parts) {
      captured.push(parts);
    },
  });
  phone.start();
  const call = async (name, ...args) => {
    const reply = await phone.call("plugins." + name, ...args);
    captured.push(reply);
    return reply;
  };
  const market = await call("addMarketplace", source);
  assert.ok((await call("marketplaces")).some((m) => m.id === market.id));
  const page = await call("browse", { marketplace: market.id, query: "garden" });
  assert.equal(page.plugins.length, 1);
  const id = page.plugins[0].id;
  const preview = await call("preview", id);
  const installed = await call("install", id, { revision: preview.revision, bots: ["pip"], config: { GARDEN_KEY: markers[0] } });
  assert.deepEqual(installed.bots, ["pip"]);
  assert.equal(installed.status, "ready");
  await call("configure", id, { GARDEN_KEY: { $credential: ref }, ACCOUNT: { $credential: ref } });
  assert.equal(ws.plugins.values(ws.plugins.get(id)).ACCOUNT, markers[1]);
  assert.equal(ws.plugins.list()[0].config.find((field) => field.key === "ACCOUNT").value, undefined);
  await assert.rejects(call("setBots", id, [{ $credential: ref }]), /credential/i);
  assert.equal(ws.plugins.values(ws.plugins.get(id)).GARDEN_KEY, markers[1]);
  await call("setBots", id, ["scout"]);
  await call("setEnabled", id, false);
  assert.deepEqual(ws.plugins.list()[0].bots, ["scout"]);
  assert.equal(ws.plugins.list()[0].enabled, false);
  await call("setEnabled", id, true);
  writeFileSync(join(folder, "plugin.json"), manifest("1.1.0"));
  const newer = await call("preview", id);
  assert.notEqual(newer.revision, preview.revision);
  await assert.rejects(call("update", id, { revision: preview.revision }));
  assert.equal((await call("update", id, { revision: newer.revision })).revision, newer.revision);
  const local = await call("addFolder", folder);
  assert.equal(local.enabled, false);
  await assert.rejects(call("addFolder", root));
  for (let retry = 0; retry < 100 && !captured.some((part) => part?.plugins?.some?.((p) => p.id === local.id)); retry++) await delay(35);
  assert.ok(captured.some((part) => part?.plugins?.some?.((p) => p.id === local.id)));
  assert.ok(captured.some((part) => part?.meta?.capabilities.includes(PLUGINS)));
  await call("removeMarketplace", market.id);
  assert.equal(ws.plugins.list().length, 2);
  await call("uninstall", local.id);
  await call("uninstall", id);
  assert.deepEqual(ws.plugins.list(), []);
  for (const marker of markers) {
    assert.ok(!JSON.stringify([captured, logs, ws.snapshot()]).includes(marker), "a credential appeared in a public surface");
    for (const file of filesIn(root)) assert.ok(!readFileSync(file).includes(marker), "plaintext found in " + file);
  }
});
