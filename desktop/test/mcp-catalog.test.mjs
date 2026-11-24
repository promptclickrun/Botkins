// The direct apps catalog (desktop/mcp-catalog.mjs): the table's shape, and adding, connecting and
// configuring an app against a real workspace with a fake model client and a fake vault-backed store.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../cli/main.mjs";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { CATALOG, CATEGORIES, commandLine, mcpCatalog, MCP_CATALOG_CAPABILITY, MCP_CATALOG_METHODS, publicEntry } from "../desktop/mcp-catalog.mjs";
import { remoteArgs, REMOTE_METHODS } from "../desktop/link/methods.mjs";
import { CAPABILITIES, linkCapabilities } from "../desktop/runtime.mjs";
import { WORKSPACE, CHANGES, READS } from "../desktop/terminal/coverage.mjs";

function setup(t) {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {});
  ws.integrations.reachable = () => true;
  return { ws, catalog: mcpCatalog(() => ws.integrations) };
}
const entry = (id) => CATALOG.find((e) => e.id === id);
const SECRET = "sk-live-0123456789abcdef";

test("the catalog's entries are unique, well formed, pinned and checked", () => {
  const ids = CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, "unique ids");
  assert.ok(CATALOG.length >= 40);
  for (const e of CATALOG) {
    assert.match(e.id, /^[a-z0-9][a-z0-9-]{0,47}$/, e.id);
    assert.ok(e.name && e.description && e.description.length <= 120, e.id + " has a one-line description");
    assert.ok(Object.hasOwn(CATEGORIES, e.category), e.id + " has a Botkins category");
    assert.ok(["http", "stdio"].includes(e.transport), e.id + " transport");
    assert.ok(["none", "oauth", "key"].includes(e.auth), e.id + " auth");
    assert.match(e.docs, /^https:\/\//, e.id + " docs");
    assert.ok(e.verdict && e.checked, e.id + " records its check");
    if (e.transport === "http") {
      const url = new URL(e.url);
      // Only an app on this computer is reached without TLS.
      assert.equal(url.protocol === "https:" || (e.local && url.hostname === "127.0.0.1"), true, e.id + " address");
    } else {
      assert.match(e.version, /^\d+\.\d+\.\d+$/, e.id + " pins an exact version");
      assert.match(e.package, /^(@[a-z0-9-]+\/)?[a-z0-9.-]+$/, e.id + " package");
      assert.ok(["MIT", "Apache-2.0"].includes(e.license), e.id + " license is recorded");
      assert.equal(commandLine(e), "npx -y " + e.package + "@" + e.version);
    }
    if (e.auth === "key") {
      assert.ok(e.keys?.length, e.id + " names its keys");
      for (const key of e.keys) assert.equal(!!(key.env ?? key.header), true, e.id + " says where a key goes");
    }
    if (e.transport === "stdio") assert.ok(e.keys.every((key) => key.env), e.id + " keys go in the environment");
  }
  // OpenBot's names are nowhere in this table: every description is Botkins' own.
  assert.doesNotMatch(JSON.stringify(CATALOG), /openbot|nightly-labs/i);
});

test("a client sees labels and names only: no mapping, no value, no prefix", () => {
  for (const e of CATALOG) {
    const shown = publicEntry(e);
    for (const key of shown.keys) assert.deepEqual(Object.keys(key).filter((k) => !["id", "label", "hint"].includes(k)), [], e.id);
    assert.doesNotMatch(JSON.stringify(shown), /Bearer|"header"|"prefix"|"value"|"secret"/, e.id);
  }
});

test("the calls are on the link, gated by their capability, and covered by the terminal", () => {
  assert.ok(CAPABILITIES.includes(MCP_CATALOG_CAPABILITY));
  for (const call of MCP_CATALOG_METHODS) assert.ok(REMOTE_METHODS.has(call), call);
  assert.equal(linkCapabilities(new Set(["mcpCatalog.list"])).includes(MCP_CATALOG_CAPABILITY), false);
  assert.equal(linkCapabilities(new Set(MCP_CATALOG_METHODS)).includes(MCP_CATALOG_CAPABILITY), true);
  assert.deepEqual(WORKSPACE["mcpCatalog.list"], { command: "tools catalog" });
  assert.deepEqual(WORKSPACE["mcpCatalog.add"], { command: "tools connect" });
  assert.equal(CHANGES["mcpCatalog.add"], 0, "the log names the catalog id, never a key");
  assert.ok(READS.includes("mcpCatalog.list"));
});

test("an app with no sign-in is added with one call and is on", (t) => {
  const { ws, catalog } = setup(t);
  assert.equal(catalog.list().entries.find((e) => e.id === "deepwiki").added, false);
  const { serverId, next } = catalog.add("deepwiki");
  assert.equal(next, "done");
  const server = ws.integrations.server(serverId);
  assert.deepEqual([server.name, server.type, server.url, server.enabled, server.oauth], ["deepwiki", "http", "https://mcp.deepwiki.com/mcp", true, undefined]);
  const shown = catalog.list().entries.find((e) => e.id === "deepwiki");
  assert.deepEqual([shown.added, shown.serverId, shown.enabled], [true, serverId, true]);
  // Adding it again changes nothing and makes no second server.
  assert.equal(catalog.add("deepwiki").serverId, serverId);
  assert.equal(ws.integrations.servers.length, 1);
});

test("an OAuth app turns on the browser sign-in and says that a sign-in comes next", (t) => {
  const { ws, catalog } = setup(t);
  const { serverId, next } = catalog.add("linear");
  assert.equal(next, "sign-in");
  assert.deepEqual(ws.integrations.server(serverId).oauth, {});
  const shown = catalog.list().entries.find((e) => e.id === "linear");
  assert.deepEqual([shown.added, shown.signedIn], [true, false]);
  // A server the person added by hand at the same address counts as the same app.
  const { catalog: other, ws: ws2 } = setup(t);
  const mine = ws2.integrations.saveServer({ name: "my-notion", type: "http", url: "https://mcp.notion.com/mcp/" });
  assert.equal(other.list().entries.find((e) => e.id === "notion").serverId, mine);
  assert.equal(other.add("notion").serverId, mine);
  assert.deepEqual(ws2.integrations.server(mine).oauth, {}, "sign-in is turned on for it");
});

test("a key is typed once, kept in the vault, and never shown; Configure replaces it", (t) => {
  const { ws, catalog } = setup(t);
  assert.throws(() => catalog.add("render"), /Enter the API key for Render/);
  assert.throws(() => catalog.add("render", { keys: { key: "two\nlines" } }), (error) => !error.message.includes("two"));
  assert.throws(() => catalog.add("render", { keys: { other: SECRET } }), /doesn't take that field/);
  const { serverId, next } = catalog.add("render", { keys: { key: SECRET } });
  assert.equal(next, "done");
  const stored = ws.integrations.server(serverId);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(SECRET), "the workspace keeps a vault reference");
  assert.doesNotMatch(JSON.stringify(ws.snapshot()), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(catalog.list()), new RegExp(SECRET));
  assert.equal(catalog.list().entries.find((e) => e.id === "render").keysSet, true);
  // The session gets the real value, as a bearer header.
  assert.equal(ws.integrations.serversFor({}).render.headers.Authorization, "Bearer " + SECRET);
  // Configure without a key keeps it; with one, replaces it.
  catalog.add("render");
  assert.equal(ws.integrations.serversFor({}).render.headers.Authorization, "Bearer " + SECRET);
  catalog.add("render", { keys: { key: "sk-new-abcdef123456" } });
  assert.equal(ws.integrations.serversFor({}).render.headers.Authorization, "Bearer sk-new-abcdef123456");
  assert.equal(ws.integrations.servers.length, 1);
});

test("a program is added only with the person's yes to its exact command line", (t) => {
  const { ws, catalog } = setup(t);
  const brave = entry("brave-search");
  const line = commandLine(brave);
  assert.equal(line, "npx -y @brave/brave-search-mcp-server@2.1.4");
  assert.throws(() => catalog.add("brave-search", { keys: { key: SECRET } }), (error) => error.message.includes(line) && !error.message.includes(SECRET));
  assert.throws(() => catalog.add("brave-search", { keys: { key: SECRET }, confirm: "npx -y @brave/brave-search-mcp-server" }), /Confirm it/);
  assert.equal(ws.integrations.servers.length, 0, "nothing was added before the yes");
  const listed = catalog.list().entries.find((e) => e.id === "brave-search");
  assert.equal(listed.command, line, "the list shows the exact line");
  assert.deepEqual(listed.env, ["BRAVE_API_KEY"]);
  const { serverId } = catalog.add("brave-search", { keys: { key: SECRET }, confirm: line });
  const server = ws.integrations.server(serverId);
  assert.deepEqual([server.type, server.command, server.args], ["stdio", "npx", ["-y", "@brave/brave-search-mcp-server@2.1.4"]]);
  assert.equal(ws.integrations.serversFor({})["brave-search"].env.BRAVE_API_KEY, SECRET);
  assert.doesNotMatch(JSON.stringify(ws.snapshot()), new RegExp(SECRET));
});

test("the link cuts a catalog call to its shape and refuses a saved credential where a key goes", () => {
  assert.deepEqual(remoteArgs("mcpCatalog.list", ["anything"]), []);
  assert.deepEqual(remoteArgs("mcpCatalog.add", ["render", { keys: { key: "abc" }, extra: 1 }]), ["render", { keys: { key: "abc" } }]);
  assert.throws(() => remoteArgs("mcpCatalog.add", ["../etc", {}]), /Choose an app/);
  assert.throws(() => remoteArgs("mcpCatalog.add", ["render", { keys: { key: { $credential: "c1" } } }]), /saved credential/);
  assert.throws(() => remoteArgs("mcpCatalog.add", ["render", { confirm: 7 }]), /Confirm/);
});

test("`botkins tools connect` shows the line a program runs, needs a yes, and never prints a key", async (t) => {
  const { ws, catalog } = setup(t);
  const calls = [];
  const client = { call: async (name, ...args) => (calls.push(name), name === "mcpCatalog.list" ? catalog.list() : catalog.add(...args)) };
  let out = "";
  let err = "";
  const io = { stdout: { write: (text) => void (out += text) }, stderr: { write: (text) => void (err += text) }, env: {}, stdin: { isTTY: false }, client };
  assert.equal(await main(["tools", "connect", "brave-search"], io), 2);
  assert.match(err, /npx -y @brave\/brave-search-mcp-server@2\.1\.4/, "the line is shown before anything");
  assert.match(err, /BRAVE_API_KEY/);
  assert.match(err, /This needs a yes/);
  assert.deepEqual(calls, ["mcpCatalog.list"], "nothing was added");
  // With the yes, and the key from a file: added, and the key is printed nowhere.
  const secrets = join(tempDir(t), "keys.json");
  writeFileSync(secrets, JSON.stringify({ key: SECRET }));
  out = err = "";
  assert.equal(await main(["tools", "connect", "brave-search", "--yes", "--secrets", secrets], io), 0);
  assert.match(out, /Brave Search is added and on/);
  assert.doesNotMatch(out + err, new RegExp(SECRET));
  assert.equal(ws.integrations.serversFor({})["brave-search"].env.BRAVE_API_KEY, SECRET);
  // An OAuth app says what to run next; a key app with no terminal and no file says where the key comes from.
  out = err = "";
  assert.equal(await main(["tools", "connect", "linear"], io), 0);
  assert.match(out, /Sign it in next: botkins tools sign-in /);
  out = err = "";
  assert.equal(await main(["tools", "connect", "render"], io), 2);
  assert.match(err, /--secrets/);
  out = err = "";
  assert.equal(await main(["tools", "catalog", "--category", "code"], io), 0);
  assert.match(out, /render/);
  assert.doesNotMatch(out, /notion/);
});

test("an unknown app and a bad option are refused with a sentence", (t) => {
  const { catalog } = setup(t);
  assert.throws(() => catalog.add("not-here"), /isn't in the catalog/);
  assert.throws(() => catalog.add(7), /Choose an app/);
  assert.throws(() => catalog.add("deepwiki", []), /Invalid options/);
});
