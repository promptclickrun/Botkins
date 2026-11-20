// Plugins ("plugins-v1", docs/plugins.md): the phone's plain logic (hook events in words, a tool in
// one line, the alert before an install, chips, the status line, the settings form), the shapes the
// link lets through (link-host/methods.mjs) and where a saved credential may stand, and the demo
// computer end to end over a paired link: browse, preview, install with bots and settings, a secret
// that lands nowhere, bots, on and off, a reviewed revision for install and update, a folder plugin
// that arrives turned off, marketplaces added and removed. No network: every catalog is made up.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { PLUGIN_METHODS, REMOTE_METHODS, remoteArgs } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { botsLine, byLine, configValues, consent, fieldState, groupHooks, hookWords, hostOf, isMarketplaceSource, matchInstalled, missingFields, pluginChips, runsOnComputer, safeLink, statusLine, toolLine } from "../src/features/market/plugins/logic";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { InstalledPlugin, PluginContents, PluginField, PluginListing, PluginMarketplace, PluginPreview } from "../src/link/types";

const said = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return null;
};
const empty: PluginContents = { skills: [], agents: [], commands: [], mcpServers: [], hooks: [] };

// ── The phone's plain logic ─────────────────────────────────────────────────────────────────────

test("hook events read as the agreed words, in the order a turn meets them", () => {
  assert.equal(hookWords("sessionStart"), "When a chat starts");
  assert.equal(hookWords("userPromptSubmitted"), "Each message you send");
  assert.equal(hookWords("preToolUse"), "Before a tool runs");
  assert.equal(hookWords("postToolUse"), "After a tool runs");
  assert.equal(hookWords("agentStop"), "When a reply ends");
  assert.equal(hookWords("fileChanged"), "File changed");
  const groups = groupHooks([
    { event: "agentStop", command: "retain" },
    { event: "fileChanged", command: "watch" },
    { event: "sessionStart", command: "brief" },
    { event: "agentStop", command: "tidy" },
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.commands]), [["When a chat starts", ["brief"]], ["When a reply ends", ["retain", "tidy"]], ["File changed", ["watch"]]]);
});

test("a tool reads as its command or its host, and the alert asks only when something runs on the computer", () => {
  assert.equal(toolLine({ name: "db", kind: "local", command: "npx -y db-mcp" }), "Runs on your computer: npx -y db-mcp");
  assert.equal(toolLine({ name: "mem", kind: "remote", url: "https://user@Memory.Example.com:8443/mcp/x/" }), "Remote · memory.example.com");
  assert.equal(hostOf("not a url"), "");
  assert.equal(consent({ ...empty, skills: ["a"], mcpServers: [{ name: "r", kind: "remote", url: "https://x.example" }] }), null);
  assert.equal(runsOnComputer({ ...empty, mcpServers: [{ name: "db", kind: "local" }] }), true);
  const ask = consent({ ...empty, hooks: [{ event: "userPromptSubmitted", command: "a" }, { event: "agentStop", command: "b" }], mcpServers: [{ name: "db", kind: "local" }] });
  assert.equal(ask?.title, "This plugin runs commands on your computer");
  assert.equal(ask?.message, "It runs 2 commands (each message you send and when a reply ends) and 1 tool (db), with your access. Install it only if you trust where it comes from.");
  assert.equal(consent({ ...empty, hooks: [{ event: "sessionStart", command: "a" }] }, "turn on")?.action, "Turn on");
});

test("chips, the line under a name, the status and the settings' states", () => {
  const markets: PluginMarketplace[] = [{ id: "awesome-copilot", name: "GitHub", source: "github/awesome-copilot", builtIn: true }];
  assert.deepEqual(pluginChips(markets).map((chip) => chip.label), ["All", "GitHub", "Installed"]);
  assert.equal(pluginChips(markets)[1].marketplace, "awesome-copilot");
  const listing: PluginListing = { id: "opaque-1", name: "x", marketplace: "awesome-copilot" };
  assert.equal(byLine(listing, markets), "GitHub");
  assert.equal(byLine({ ...listing, author: "Keepsake" }, markets), "Keepsake");
  assert.equal(byLine({ ...listing, marketplace: "folder" }, markets), "Folder on your computer");
  assert.equal(statusLine({ status: "ready", enabled: true }), "Ready");
  assert.equal(statusLine({ status: "ready", enabled: false }), "Off");
  assert.equal(statusLine({ status: "needs-config", enabled: true }), "Needs settings");
  assert.equal(statusLine({ status: "needs-sign-in", enabled: true, detail: "Sign in to x." }), "Sign in on your computer");
  assert.equal(statusLine({ status: "error", enabled: true, detail: "Its hooks file couldn't be read." }), "Its hooks file couldn't be read.");
  const field = { key: "K", label: "Key", required: true };
  assert.equal(fieldState({ ...field, secret: true, set: true }), "Set");
  assert.equal(fieldState({ ...field, secret: true, set: false }), "Not set");
  assert.equal(fieldState({ ...field, secret: false, set: true, value: "bank-1" }), "bank-1");
  assert.equal(botsLine("all", {}), "All bots");
  assert.equal(botsLine(["b1"], { b1: "Mira" }), "Mira");
  assert.equal(botsLine(["b1", "b2"], {}), "2 bots");
});

test("the install form needs its required settings, and sends only what was filled", () => {
  const fields: PluginField[] = [
    { key: "API_KEY", label: "API key", secret: true, required: true },
    { key: "BANK", label: "Bank", secret: false, required: true },
    { key: "PATH_TO", label: "Path", secret: false, required: true, default: "~/x" },
    { key: "OPTIONAL", label: "Optional", secret: false, required: false },
  ];
  assert.deepEqual(missingFields(fields, {}), ["API key", "Bank"]);
  assert.deepEqual(missingFields(fields, { API_KEY: { text: "", credential: { id: "c1", name: "Saved" } }, BANK: { text: "  b " } }), []);
  assert.deepEqual(configValues(fields, { API_KEY: { text: "", credential: { id: "c1", name: "Saved" } }, BANK: { text: "  b " }, OPTIONAL: { text: "" } }), { API_KEY: { $credential: "c1" }, BANK: "b" });
  assert.deepEqual(configValues(fields, { API_KEY: { text: " s3cret " } }), { API_KEY: " s3cret " }, "a secret is sent as typed");
});

test("a marketplace source, a link and a search", () => {
  for (const good of ["github/awesome-copilot", "me/plugins#dev", "https://example.com/marketplace.json", "/Users/demo/Code"]) assert.ok(isMarketplaceSource(good), good);
  for (const bad of ["", "github", "http://example.com", "a/b/c", "x".repeat(301)]) assert.equal(isMarketplaceSource(bad), false, bad);
  assert.equal(safeLink("https://ok.example"), "https://ok.example");
  assert.equal(safeLink("javascript:alert(1)"), undefined);
  assert.equal(safeLink("http://plain.example"), undefined);
  const mine = [{ name: "zeta", description: "memory things" }, { name: "alpha", keywords: ["memory"] }, { name: "other" }] as InstalledPlugin[];
  assert.deepEqual(matchInstalled(mine, "memory").map((plugin) => plugin.name), ["alpha", "zeta"]);
});

// ── What the link lets through ──────────────────────────────────────────────────────────────────

test("a phone may make the twelve plugin calls, each cut to its shape", () => {
  assert.equal(PLUGIN_METHODS.length, 12);
  for (const name of PLUGIN_METHODS) assert.ok(REMOTE_METHODS.has(name), name);
  assert.deepEqual(remoteArgs("plugins.marketplaces", ["x"]), []);
  assert.deepEqual(remoteArgs("plugins.addMarketplace", ["  me/plugins  "]), ["me/plugins"]);
  assert.equal(said(() => remoteArgs("plugins.addMarketplace", ["x".repeat(301)])), "Enter owner/repo, a web address or a folder.");
  assert.deepEqual(remoteArgs("plugins.browse", [{ marketplace: "m", query: "  memory ", cursor: "50", extra: 1 }]), [{ marketplace: "m", query: "memory", cursor: "50" }]);
  assert.deepEqual(remoteArgs("plugins.browse", [{ query: "   " }]), [{}]);
  assert.equal(said(() => remoteArgs("plugins.browse", [{ query: "q".repeat(201) }])), "That search is too long.");
  assert.deepEqual(remoteArgs("plugins.preview", ["a@b", "more"]), ["a@b"]);
  for (const id of ["", "x".repeat(301), 7, null, "a\0b"]) assert.equal(said(() => remoteArgs("plugins.preview", [id])), "That plugin can't be found.", String(id));
  assert.deepEqual(remoteArgs("plugins.install", ["a", { bots: ["b1", "b1", "b2"], revision: "r1", path: "/x" }]), ["a", { bots: ["b1", "b2"], revision: "r1" }]);
  assert.deepEqual(remoteArgs("plugins.install", ["a"]), ["a", {}]);
  assert.equal(said(() => remoteArgs("plugins.install", ["a", { bots: [] }])), "Choose which bots use it.");
  assert.equal(said(() => remoteArgs("plugins.setBots", ["a", Array.from({ length: 201 }, (_, i) => "b" + i)])), "Choose which bots use it.");
  assert.deepEqual(remoteArgs("plugins.setBots", ["a", "all"]), ["a", "all"]);
  assert.deepEqual(remoteArgs("plugins.setEnabled", ["a", false]), ["a", false]);
  assert.equal(said(() => remoteArgs("plugins.setEnabled", ["a", "yes"])), "Choose on or off.");
  assert.deepEqual(remoteArgs("plugins.update", ["a", { revision: "r2", force: true }]), ["a", { revision: "r2" }]);
  assert.deepEqual(remoteArgs("plugins.update", ["a"]), ["a", {}]);
  assert.deepEqual(remoteArgs("plugins.addFolder", ["/Users/demo/team-skills"]), ["/Users/demo/team-skills"]);
  for (const path of ["team-skills", "/Users/demo/../x", ""]) assert.equal(said(() => remoteArgs("plugins.addFolder", [path])), "Choose a folder.", path);
});

test("settings hold at most 32 values of text, a saved credential or null", () => {
  assert.deepEqual(remoteArgs("plugins.configure", ["a", { A: "x", B: null, C: { $credential: "cred-1" } }]), ["a", { A: "x", B: null, C: { $credential: "cred-1" } }]);
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => ["K" + i, "v"]));
  assert.equal(said(() => remoteArgs("plugins.configure", ["a", many])), "Those settings can't be saved.");
  assert.equal(said(() => remoteArgs("plugins.configure", ["a", { A: "x".repeat(4001) }])), "A setting is up to 4,000 characters.");
  assert.equal(said(() => remoteArgs("plugins.configure", ["a", { A: 7 }])), "Those settings can't be saved.");
  assert.equal(said(() => remoteArgs("plugins.configure", ["a", { A: { $credential: "c", prefix: "Bearer " } }])), "Those settings can't be saved.");
  assert.equal(said(() => remoteArgs("plugins.configure", ["a", ["x"]])), "Those settings can't be saved.");
});

test("a saved credential stands only for a setting's value, nowhere else in a plugin call", () => {
  const ref = { $credential: "cred-1" };
  assert.deepEqual(remoteArgs("plugins.install", ["a", { config: { KEY: ref } }]), ["a", { config: { KEY: ref } }]);
  for (const [method, args] of [
    ["plugins.install", [ref, {}]],
    ["plugins.install", ["a", { bots: [ref] }]],
    ["plugins.install", ["a", { revision: ref }]],
    ["plugins.install", ["a", { config: {}, other: ref }]],
    ["plugins.configure", [ref, { A: "x" }]],
    ["plugins.update", ["a", { revision: ref }]],
    ["plugins.browse", [{ query: ref }]],
    ["plugins.addMarketplace", [ref]],
    ["plugins.setBots", ["a", [ref]]],
    ["plugins.setEnabled", ["a", ref]],
    ["plugins.addFolder", [ref]],
  ] as [string, unknown[]][])
    assert.equal(said(() => remoteArgs(method, args)), "A credential can't be used there.", method + " " + JSON.stringify(args));
});

// ── The demo computer, over a paired link ───────────────────────────────────────────────────────

const fetcher = fetch as unknown as FetchLike;

function filesUnder(dir: string): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push({ path, text: readFileSync(path).toString("latin1") });
  }
  return found;
}

async function paired(options: { pluginPage?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-plugins-"));
  const backend = new MockBackend({ speed: 0.05, ...options });
  const link = new LinkHost({ relay: false, dir, backend, port: 0, extraHosts: ["127.0.0.1"] });
  await link.setEnabled(true);
  const pairing = await pair(fetcher, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Test phone", platform: "ios" });
  const sent: string[] = [];
  const parts: Record<string, unknown> = {};
  let waiters: (() => void)[] = [];
  const client = new LinkClient(pairing, {
    fetch: fetcher,
    onParts(next) {
      sent.push(JSON.stringify(next));
      Object.assign(parts, next);
      for (const wake of waiters) wake();
      waiters = [];
    },
    onState: () => {},
  });
  client.start();
  const until = async (check: () => boolean, what: string, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error("Timed out waiting for " + what);
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, 50))]);
    }
  };
  await until(() => !!parts.chats, "the first state");
  const plugins = () => (parts.plugins as InstalledPlugin[] | undefined) ?? [];
  const plugin = (id: string) => plugins().find((item) => item.id === id);
  const refusal = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      return (error as Error).message;
    }
    return null;
  };
  return { dir, backend, link, client, parts, sent, until, plugins, plugin, refusal };
}

const MEMORY = "keepsake-memory@awesome-copilot";

test("the demo computer names plugins-v1, and leaves it out with BOTKINS_DEV_PLUGINS=off", () => {
  assert.ok(new MockBackend({ speed: 0.05 }).capabilities.includes("plugins-v1"));
  process.env.BOTKINS_DEV_PLUGINS = "off";
  try {
    const older = new MockBackend({ speed: 0.05 });
    assert.equal(older.capabilities.includes("plugins-v1"), false);
    assert.equal("plugins" in older.snapshot(), false, "no plugins part either");
  } finally {
    delete process.env.BOTKINS_DEV_PLUGINS;
  }
});

test("browse, preview and install a plugin with bots and settings; its secret lands nowhere", async () => {
  const setup = await paired({ pluginPage: 5 });
  const { backend, link, client, parts, sent, until, dir, plugin } = setup;
  const marker = "MARKER-plugin-secret-6b1d";
  const savedMarker = "MARKER-plugin-saved-0e7f";
  try {
    const markets = await client.call<PluginMarketplace[]>("plugins.marketplaces");
    assert.deepEqual(markets.map((market) => [market.id, market.name, market.builtIn]), [["awesome-copilot", "GitHub", true], ["copilot-plugins", "Copilot plugins", true]]);
    assert.equal(markets[0].count, 12);

    // Paging by cursor, by name, through every plugin of every catalog.
    const seen: PluginListing[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.call<{ plugins: PluginListing[]; cursor?: string }>("plugins.browse", { ...(cursor && { cursor }) });
      assert.ok(page.plugins.length <= 5);
      seen.push(...page.plugins);
      cursor = page.cursor;
    } while (cursor);
    assert.equal(seen.length, 15);
    assert.deepEqual(seen.map((item) => item.name), [...seen.map((item) => item.name)].sort((a, b) => a.localeCompare(b)));
    assert.equal(seen.find((item) => item.name === "writing-skills")?.installed, true, "the one installed at the start says so");
    const found = await client.call<{ plugins: PluginListing[] }>("plugins.browse", { marketplace: "awesome-copilot", query: "memory" });
    assert.deepEqual(found.plugins.map((item) => item.id), [MEMORY]);

    const preview = await client.call<PluginPreview>("plugins.preview", MEMORY);
    assert.deepEqual(preview.contents.hooks.map((hook) => hook.event), ["sessionStart", "userPromptSubmitted", "agentStop"]);
    assert.equal(preview.contents.mcpServers[0].kind, "remote");
    assert.deepEqual(preview.config.map((field) => [field.key, field.secret, field.required]), [["MEMORY_API_KEY", true, true], ["MEMORY_BANK_ID", false, true]]);
    assert.ok(preview.warnings?.includes("Runs a command on your computer at each message you send."));
    assert.ok(preview.postInstallMessage && preview.revision);

    // A stale revision is refused, and nothing is installed.
    assert.equal(await setup.refusal(client.call("plugins.install", MEMORY, { revision: "not-this-one" })), "This plugin changed since you looked at it. Look at it again before you install it.");
    assert.equal(plugin(MEMORY), undefined);

    const bots = (parts.bots as { id: string }[]).map((bot) => bot.id);
    const installed = await client.call<InstalledPlugin>("plugins.install", MEMORY, { bots: [bots[0]], config: { MEMORY_API_KEY: marker, MEMORY_BANK_ID: "bank-demo" }, revision: preview.revision });
    assert.equal(installed.status, "ready");
    await until(() => !!plugin(MEMORY), "the plugins part");
    const shown = plugin(MEMORY)!;
    assert.deepEqual(shown.bots, [bots[0]]);
    assert.deepEqual(shown.config.map((field) => [field.key, field.set, field.value]), [["MEMORY_API_KEY", true, undefined], ["MEMORY_BANK_ID", true, "bank-demo"]]);
    assert.match(shown.limits ?? "", /only this plugin's skills/);
    assert.equal(await setup.refusal(client.call("plugins.install", MEMORY, {})), "That plugin is already installed.");

    // A secret cleared needs settings again; then set from a saved credential, by reference.
    await client.call("plugins.configure", MEMORY, { MEMORY_API_KEY: null });
    await until(() => plugin(MEMORY)?.status === "needs-config", "needs settings");
    const saved: string = await link.credentials.save({ name: "Memory key", kind: "api-key", value: savedMarker });
    await client.call("plugins.configure", MEMORY, { MEMORY_API_KEY: { $credential: saved } });
    await until(() => plugin(MEMORY)?.status === "ready", "ready again");
    assert.equal(plugin(MEMORY)!.config[0].set, true);

    // Bots and on and off.
    await client.call("plugins.setBots", MEMORY, "all");
    await until(() => plugin(MEMORY)?.bots === "all", "all bots");
    assert.equal(await setup.refusal(client.call("plugins.setBots", MEMORY, ["no-such-bot"])), "This bot no longer exists.");
    await client.call("plugins.setEnabled", MEMORY, false);
    await until(() => plugin(MEMORY)?.enabled === false, "off");
    await client.call("plugins.setEnabled", MEMORY, true);
    await until(() => plugin(MEMORY)?.enabled === true, "on");

    await new Promise((resolve) => setTimeout(resolve, 300));
    const places: [string, string][] = [
      ["the parts sent to the phone", sent.join("\n")],
      ["the demo's state", JSON.stringify(backend.state)],
      ["the demo's plugins", JSON.stringify(backend.plugins)],
      ...filesUnder(dir).map((file): [string, string] => ["the saved file " + file.path, file.text]),
    ];
    assert.ok(sent.join("\n").includes("MEMORY_API_KEY"), "the search sees what is there");
    for (const [where, text] of places) for (const secret of [marker, savedMarker]) assert.equal(text.includes(secret), false, secret + " was found in " + where);

    await client.call("plugins.uninstall", MEMORY);
    await until(() => !plugin(MEMORY), "removed");
  } finally {
    client.stop();
    await link.stop();
  }
});

test("an update shows a new revision, and a stale one is refused", async () => {
  const setup = await paired();
  const { link, client, until, plugin } = setup;
  const id = "writing-skills@awesome-copilot";
  try {
    // Installed at the start; the catalog has moved on once since.
    await until(() => plugin(id)?.updateAvailable === true, "an update");
    assert.equal(plugin(id)!.version, "1.2.0");
    const next = await client.call<PluginPreview>("plugins.preview", id);
    assert.equal(next.version, "1.3.0");
    assert.ok(next.contents.skills.includes("headlines"));
    assert.equal(await setup.refusal(client.call("plugins.update", id, { revision: "an-old-one" })), "This plugin changed since you looked at it. Look at it again before you update it.");
    assert.equal(plugin(id)!.version, "1.2.0");
    const done = await client.call<InstalledPlugin>("plugins.update", id, { revision: next.revision });
    assert.equal(done.version, "1.3.0");
    await until(() => plugin(id)?.version === "1.3.0" && !plugin(id)?.updateAvailable, "the update");
    assert.ok(plugin(id)!.contents.skills.includes("headlines"));
  } finally {
    client.stop();
    await link.stop();
  }
});

test("an OAuth tool needs a sign-in on the computer, a local tool has a default, a broken one says why", async () => {
  const setup = await paired();
  const { link, client, until, plugin, parts } = setup;
  try {
    await client.call("plugins.install", "tracker@awesome-copilot", {});
    await until(() => plugin("tracker@awesome-copilot")?.status === "needs-sign-in", "needs a sign-in");
    const serverId = plugin("tracker@awesome-copilot")!.contents.mcpServers[0].serverId!;
    assert.ok((parts.mcp as { id: string }[]).some((server) => server.id === serverId), "a tool server to sign in");
    await client.call("signInMcpServer", serverId);
    await until(() => plugin("tracker@awesome-copilot")?.status === "ready", "signed in");

    await client.call("plugins.install", "sqlite-explorer@awesome-copilot", {});
    await until(() => !!plugin("sqlite-explorer@awesome-copilot"), "sqlite");
    const sqlite = plugin("sqlite-explorer@awesome-copilot")!;
    assert.equal(sqlite.status, "ready");
    assert.equal(sqlite.contents.mcpServers[0].kind, "local");
    assert.equal(sqlite.config[0].value, "~/Documents/data.db");

    await client.call("plugins.install", "legacy-formatter@awesome-copilot", {});
    await until(() => plugin("legacy-formatter@awesome-copilot")?.status === "error", "the error");
    assert.match(plugin("legacy-formatter@awesome-copilot")!.detail ?? "", /couldn't be read/);

    await client.call("plugins.uninstall", "tracker@awesome-copilot");
    await until(() => !(parts.mcp as { id: string }[]).some((server) => server.id === serverId), "its tool server gone");
  } finally {
    client.stop();
    await link.stop();
  }
});

test("a folder plugin arrives turned off, showing what it runs", async () => {
  const setup = await paired();
  const { link, client, until, plugin } = setup;
  try {
    const added = await client.call<InstalledPlugin>("plugins.addFolder", "/Users/demo/team-skills");
    assert.equal(added.enabled, false);
    assert.equal(added.marketplace, "folder");
    assert.equal(added.folder, "/Users/demo/team-skills");
    assert.deepEqual(added.contents.hooks.map((hook) => hook.event), ["sessionStart"]);
    await until(() => plugin(added.id)?.enabled === false, "the folder plugin");
    const preview = await client.call<PluginPreview>("plugins.preview", added.id);
    assert.ok(preview.warnings?.length, "what it runs, before it is turned on");
    await client.call("plugins.setEnabled", added.id, true);
    await until(() => plugin(added.id)?.enabled === true, "turned on");
    assert.equal(await setup.refusal(client.call("plugins.addFolder", "/Users/demo/team-skills")), "That folder is already added.");
    assert.match((await setup.refusal(client.call("plugins.addFolder", "/etc"))) ?? "", /home folder/);
    // A folder plugin is a copy of the folder: update takes a fresh copy, the one that was looked at.
    const fresh = await client.call("plugins.preview", added.id);
    assert.ok(fresh.revision, "a folder plugin's preview has a revision");
    assert.match((await setup.refusal(client.call("plugins.update", added.id, { revision: "stale" }))) ?? "", /changed since you looked/);
    const updated = await client.call("plugins.update", added.id, { revision: fresh.revision });
    assert.equal(updated.id, added.id);
  } finally {
    client.stop();
    await link.stop();
  }
});

test("a marketplace is added and removed; GitHub's can't be, and installed plugins stay", async () => {
  const setup = await paired();
  const { link, client, until, plugin } = setup;
  try {
    const market = await client.call<PluginMarketplace>("plugins.addMarketplace", "acme/team-plugins#main");
    assert.deepEqual([market.id, market.builtIn, market.count], ["team-plugins", false, 3]);
    assert.equal(await setup.refusal(client.call("plugins.addMarketplace", "acme/team-plugins")), "That marketplace is already added.");
    const page = await client.call<{ plugins: PluginListing[] }>("plugins.browse", { marketplace: "team-plugins" });
    assert.equal(page.plugins.length, 3);
    await client.call("plugins.install", page.plugins[0].id, {});
    await until(() => !!plugin(page.plugins[0].id), "installed from it");
    const broken = await client.call<PluginMarketplace>("plugins.addMarketplace", "acme/broken-catalog");
    assert.match(broken.error ?? "", /couldn't be read/);
    assert.equal(await setup.refusal(client.call("plugins.removeMarketplace", "awesome-copilot")), "GitHub's catalogs can't be removed.");
    await client.call("plugins.removeMarketplace", "team-plugins");
    const left = await client.call<PluginMarketplace[]>("plugins.marketplaces");
    assert.equal(left.some((item) => item.id === "team-plugins"), false);
    assert.ok(plugin(page.plugins[0].id), "the installed plugin stays");
    assert.equal(await setup.refusal(client.call("plugins.browse", { marketplace: "team-plugins" })), "That marketplace isn't added any more.");
  } finally {
    client.stop();
    await link.stop();
  }
});
