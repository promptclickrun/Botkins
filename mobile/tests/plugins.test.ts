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
import { botsLine, byLine, readPages, refreshFailure, configValues, consent, fieldState, groupHooks, hookFacts, hookWords, hostOf, isMarketplaceSource, matchInstalled, missingFields, needsReview, noticeKey, notRunRows, otherFilesRows, pluginChips, reviewNotice, runLine, runsOnComputer, safeLink, sentToLines, showsAll, shownWord, skillsNotices, statusLine, timeLimit, toolFacts, toolLine } from "../src/features/market/plugins/logic";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { InstalledPlugin, PluginContents, PluginField, PluginListing, PluginMarketplace, PluginPreview } from "../src/link/types";
import { addedSkillsNote } from "../src/state/fileText";

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
  assert.deepEqual(groups.map((group) => [group.label, group.hooks.map((hook) => hook.command)]), [["When a chat starts", ["brief"]], ["When a reply ends", ["retain", "tidy"]], ["File changed", ["watch"]]]);
});

test("the alert asks from a description with the computer's mark, and always from one without it", () => {
  assert.equal(toolLine({ name: "db", kind: "local", command: "npx", args: ["-y", "db-mcp"] }), "Runs on your computer");
  assert.equal(toolLine({ name: "mem", kind: "remote", url: "https://user@Memory.Example.com:8443/mcp/x/" }), "Remote · memory.example.com");
  assert.equal(hostOf("not a url"), "");
  const whole = (contents: PluginContents) => ({ contents, starts: 1 as const });
  // With the mark: nothing to ask when nothing runs on the computer.
  assert.equal(consent(whole({ ...empty, skills: ["a"], mcpServers: [{ name: "r", kind: "remote", url: "https://x.example" }] })), null);
  assert.equal(runsOnComputer({ ...empty, mcpServers: [{ name: "db", kind: "local" }] }), true);
  const ask = consent(whole({ ...empty, hooks: [{ event: "userPromptSubmitted", command: "a" }, { event: "agentStop", command: "b" }], mcpServers: [{ name: "db", kind: "local" }] }));
  assert.equal(ask?.title, "This plugin runs commands on your computer");
  assert.equal(ask?.message, "It runs 2 commands (each message you send and when a reply ends) and 1 tool (db), with your access. Install it only if you trust where it comes from.");
  assert.equal(consent(whole({ ...empty, hooks: [{ event: "sessionStart", command: "a" }] }), "turn on")?.action, "Turn on");
  assert.equal(consent(whole({ ...empty, hooks: [{ event: "sessionStart", command: "a" }] }), "turn on")?.message, "It runs 1 command (when a chat starts), with your access. Turn it on only if you trust where it comes from.");
  // Without the mark the description may not show everything: ask first, also for a plugin that shows nothing to run.
  assert.ok(showsAll({ starts: 1 }) && !showsAll({}) && !showsAll({ starts: true }) && !showsAll(undefined));
  const harmless = { contents: { ...empty, skills: ["a"] } };
  const older = consent(harmless, "install", true);
  assert.equal(older?.title, "This plugin may run commands on your computer");
  assert.equal(older?.message, "The app on your computer is older and may not show everything a plugin runs. Update it first, or go on only if you trust where the plugin comes from.");
  assert.deepEqual([consent(harmless, "install", true)?.action, consent(harmless, "update", true)?.action, consent(harmless, "turn on", true)?.action], ["Install anyway", "Update anyway", "Turn on anyway"]);
  // The same on a computer that names the capability (a copy that could not be read): no word about an older app.
  assert.equal(consent(harmless, "turn on")?.message, "Your computer could not show everything this plugin runs. Go on only if you trust where the plugin comes from.");
});

test("everything a tool and a hook start is shown whole, each word apart, as text", () => {
  // A local tool: the whole line with each word of its arguments, its folder, each name with its value, and what is not set.
  const local = toolFacts({
    name: "db",
    kind: "local",
    command: "npx",
    args: ["-y", "@scope/pkg", "--name", "two words", "", 'say "hi"'],
    cwd: "server/bin",
    env: [{ name: "GIT_SSH_COMMAND", value: "ssh -i ${KEY_FILE}" }, { name: "EMPTY", value: "" }],
    envNotSet: [{ name: "NODE_OPTIONS", why: "Botkins sets no name that makes a program load more." }],
  });
  assert.deepEqual(local, [
    { label: "Runs", text: 'npx -y @scope/pkg --name "two words" "" "say \\"hi\\""' },
    { label: "In folder", text: "server/bin" },
    { label: "Environment", lines: ["GIT_SSH_COMMAND = ssh -i ${KEY_FILE}", 'EMPTY = ""'] },
    { label: "Not set by Botkins", notes: [{ name: "NODE_OPTIONS", why: "Botkins sets no name that makes a program load more." }] },
  ]);
  // Not "npx": a person sees what it starts.
  assert.equal(runLine({ command: "npx", args: ["-y", "@scope/pkg"] }), "npx -y @scope/pkg");
  // A computer from before the arguments sends the command alone, as written.
  assert.equal(runLine({ command: "npx -y db-mcp" }), "npx -y db-mcp");
  assert.deepEqual(toolFacts({ name: "old", kind: "local", command: "npx -y db-mcp" }), [{ label: "Runs", text: "npx -y db-mcp" }]);
  // A word that would hide something shows what it holds, and can't join the next word.
  assert.equal(shownWord("a\u202eb"), "a\\u{202e}b");
  assert.equal(shownWord("one\ntwo"), '"one\\u{a}two"');
  assert.equal(runLine({ command: "sh", args: ["-c", "echo ok\u200b; rm -rf ~"] }), 'sh -c "echo ok\\u{200b}; rm -rf ~"');

  // A remote tool: the address (a stream when it is one), each header with its written value, and the sign-in.
  assert.deepEqual(toolFacts({ name: "mem", kind: "remote", type: "sse", url: "https://memory.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer ${MEMORY_API_KEY}" }], oauth: true, oauthClientId: "client-7" }), [
    { label: "Connects to", text: "https://memory.example.com/mcp (stream)" },
    { label: "Sends headers", lines: ["Authorization = Bearer ${MEMORY_API_KEY}"] },
    { label: "Signs in on your computer" },
    { label: "Client id", text: "client-7" },
  ]);
  assert.deepEqual(toolFacts({ name: "plain", kind: "remote", type: "http", url: "https://x.example/mcp" }), [{ label: "Connects to", text: "https://x.example/mcp" }]);

  // A hook: the whole command with its lines kept, the time limit, the environment.
  const long = "node run.mjs " + "x".repeat(3900);
  assert.deepEqual(hookFacts({ event: "sessionStart", command: "set -e\nnode brief.mjs\t--fast", timeoutSec: 10, env: [{ name: "BANK", value: "${MEMORY_BANK_ID}" }] }), [
    { label: "Runs", text: "set -e\nnode brief.mjs\\u{9}--fast" },
    { label: "Time limit", text: "10 seconds" },
    { label: "Environment", lines: ["BANK = ${MEMORY_BANK_ID}"] },
  ]);
  assert.equal(hookFacts({ event: "agentStop", command: long })[0].text, long, "never cut");
  assert.deepEqual([timeLimit(1), timeLimit(0.25), timeLimit(30), timeLimit(undefined), timeLimit(0)], ["1 second", "0.25 seconds", "30 seconds", undefined, undefined]);
});

test("where a setting goes, what is not run, and the other files", () => {
  assert.deepEqual(
    sentToLines({ sentTo: [{ tool: "keepsake", env: "MEMORY_API_KEY" }, { tool: "keepsake", header: "Authorization", url: "https://memory.example.com/mcp" }, { hook: "userPromptSubmitted", env: "BANK" }] }),
    ["Sent to the tool keepsake as MEMORY_API_KEY", "Sent to the tool keepsake at https://memory.example.com/mcp in the header Authorization", "Sent to the hook (each message you send) as BANK"],
  );
  assert.deepEqual(sentToLines({}), []);
  // What the computer does not run, with its reasons, and how many more.
  assert.deepEqual(notRunRows({ notRun: { count: 14, items: [{ what: "hook", name: "preCompact", why: "Botkins does not know this event." }, { what: "tool", name: "db", why: "A secret's value is in its line." }] } }), {
    rows: [{ name: "preCompact", why: "Botkins does not know this event." }, { name: "db", why: "A secret's value is in its line." }],
    more: 12,
  });
  assert.deepEqual(notRunRows({}), { rows: [], more: 0 });
  // The other files: how many and how large, and the ones that tools read by themselves.
  assert.deepEqual(
    otherFilesRows({ otherFiles: { count: 214, bytes: 3.2 * 1024 * 1024, files: [{ path: "package.json", bytes: 2048, config: true }, { path: "node_modules/", bytes: 3_000_000, files: 180, config: true }, { path: "README.md", bytes: 900 }] } }),
    { line: "214 files · 3.2 MB", config: ["package.json · 2 KB", "node_modules/ · 180 files"] },
  );
  assert.equal(otherFilesRows({}), undefined);
  assert.equal(otherFilesRows({ otherFiles: { count: 0, bytes: 0, files: [] } }), undefined);
});

test("a plugin the computer switched off reads \"Needs review\", and each notice is shown one time", () => {
  const plugin = (more: Partial<InstalledPlugin>): InstalledPlugin => ({ id: "p", name: "keepsake", marketplace: "m", installed: true, enabled: true, bots: "all", contents: { ...empty, skills: ["memory"] }, config: [], status: "ready", installedAt: 1, ...more });
  const held = "Botkins switched this plugin off. An earlier version did not show all that it starts.";
  assert.equal(statusLine(plugin({ enabled: false, detail: held })), "Off · Needs review");
  assert.equal(statusLine(plugin({ enabled: false, detail: held, status: "needs-config" })), "Off · Needs review");
  assert.equal(statusLine(plugin({ enabled: false })), "Off", "a plugin a person switched off");
  // An error keeps the computer's sentence in a list; on the plugin's page the sentence is shown whole under the name.
  assert.equal(statusLine(plugin({ enabled: false, status: "error", detail: "The installed files of this plugin are not the files that were reviewed." })), "The installed files of this plugin are not the files that were reviewed.");
  assert.equal(statusLine(plugin({ status: "error", detail: "x" }), { page: true }), "Something is wrong with this plugin.");
  assert.ok(needsReview(plugin({ enabled: false, detail: held })) && !needsReview(plugin({ enabled: false })) && !needsReview(plugin({ detail: "Sign in." })));
  // An entry in error that no update repairs (a linked folder that could not be copied) has nothing to review: it is not counted, and can only be removed.
  const stuck = plugin({ id: "linked-1", enabled: false, status: "error", detail: "The folder could not be read." });
  assert.equal(needsReview(stuck), false);
  assert.equal(reviewNotice([stuck], "mac-1", []), undefined);
  assert.deepEqual(skillsNotices([stuck], "mac-1", []), []);
  // One an update repairs is looked at: Update first, then "Turn on".
  assert.ok(needsReview(plugin({ enabled: false, status: "error", repair: "update", detail: "Its installed files could not be read." })));

  const list = [plugin({ id: "a", enabled: false, detail: held }), plugin({ id: "b", name: "team-skills", enabled: false, detail: held }), plugin({ id: "c", enabled: false, detail: held, contents: empty }), plugin({ id: "d" })];
  const notice = reviewNotice(list, "mac-1", []);
  assert.equal(notice?.title, "Botkins switched off 3 plugins");
  assert.equal(notice?.text, "Botkins now shows everything a plugin runs on your computer. Review each one, then turn it on.");
  // Once told, not again; a plugin switched off later is told about by itself, and another computer is another matter.
  assert.equal(reviewNotice(list, "mac-1", notice!.keys), undefined);
  assert.equal(reviewNotice(list, "mac-1", notice!.keys.slice(0, 2))?.title, "Botkins switched off 1 plugin");
  assert.equal(reviewNotice(list, "mac-2", notice!.keys)?.title, "Botkins switched off 3 plugins");
  assert.equal(reviewNotice([plugin({})], "mac-1", []), undefined);
  // In Skills: one for each such plugin that has skills.
  const skills = skillsNotices(list, "mac-1", []);
  assert.deepEqual(skills.map((one) => [one.id, one.title]), [["a", "Skills from keepsake are off"], ["b", "Skills from team-skills are off"]]);
  assert.equal(skills[0].text, "They are part of a plugin that is switched off. Review it, then turn it on.");
  assert.deepEqual(skillsNotices(list, "mac-1", [skills[0].key]).map((one) => one.id), ["b"]);
  assert.notEqual(noticeKey("mac-1", "a", "plugins"), noticeKey("mac-1", "a", "skills"));
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

test("a refresh says only what newly failed, and reads as many pages as were on screen", async () => {
  const market = (id: string, name: string, error?: string): PluginMarketplace => ({ id, name, source: id, builtIn: true, ...(error && { error }) });
  const before = [market("gh", "GitHub"), market("cp", "Copilot plugins", "Not found")];
  assert.equal(refreshFailure(before, [market("gh", "GitHub"), market("cp", "Copilot plugins", "Not found")]), undefined, "an old error is shown by its marketplace already");
  assert.equal(refreshFailure(before, [market("gh", "GitHub", "HTTP 500"), market("cp", "Copilot plugins", "Not found")]), "Couldn't refresh GitHub");
  assert.equal(refreshFailure(undefined, [market("gh", "GitHub", "x"), market("me", "Mine", "y")]), "Couldn't refresh 2 marketplaces");
  assert.equal(refreshFailure(before, [market("gh", "GitHub")]), undefined, "a marketplace that reads again says nothing");

  const all = ["a", "b", "c", "d", "e"].map((name) => ({ id: name + "@gh", name, marketplace: "gh" }) as PluginListing);
  const asked: (string | undefined)[] = [];
  const read = async (cursor?: string) => {
    asked.push(cursor);
    const from = Number(cursor ?? 0);
    return { plugins: all.slice(from, from + 2), ...(from + 2 < all.length && { cursor: String(from + 2) }) };
  };
  const three = await readPages(read, 3);
  assert.deepEqual([three.plugins.map((item) => item.name), three.cursor, asked], [["a", "b", "c", "d"], "4", [undefined, "2"]], "pages until the screen's count, keeping the cursor");
  asked.length = 0;
  assert.deepEqual((await readPages(read, 0)).plugins.length, 2, "one page when nothing was on screen");
  const twice = await readPages(async () => ({ plugins: [all[0], all[0]], cursor: "x" }), 5);
  assert.deepEqual(twice.plugins.map((item) => item.name), ["a"], "each plugin once, and it stops after 20 pages");
});

// ── What the link lets through ──────────────────────────────────────────────────────────────────

test("a phone may make the thirteen plugin calls, each cut to its shape", () => {
  assert.equal(PLUGIN_METHODS.length, 13);
  assert.deepEqual(remoteArgs("plugins.refresh", ["x", { all: true }]), [], "a refresh takes nothing");
  assert.deepEqual(remoteArgs("composio.catalog", [{ fresh: true, url: "https://elsewhere" }]), [{ fresh: true }], "the app list may be asked for fresh, and nothing else");
  assert.deepEqual(remoteArgs("composio.catalog", [{ fresh: "yes" }]), []);
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
  // A switch-on and a choice of bots may name the revision that was looked at (64 hex characters), and nothing else.
  const looked = "ab".repeat(32);
  assert.deepEqual(remoteArgs("plugins.setEnabled", ["a", true, { revision: looked }]), ["a", true, { revision: looked }]);
  assert.deepEqual(remoteArgs("plugins.setBots", ["a", ["b1"], { revision: looked }]), ["a", ["b1"], { revision: looked }]);
  assert.deepEqual(remoteArgs("plugins.setEnabled", ["a", true, {}]), ["a", true]);
  assert.deepEqual(remoteArgs("plugins.setEnabled", ["a", true, null]), ["a", true]);
  for (const third of [{ revision: "r1" }, { revision: looked.toUpperCase() }, { revision: looked, force: true }, { force: true }, "x", [looked], { revision: 7 }]) {
    assert.equal(said(() => remoteArgs("plugins.setEnabled", ["a", true, third])), "Check the plugin request.", JSON.stringify(third));
    assert.equal(said(() => remoteArgs("plugins.setBots", ["a", "all", third])), "Check the plugin request.", JSON.stringify(third));
  }
  assert.equal(said(() => remoteArgs("plugins.setEnabled", ["a", true, { revision: { $credential: "c1" } }])), "A credential can't be used there.");
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
/** Looks at a plugin, then installs what was looked at: an install names its revision. */
const install = async (client: LinkClient, id: string, more: Record<string, unknown> = {}) => {
  const preview = await client.call<PluginPreview>("plugins.preview", id);
  return client.call<InstalledPlugin>("plugins.install", id, { ...more, revision: preview.revision });
};
/** Runs with the demo computer in one of its plugin modes (BOTKINS_DEV_PLUGINS). */
const inMode = async (mode: string, work: () => Promise<void>) => {
  process.env.BOTKINS_DEV_PLUGINS = mode;
  try {
    await work();
  } finally {
    delete process.env.BOTKINS_DEV_PLUGINS;
  }
};

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
    assert.ok(preview.warnings?.includes("Runs a command on your computer through plugin hooks."));
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
    await install(client, "tracker@awesome-copilot");
    await until(() => plugin("tracker@awesome-copilot")?.status === "needs-sign-in", "needs a sign-in");
    const serverId = plugin("tracker@awesome-copilot")!.contents.mcpServers[0].serverId!;
    assert.ok((parts.mcp as { id: string }[]).some((server) => server.id === serverId), "a tool server to sign in");
    await client.call("signInMcpServer", serverId);
    await until(() => plugin("tracker@awesome-copilot")?.status === "ready", "signed in");

    await install(client, "sqlite-explorer@awesome-copilot");
    await until(() => !!plugin("sqlite-explorer@awesome-copilot"), "sqlite");
    const sqlite = plugin("sqlite-explorer@awesome-copilot")!;
    assert.equal(sqlite.status, "ready");
    assert.equal(sqlite.contents.mcpServers[0].kind, "local");
    assert.equal(sqlite.config[0].value, "~/Documents/data.db");

    await install(client, "legacy-formatter@awesome-copilot");
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
    await install(client, page.plugins[0].id);
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

test("a refresh reads the catalogs again, and a new plugin is listed (market-refresh-v1)", async () => {
  const setup = await paired();
  const { link, client } = setup;
  try {
    assert.ok(setup.backend.capabilities.includes("market-refresh-v1"));
    const names = async () => (await client.call<{ plugins: PluginListing[] }>("plugins.browse", { marketplace: "awesome-copilot" })).plugins.map((item) => item.name);
    assert.equal((await names()).includes("daily-digest"), false);
    const markets = await client.call<PluginMarketplace[]>("plugins.refresh");
    assert.ok(markets.some((item) => item.id === "awesome-copilot"), "the marketplaces come back");
    assert.ok((await names()).includes("daily-digest"), "the new plugin is in the list");
    await client.call("plugins.refresh");
    assert.equal((await names()).filter((name) => name === "daily-digest").length, 1, "once");
  } finally {
    client.stop();
    await link.stop();
  }
  await inMode("old", async () => assert.equal(new MockBackend({ speed: 0.05 }).capabilities.includes("market-refresh-v1"), false, "an older computer doesn't name it"));
});

// ── What a plugin starts, shown whole ("plugin-starts-v1") ──────────────────────────────────────

test("a description says everything a plugin starts, and carries the computer's mark", async () => {
  const setup = await paired();
  const { link, client, backend } = setup;
  try {
    assert.ok(backend.capabilities.includes("plugin-starts-v1"));
    const sqlite = await client.call<PluginPreview>("plugins.preview", "sqlite-explorer@awesome-copilot");
    assert.equal(sqlite.starts, 1);
    const tool = sqlite.contents.mcpServers[0];
    assert.deepEqual([tool.kind, tool.command, tool.args, tool.cwd], ["local", "npx", ["-y", "@example/sqlite-mcp", "--read-only", "--label", "My databases"], "server"]);
    assert.deepEqual(tool.env, [{ name: "DATABASE_PATH", value: "${DATABASE_PATH}" }, { name: "SQLITE_TIMEOUT", value: "5000" }]);
    assert.equal(tool.envNotSet?.[0].name, "NODE_OPTIONS");
    assert.ok(tool.envNotSet?.[0].why);
    // The phone shows all of it: the whole line, the folder, each name with its value, what is not set.
    assert.deepEqual(toolFacts(tool).map((fact) => fact.label), ["Runs", "In folder", "Environment", "Not set by Botkins"]);
    assert.equal(toolFacts(tool)[0].text, 'npx -y @example/sqlite-mcp --read-only --label "My databases"');
    assert.deepEqual(sqlite.config[0].sentTo, [{ tool: "sqlite", env: "DATABASE_PATH" }]);
    assert.deepEqual(otherFilesRows(sqlite.contents), { line: "214 files · 3.2 MB", config: ["package.json · 1.8 KB", ".npmrc · 62 bytes", "node_modules/ · 180 files"] });
    assert.ok(sqlite.warnings?.includes("Botkins does not set some environment names that this plugin asks for. Its tools or hooks may not work."));

    // A remote tool's headers come with their written values; a secret is only ever a setting's name.
    const memory = await client.call<PluginPreview>("plugins.preview", MEMORY);
    assert.deepEqual(memory.contents.mcpServers[0].headers, [{ name: "Authorization", value: "Bearer ${MEMORY_API_KEY}" }, { name: "X-Memory-Bank", value: "${MEMORY_BANK_ID}" }]);
    assert.deepEqual(sentToLines(memory.config[0]), [
      "Sent to the tool keepsake at https://memory.example.com/mcp in the header Authorization",
      "Sent to the hook (when a chat starts) as MEMORY_API_KEY",
      "Sent to the hook (each message you send) as MEMORY_API_KEY",
      "Sent to the hook (when a reply ends) as MEMORY_API_KEY",
    ]);
    assert.deepEqual(memory.contents.hooks.map((hook) => hook.timeoutSec), [10, 5, 30]);
    const tracker = await client.call<PluginPreview>("plugins.preview", "tracker@awesome-copilot");
    assert.deepEqual(toolFacts(tracker.contents.mcpServers[0]), [{ label: "Connects to", text: "https://mcp.tracker.example.com/mcp (stream)" }, { label: "Signs in on your computer" }, { label: "Client id", text: "botkins-demo" }]);

    // What is not run is said, with the reason.
    const notify = await client.call<PluginPreview>("plugins.preview", "notify-me@awesome-copilot");
    assert.deepEqual(notRunRows(notify.contents), { rows: [{ name: "notification", why: "Botkins does not know the event notification, so this hook does not run." }], more: 0 });
    assert.ok(notify.warnings?.includes("Botkins does not run some hooks or tools of this plugin."));

    // An install names the revision that was looked at: none is refused, and nothing is installed.
    assert.equal(await setup.refusal(client.call("plugins.install", MEMORY, {})), "Look at the plugin first. An install or an update names the revision that was looked at.");
    assert.equal(await setup.refusal(client.call("plugins.update", "writing-skills@awesome-copilot", {})), "Look at the plugin first. An install or an update names the revision that was looked at.");
    assert.equal(setup.plugin(MEMORY), undefined);
  } finally {
    client.stop();
    await link.stop();
  }
});

test("a switch-on and a choice of bots name the revision the person looked at", async () => {
  const setup = await paired();
  const { link, client, until, plugin, parts } = setup;
  const id = "git-guard@awesome-copilot";
  try {
    await install(client, id);
    await until(() => !!plugin(id), "installed");
    const looked = plugin(id)!.revision!;
    assert.match(looked, /^[a-f0-9]{64}$/);
    assert.equal(plugin(id)!.starts, 1);
    await client.call("plugins.setEnabled", id, false, { revision: looked });
    await until(() => plugin(id)?.enabled === false, "off");
    // Another revision than the installed one is refused; the plugin stays as it was.
    const other = "0".repeat(64);
    assert.equal(await setup.refusal(client.call("plugins.setEnabled", id, true, { revision: other })), "This plugin is not the one that was looked at: its revision is another one now. Look at it again.");
    assert.equal(await setup.refusal(client.call("plugins.setBots", id, "all", { revision: other })), "This plugin is not the one that was looked at: its revision is another one now. Look at it again.");
    assert.equal(plugin(id)!.enabled, false);
    // Anything but a revision in that place does not pass the link.
    assert.equal(await setup.refusal(client.call("plugins.setEnabled", id, true, { revision: looked, force: true })), "Check the plugin request.");
    await client.call("plugins.setEnabled", id, true, { revision: looked });
    await until(() => plugin(id)?.enabled === true, "on");
    const bot = (parts.bots as { id: string }[])[0].id;
    await client.call("plugins.setBots", id, [bot], { revision: looked });
    await until(() => Array.isArray(plugin(id)?.bots), "its bots");
    // A phone from before sends none, and the demo takes it, as the app does today.
    await client.call("plugins.setBots", id, "all");
    await until(() => plugin(id)?.bots === "all", "all bots");
  } finally {
    client.stop();
    await link.stop();
  }
});

test("plugins the computer switched off: a linked folder, one not shown whole before, and a copy that needs an update", async () => {
  await inMode("held", async () => {
    const setup = await paired();
    const { link, client, until, plugin, plugins, parts } = setup;
    try {
      await until(() => plugins().length === 4, "the installed plugins");
      // The folder that was linked for its skills is a plugin now, off, with the computer's sentence and its path.
      const linked = plugin("code-review@folder")!;
      assert.deepEqual([linked.enabled, linked.folder, linked.status], [false, "/Users/demo/.plugins/code-review", "ready"]);
      assert.match(linked.detail ?? "", /^This plugin folder was linked for its skills\./);
      assert.equal((parts.skills as { plugins: { path: string }[] }).plugins.some((item) => item.path === linked.folder), false, "no longer a linked folder");
      // One an earlier version did not show whole.
      const guard = plugin("git-guard@awesome-copilot")!;
      assert.equal(guard.enabled, false);
      assert.match(guard.detail ?? "", /^Botkins switched this plugin off\./);
      // The phone's words for the moment, one time.
      assert.deepEqual([statusLine(linked), statusLine(guard)], ["Off · Needs review", "Off · Needs review"]);
      const notice = reviewNotice(plugins(), "mac", [])!;
      assert.equal(notice.title, "Botkins switched off 2 plugins");
      assert.deepEqual(skillsNotices(plugins(), "mac", []).map((one) => one.title), ["Skills from code-review are off"]);

      // The person looks and turns it on: the reason is gone, and it reads as any plugin that is on.
      await client.call("plugins.setEnabled", guard.id, true, { revision: guard.revision });
      await until(() => plugin(guard.id)?.enabled === true, "turned on");
      assert.equal(plugin(guard.id)!.detail, undefined);
      assert.equal(reviewNotice(plugins(), "mac", [])?.title, "Botkins switched off 1 plugin");

      // A copy that is not the reviewed files: an error with the mark "an update is the repair", and no mark of a whole description.
      const runner = plugin("test-runner@awesome-copilot")!;
      assert.deepEqual([runner.status, runner.repair, runner.starts], ["error", "update", undefined]);
      assert.match(runner.detail ?? "", /^The installed files of this plugin are not the files that were reviewed\. Update the plugin/);
      assert.equal(consent(runner, "turn on")?.title, "This plugin may run commands on your computer");
      assert.match((await setup.refusal(client.call("plugins.setEnabled", runner.id, true, { revision: runner.revision }))) ?? "", /are not the files that were reviewed/);
      // The update writes the files again: the mark for a repair is gone, and the description is whole again.
      const fresh = await client.call<PluginPreview>("plugins.preview", runner.id);
      await client.call("plugins.update", runner.id, { revision: fresh.revision });
      await until(() => plugin(runner.id)?.status === "ready", "repaired");
      assert.deepEqual([plugin(runner.id)!.repair, plugin(runner.id)!.starts, plugin(runner.id)!.detail], [undefined, 1, undefined]);
    } finally {
      client.stop();
      await link.stop();
    }
  });
});

test("a computer from before plugin-starts-v1: no mark, so the phone asks first for every plugin", async () => {
  await inMode("old", async () => {
    const setup = await paired();
    const { link, client, until, plugin, backend } = setup;
    try {
      assert.ok(backend.capabilities.includes("plugins-v1") && !backend.capabilities.includes("plugin-starts-v1"));
      const sqlite = await client.call<PluginPreview>("plugins.preview", "sqlite-explorer@awesome-copilot");
      assert.equal(sqlite.starts, undefined);
      // The old shape: a tool by one line, no arguments apart, no environment.
      assert.deepEqual(sqlite.contents.mcpServers[0], { name: "sqlite", kind: "local", command: 'npx -y @example/sqlite-mcp --read-only --label My databases' });
      assert.deepEqual(toolFacts(sqlite.contents.mcpServers[0]), [{ label: "Runs", text: "npx -y @example/sqlite-mcp --read-only --label My databases" }]);
      // A plugin that shows nothing to run is asked about too: the description may not be whole.
      const skills = await client.call<PluginPreview>("plugins.preview", "code-review@awesome-copilot");
      assert.equal(runsOnComputer(skills.contents), false);
      assert.equal(consent(skills, "install", true)?.action, "Install anyway");
      // Such a computer takes an install with no revision, and its installed plugins name none.
      await client.call("plugins.install", "code-review@awesome-copilot", {});
      await until(() => !!plugin("code-review@awesome-copilot"), "installed");
      assert.deepEqual([plugin("code-review@awesome-copilot")!.revision, plugin("code-review@awesome-copilot")!.starts], [undefined, undefined]);
    } finally {
      client.stop();
      await link.stop();
    }
  });
});

test("a plugin folder picked under Skills is installed as a plugin, switched off, and never linked", async () => {
  const setup = await paired();
  const { link, client, until, plugin, parts } = setup;
  try {
    const added = await client.call<{ kind: string; name: string; id?: string; enabled?: boolean }>("addSkillFolderAt", "/Users/demo/Code/review-kit");
    assert.deepEqual(added, { kind: "plugin", name: "review-kit", id: "review-kit@folder", enabled: false });
    await until(() => plugin("review-kit@folder")?.enabled === false, "the plugin, off");
    assert.deepEqual(plugin("review-kit@folder")!.contents.hooks.map((hook) => [hook.event, hook.command, hook.timeoutSec]), [["preToolUse", "sh ${PLUGIN_ROOT}/check.sh", 5]]);
    assert.equal((parts.skills as { folders: { path: string }[] }).folders.some((folder) => folder.path === "/Users/demo/Code/review-kit"), false);
    assert.equal(addedSkillsNote({ kind: "plugin", name: "review-kit", id: "review-kit@folder", enabled: false }), "Added the plugin review-kit. It is off until you turn it on.");
    assert.equal(addedSkillsNote({ kind: "plugin", name: "old-kit" }), "Added the plugin old-kit.");
  } finally {
    client.stop();
    await link.stop();
  }
});
