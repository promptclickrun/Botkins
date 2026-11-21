import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { LEGACY_NAME } from "../desktop/home.mjs";
import { FORMAT, FORMATS, Templates, parseTemplateFile } from "../desktop/templates.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-templates-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(join(dir, "data"), async () => ({}), () => {});
  return { dir, ws, templates: new Templates(ws) };
}

test("a bot's setup saves as a template without its local sources", (t) => {
  const { ws, templates } = setup(t);
  const bot = ws.state.bots[1];
  bot.summary = "Finds sources";
  bot.sources = [{ id: "s", kind: "mcp", path: "/Users/me/secret/mcp.json" }];
  const id = templates.saveFromBot(bot.id, "  My researcher ");
  const saved = templates.get(id);
  assert.deepEqual(
    { name: saved.name, role: saved.role, summary: saved.summary, source: saved.source },
    { name: "My researcher", role: bot.role, summary: "Finds sources", source: "saved" },
  );
  assert.equal(saved.instructions, bot.instructions);
  assert.deepEqual(saved.look, bot.look, "the template keeps the bot's Botkin");
  assert.equal(JSON.stringify(saved).includes("/Users/me/secret"), false, "no local paths in a template");
  templates.rename(id, "Researcher v2");
  assert.equal(templates.get(id).name, "Researcher v2");
  templates.remove(id);
  assert.throws(() => templates.get(id), /no longer exists/);
});

test("export and import round-trip a template file", (t) => {
  const { dir, ws, templates } = setup(t);
  const bot = ws.state.bots[2];
  const file = join(dir, "Patch.json");
  templates.exportTo(file, { botId: bot.id });
  const shared = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(shared.format, FORMAT);
  assert.equal(shared.version, 1);
  assert.equal(FORMAT, "botkins.bot-template");
  assert.deepEqual(Object.keys(shared).sort(), ["format", "instructions", "look", "name", "role", "version"].sort());
  const id = templates.importFrom(file);
  const imported = templates.get(id);
  assert.deepEqual([imported.name, imported.role, imported.source, imported.from], [bot.name, bot.role, "imported", "Patch.json"]);
  assert.deepEqual(imported.look, bot.look);
});

test("imports refuse files that aren't Botkins templates and drop looks Botkins can't draw", (t) => {
  const { dir, templates } = setup(t);
  const write = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };
  assert.throws(() => templates.importFrom(write("a.json", "not json")), /isn't a bot template/);
  assert.throws(() => templates.importFrom(write("b.json", { name: "x" })), /isn't a Botkins bot template/);
  assert.throws(() => templates.importFrom(write("c.json", { format: FORMAT, version: 2, name: "x" })), /newer Botkins/);
  assert.throws(
    () => templates.importFrom(write("d.json", { format: FORMAT, version: 1, name: "x", role: "y", instructions: "z".repeat(30001) })),
    /Use up to 30,000 characters/,
  );
  assert.throws(() => templates.importFrom(write("e.json", "x".repeat(300 * 1024))), /too large/);
  const ok = parseTemplateFile(
    JSON.stringify({ format: FORMAT, version: 1, name: "Helper", role: "Helps", instructions: "Be kind.", avatar: { body: "nope.nope" }, extra: "ignored" }),
  );
  assert.deepEqual(ok, { name: "Helper", role: "Helps", summary: "", instructions: "Be kind." }, "a silhouette from an earlier version is left out");
  const odd = parseTemplateFile(JSON.stringify({ format: FORMAT, version: 1, name: "Helper", role: "Helps", instructions: "Be kind.", look: { head: "unicorn", palette: "original" } }));
  assert.equal(odd.look, undefined, "a character the kit doesn't have is left out");
});

test("a template file written by an earlier version still imports", (t) => {
  const { dir, templates } = setup(t);
  assert.deepEqual(FORMATS, ["botkins.bot-template", LEGACY_NAME.toLowerCase() + ".bot-template"]);
  const file = join(dir, "Old.json");
  // An early file: its own format name, and a silhouette avatar.
  writeFileSync(file, JSON.stringify({ format: LEGACY_NAME.toLowerCase() + ".bot-template", version: 1, name: "Scribe", role: "Takes notes", summary: "Meeting notes", instructions: "Write what was decided.", avatar: { body: "pocket-curios.quill", main: "#3E9B5E" } }, null, 2));
  const imported = templates.get(templates.importFrom(file));
  assert.deepEqual(
    [imported.name, imported.role, imported.summary, imported.instructions, imported.source, imported.from],
    ["Scribe", "Takes notes", "Meeting notes", "Write what was decided.", "imported", "Old.json"],
  );
  assert.equal(imported.avatar, undefined);
  assert.equal(imported.look, undefined, "the bot made from it gets a character of its own");
  // Exported again, it is written in today's format.
  const again = join(dir, "New.json");
  templates.exportTo(again, { templateId: imported.id });
  assert.equal(JSON.parse(readFileSync(again, "utf8")).format, "botkins.bot-template");
  // A template saved in the workspace by an earlier version keeps reading, avatar and all.
  templates.all.unshift({ id: "kept", name: "Kept", role: "R", summary: "", instructions: "I", avatar: { body: "bighelp.patch" }, source: "saved", createdAt: 1 });
  assert.equal(templates.get("kept").name, "Kept");
  templates.exportTo(again, { templateId: "kept" });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(again, "utf8"))).sort(), ["format", "instructions", "name", "role", "version"]);
});
