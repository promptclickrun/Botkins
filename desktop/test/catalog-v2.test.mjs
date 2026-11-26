// Marketplace format version 2 (desktop/catalog-v2.mjs): catalog skills pinned at the catalog's
// commit, packs, and version 3 templates, against a catalog folder on this computer and a fake GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";
import { MarketV2, compareVersions, fileDiff, satisfies, v2Entries } from "../desktop/catalog-v2.mjs";
import { blobId, skillsCatalog } from "../desktop/skills-catalog.mjs";
import { parseTemplateFile } from "../desktop/templates.mjs";
import { skillSupport } from "../desktop/providers/skills.mjs";
import { remoteArgs } from "../desktop/link/methods.mjs";

const skillMd = (name, body = "Steps.") => `---\nname: ${name}\ndescription: ${name} does a thing\n---\n${body}\n`;
const deckhand = (requires) => ({
  format: "botkins.bot-template", version: 3, name: "Deckhand", role: "Presentation director", summary: "Decks.",
  instructions: "Make presentations.", look: { head: "spool", palette: "fig" }, requires,
  bundle: {
    skills: [{ name: "talk-rehearsal", description: "Rehearse a talk.", instructions: "Time each beat." }],
    routines: [
      { name: "Talk countdown check", instructions: "Check the talk.", cadence: { kind: "weekdays", time: "09:00" }, active: false },
      { name: "Daily nudge", instructions: "Nudge.", cadence: { kind: "daily", time: "08:00" }, active: true },
    ],
  },
});

/** A catalog folder in format version 2, with two skills, a pack, a plugin and a template. */
function market(dir, { version = "1.0.0", requires = { skills: ["visual-presentation@^1.0.0"] } } = {}) {
  const root = join(dir, "market");
  mkdirSync(join(root, ".github", "plugin"), { recursive: true });
  for (const name of ["visual-presentation", "speaker-notes"]) mkdirSync(join(root, "skills", name, "starter"), { recursive: true });
  writeFileSync(join(root, "skills", "visual-presentation", "SKILL.md"), skillMd("visual-presentation", "Version " + version));
  writeFileSync(join(root, "skills", "visual-presentation", "starter", "engine.js"), "export const v = " + JSON.stringify(version) + ";\n");
  writeFileSync(join(root, "skills", "visual-presentation", "starter", "smoke.sh"), "#!/bin/sh\necho ok\n");
  chmodSync(join(root, "skills", "visual-presentation", "starter", "smoke.sh"), 0o755);
  writeFileSync(join(root, "skills", "speaker-notes", "SKILL.md"), skillMd("speaker-notes"));
  mkdirSync(join(root, "plugins", "timer"), { recursive: true });
  writeFileSync(join(root, "plugins", "timer", "plugin.json"), JSON.stringify({ name: "timer", version: "1.0.0", description: "A timer" }));
  mkdirSync(join(root, "templates"), { recursive: true });
  writeFileSync(join(root, "templates", "deckhand.json"), JSON.stringify(deckhand(requires)));
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "plain.json"), JSON.stringify({ format: "botkins.bot-template", version: 1, name: "Plain", role: "Helper", instructions: "Help." }));
  writeFileSync(join(root, ".github", "plugin", "marketplace.json"), JSON.stringify({
    name: "local-v2", schemaVersion: 2,
    plugins: [{ name: "timer", source: "plugins/timer", version: "1.0.0", description: "A timer" }],
    agents: [{ name: "plain", source: "./agents/plain.json" }],
    skills: [
      { name: "visual-presentation", version, source: "./skills/visual-presentation", summary: "Decks.", category: "media", license: "MIT", requires: { tools: ["shell", "node"], optional: ["browser"] } },
      { name: "speaker-notes", version: "1.2.0", source: "./skills/speaker-notes", summary: "Notes.", category: "media", license: "Apache-2.0" },
    ],
    packs: [{ name: "presentation-studio", version: "1.0.0", summary: "Talks.", category: "media", skills: ["visual-presentation@^1.0.0", "speaker-notes@~1.2.0"], plugins: ["timer@1.0.0"] }],
    templates: [{ name: "deckhand", source: "./templates/deckhand.json", category: "media", version: "1.0.0" }],
  }));
  return root;
}

async function setup(t, options) {
  // Only the local catalog is read: the built-in marketplaces on GitHub are offline here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  t.after(() => { globalThis.fetch = realFetch; });
  const dir = tempDir(t);
  const ws = new Workspace(join(dir, "data"), fakeClient().client, () => {});
  const root = market(dir, options);
  const added = await ws.plugins.catalog.addMarketplace(root);
  const skills = skillsCatalog(() => ws.integrations);
  const v2 = new MarketV2({ ws, skills, plugins: ws.plugins, tools: () => ({ shell: true, node: false, python: false, browser: false, network: true }) });
  return { dir, ws, root, id: added.id, v2 };
}
const reread = (ws, id) => ws.plugins.catalog._ensureMarketplace(ws.plugins.catalog.marketplacesById.get(id), true);
const sessionSkills = (ws, botId) => skillSupport({ skills: ws.integrations.skillsFor(ws.bot(botId)) }).list.map((s) => s.name);

test("ranges and catalog reading follow FORMAT.md, and a version 1 catalog lists nothing new", () => {
  assert.ok(satisfies("1.4.2", "^1.0.0") && !satisfies("2.0.0", "^1.0.0") && satisfies("0.2.5", "^0.2.1") && !satisfies("0.3.0", "^0.2.1"));
  assert.ok(satisfies("1.2.9", "~1.2.0") && !satisfies("1.3.0", "~1.2.0") && satisfies("1.0.0", "1.0.0") && !satisfies("1.0.1", "1.0.0"));
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.equal(v2Entries({ plugins: [], agents: [], skills: [{ name: "x" }] }), null, "no schemaVersion: format version 1");
  const entries = v2Entries({ schemaVersion: 2, skills: [{ name: "a", version: "1.0.0", source: "./skills/a", license: "MIT", summary: "A" }, { name: "b", version: "1.0", source: "./skills/b", license: "MIT" }] });
  assert.deepEqual(entries.skills.map((s) => s.name), ["a"], "an entry that breaks the format is left out");
  assert.deepEqual(fileDiff({ a: "1", b: "2" }, { b: "3", c: "4" }), { added: ["c"], changed: ["b"], removed: ["a"] });
});

test("a version 1 catalog's plugins and agents list as before, and agents stays versions 1 and 2", async (t) => {
  const { ws, id, v2 } = await setup(t);
  assert.deepEqual((await ws.plugins.catalog.browse({ marketplace: id })).plugins.map((p) => p.name), ["timer"]);
  assert.deepEqual((await ws.plugins.catalog.agents({ marketplace: id })).agents.map((a) => a.name), ["Plain"]);
  assert.throws(() => parseTemplateFile(JSON.stringify(deckhand({ skills: ["x@1.0.0"] })), [1, 2]), /format version 3/);
  const listed = await v2.list();
  const all = { skills: listed.skills.filter((s) => s.marketplace === id), templates: listed.templates.filter((t) => t.marketplace === id) };
  assert.deepEqual(all.skills.map((s) => s.name), ["visual-presentation", "speaker-notes"]);
  assert.deepEqual(all.templates.map((t) => t.name), ["Deckhand"]);
  assert.deepEqual(all.skills[0].warnings, ["This skill needs the node command, which bots on this computer can't use now."]);
});

test("a catalog skill installs every file at its pinned blob, for chosen bots only, and a version bump is an update with a diff", async (t) => {
  const { ws, id, v2, dir } = await setup(t);
  const review = await v2.skillPreview("visual-presentation@" + id);
  assert.deepEqual(review.files.sort(), ["SKILL.md", "starter/engine.js", "starter/smoke.sh"]);
  assert.deepEqual(review.executable, ["starter/smoke.sh"]);
  assert.equal(review.source.license, "MIT");
  assert.deepEqual(await v2.skillInstall(review.token, { bots: ["pip"] }), { added: ["visual-presentation"], conflicts: [], bots: ["pip"] });
  const pip = ws.bot("pip");
  assert.deepEqual(Object.keys(pip.catalogSkills[0]).sort(), ["catalog", "commit", "files", "name", "version"]);
  assert.equal(pip.catalogSkills[0].version, "1.0.0");
  const folder = join(ws.integrations.botCatalogDirectory(pip), "visual-presentation");
  for (const file of review.files) assert.equal(blobId(readFileSync(join(folder, file))), pip.catalogSkills[0].files[file], file + " is the pinned blob");
  assert.ok(sessionSkills(ws, "pip").includes("visual-presentation"));
  assert.equal(sessionSkills(ws, "scout").includes("visual-presentation"), false, "another bot doesn't get it");
  assert.equal(ws.integrations.skills().some((s) => s.name === "visual-presentation"), false, "it stays out of the shared skills");

  // The catalog moves to 1.1.0 with a changed file.
  market(dir, { version: "1.1.0" });
  await reread(ws, id);
  const listed = (await v2.list()).skills.find((s) => s.name === "visual-presentation" && s.marketplace === id);
  assert.equal(listed.update, true);
  const next = await v2.skillPreview("visual-presentation@" + id);
  assert.deepEqual([next.update.from, next.update.to, next.update.changed], ["1.0.0", "1.1.0", ["SKILL.md", "starter/engine.js"]]);
  await v2.skillInstall(next.token, { bots: ["pip"] });
  assert.equal(ws.bot("pip").catalogSkills[0].version, "1.1.0");
  assert.match(readFileSync(join(folder, "starter/engine.js"), "utf8"), /1\.1\.0/);
});

test("a shared install records the listing, and installing it again is its update", async (t) => {
  const { ws, id, v2 } = await setup(t);
  const review = await v2.skillPreview("speaker-notes@" + id);
  assert.deepEqual((await v2.skillInstall(review.token)).added, ["speaker-notes"]);
  assert.deepEqual(ws.integrations.skillState.listings["speaker-notes"].version, "1.2.0");
  assert.equal(ws.integrations.skillState.listings["speaker-notes"].catalog, id);
  const again = await v2.skillPreview("speaker-notes@" + id);
  assert.deepEqual((await v2.skillInstall(again.token)).conflicts, [], "its own listing replaces itself");
});

test("a symbolic link or a path that leaves the folder refuses the skill", async (t) => {
  const { ws, id, v2, root } = await setup(t);
  symlinkSync("/etc/hostname", join(root, "skills", "speaker-notes", "link"));
  await assert.rejects(v2.skillPreview("speaker-notes@" + id), /symbolic link/);
  // A GitHub tree with a link, or a path that climbs out.
  const tree = (entries) => async (url) => (url.includes("/trees/") ? Response.json({ tree: entries }) : new Response("x"));
  const item = { id: "x@m", name: "x", version: "1.0.0", catalog: "m", catalogName: "m", commit: "a".repeat(40), path: "skills/x", license: "MIT", source: { type: "github", repo: "o/r" } };
  const sha = "b".repeat(40);
  const md = { path: "skills/x/SKILL.md", mode: "100644", type: "blob", size: 10, sha };
  await assert.rejects(skillsCatalog(() => ws.integrations, tree([md, { path: "skills/x/l", mode: "120000", type: "blob", size: 1, sha }])).listingPreview(item), /symbolic link/);
  await assert.rejects(skillsCatalog(() => ws.integrations, tree([md, { path: "skills/x/../../evil", mode: "100644", type: "blob", size: 1, sha }])).listingPreview(item), /Unsafe skill file path/);
});

test("installing a pack installs every skill and plugin for the chosen bot", async (t) => {
  const { ws, id, v2 } = await setup(t);
  const review = await v2.packPreview("presentation-studio@" + id);
  assert.deepEqual(review.skills.map((s) => s.name), ["visual-presentation", "speaker-notes"]);
  assert.deepEqual(review.plugins.map((p) => p.name), ["timer"]);
  const result = await v2.packInstall(review.token, { bots: ["scout"], commit: review.commit });
  assert.deepEqual(result.added, ["visual-presentation", "speaker-notes"]);
  assert.deepEqual(result.plugins, ["timer@" + id]);
  assert.deepEqual(ws.bot("scout").catalogSkills.map((s) => s.name), ["visual-presentation", "speaker-notes"]);
  assert.deepEqual(ws.plugins.records.find((r) => r.preview.id === "timer@" + id).bots, ["scout"]);
});

test("a version 3 template with a missing skill or an unmet range is refused with a clear error", async (t) => {
  const missing = await setup(t, { requires: { skills: ["no-such-skill@^1.0.0"] } });
  await assert.rejects(missing.v2.templatePreview("deckhand@" + missing.id), /needs the skill no-such-skill \(\^1\.0\.0\), which isn't in /);
  const unmet = await setup(t, { requires: { skills: ["visual-presentation@^2.0.0"] } });
  await assert.rejects(unmet.v2.templatePreview("deckhand@" + unmet.id), /needs the skill visual-presentation \^2\.0\.0, but .* has 1\.0\.0/);
});

test("a version 3 template makes its bot with its catalog skills, private skills and routines paused unless active and left on", async (t) => {
  const { ws, id, v2 } = await setup(t, { requires: { skills: ["visual-presentation@^1.0.0"], packs: ["presentation-studio@^1.0.0"] } });
  const review = await v2.templatePreview("deckhand@" + id);
  assert.equal(review.instructions, "Make presentations.");
  assert.deepEqual(review.skills.map((s) => s.name), ["visual-presentation", "speaker-notes"]);
  assert.deepEqual(review.privateSkills.map((s) => s.name), ["talk-rehearsal"]);
  assert.deepEqual(review.routines.map((r) => [r.name, r.active]), [["Talk countdown check", false], ["Daily nudge", true]]);
  const made = await v2.templateInstall(review.token, { commit: review.commit });
  const bot = ws.bot(made.botId);
  assert.deepEqual(bot.catalogSkills.map((s) => s.name), ["visual-presentation", "speaker-notes"]);
  assert.ok(sessionSkills(ws, made.botId).includes("talk-rehearsal"));
  assert.equal(sessionSkills(ws, "pip").includes("visual-presentation"), false);
  const routines = Object.fromEntries(ws.panels.routines.list(made.botId).map(({ entry }) => [entry.name, entry.enabled]));
  assert.deepEqual(routines, { "Talk countdown check": false, "Daily nudge": true });
  assert.equal(bot.bundle.routines.some((r) => "active" in r), false, "the bot keeps no active flag");

  // The person turned the active routine off in the review: it is not made.
  const second = await v2.templatePreview("deckhand@" + id);
  const other = await v2.templateInstall(second.token, { routines: ["Talk countdown check"] });
  assert.deepEqual(ws.panels.routines.list(other.botId).map(({ entry }) => [entry.name, entry.enabled]), [["Talk countdown check", false]]);
  // A review from another commit is refused.
  const third = await v2.templatePreview("deckhand@" + id);
  await assert.rejects(v2.templateInstall(third.token, { commit: "f".repeat(40) }), /catalog changed/);
});

test("`botkins marketplace install` refuses with no terminal unless given --yes --revision <commit>", async (t) => {
  const { id, v2 } = await setup(t);
  const handlers = { "market.catalog": () => v2.list(), "market.skillPreview": (x) => v2.skillPreview(x), "market.skillInstall": (tok, o) => v2.skillInstall(tok, o) };
  const calls = [];
  const client = { call: async (name, ...args) => (calls.push(name), handlers[name](...args)) };
  let err = "";
  const io = { stdout: { write: () => {} }, stderr: { write: (text) => void (err += text) }, env: {}, stdin: { isTTY: false }, client };
  const { main } = await import("../cli/main.mjs");
  const skill = "speaker-notes@" + id;
  assert.equal(await main(["marketplace", "install", skill], io), 2);
  assert.match(err, /needs a person's yes/);
  assert.equal(await main(["marketplace", "install", skill, "--yes"], io), 2);
  assert.match(err, /--yes needs --revision/);
  assert.equal(calls.includes("market.skillInstall"), false, "nothing was installed");
  const { commit } = (await v2.skillPreview(skill)).listing;
  assert.equal(await main(["marketplace", "install", skill, "--yes", "--revision", "0".repeat(40)], io), 1, "another commit is refused");
  assert.equal(await main(["marketplace", "install", skill, "--yes", "--revision", commit], io), 0);
  assert.ok(calls.includes("market.skillInstall"));
});

test("a phone's install arguments are cut to their shape", () => {
  assert.deepEqual(remoteArgs("market.templateInstall", ["tok", { routines: ["a"], commit: "a".repeat(40), extra: 1 }]), ["tok", { routines: ["a"], commit: "a".repeat(40) }]);
  assert.throws(() => remoteArgs("market.skillInstall", ["tok", { commit: "nope" }]), /Review it again/);
  assert.deepEqual(remoteArgs("market.catalog", [1, 2]), []);
  assert.ok(existsSync);
});
