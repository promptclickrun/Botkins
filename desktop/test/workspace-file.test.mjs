import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "../desktop/workspace.mjs";
import { readWorkspace } from "../desktop/workspace-file.mjs";

function fixture(t, state) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-workspace-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "workspace.json");
  writeFileSync(file, JSON.stringify(state));
  return { dir, file };
}

test("opening an early workspace preserves direct and inherited project access and archives old records once", (t) => {
  const groups = [{ id: "a", name: "Operations" }, { id: "b", name: "Support" }];
  const { dir, file } = fixture(t, {
    bots: [{ id: "pip", name: "Pip", role: "Helper", instructions: "Help.", access: { all: false, groups: ["a", "missing"], projects: ["direct"] } }],
    chats: [], runs: [], groups, settings: { access: { allBots: false } },
    projects: ["direct", "inherited", "outside", "orphan"].map((id, i) => ({ id, name: id, groupId: ["a", "a", "b", "missing"][i] })),
  });
  const occupied = join(dir, "archived-records.json");
  writeFileSync(occupied, "keep this");
  // Reopening before the first save also reuses the archive.
  readWorkspace(file);
  const ws = new Workspace(dir, async () => ({}), () => {});
  const saved = JSON.parse(readFileSync(file, "utf8"));
  for (const state of [saved, ws.snapshot()]) {
    assert.ok(!Object.hasOwn(state, "groups"));
    assert.ok(state.projects.every((p) => !Object.hasOwn(p, "groupId")));
    assert.deepEqual(state.bots[0].access, { all: false, projects: ["direct", "inherited"] });
  }
  const archive = join(dir, "archived-records-2.json");
  const recovered = JSON.parse(readFileSync(archive, "utf8"));
  assert.deepEqual(recovered.sections, { groups });
  assert.deepEqual(recovered.grants, [{ id: "pip", fields: { groups: ["a", "missing"] } }]);
  assert.deepEqual(recovered.projects.map((p) => p.fields.groupId), ["a", "a", "b", "missing"]);
  assert.equal(readFileSync(occupied, "utf8"), "keep this");
  if (process.platform !== "win32") assert.equal(statSync(archive).mode & 0o777, 0o600);
  new Workspace(dir, async () => ({}), () => {});
  assert.equal(readdirSync(dir).filter((name) => name.startsWith("archived-records")).length, 2);
});

test("current workspaces never turn unknown access fields into grants", (t) => {
  const { dir } = fixture(t, {
    bots: [{ id: "pip", name: "Pip", access: { labels: ["a"], projects: [] } }], chats: [], runs: [],
    spaces: [], labels: [{ id: "a" }], projects: [{ id: "p", name: "Private", labelId: "a" }],
    settings: { access: { allBots: false } },
  });
  const ws = new Workspace(dir, async () => ({}), () => {});
  assert.deepEqual(ws.bot("pip").access, { all: false, projects: [] });
});

test("stored messages retain their words and only send references the host understands", (t) => {
  const project = { kind: "project", id: "p", label: "Launch" };
  const retired = { kind: "old", id: "r", label: "My notes" };
  const message = { text: "My original words", mentions: [retired, project] };
  const { dir, file } = fixture(t, {
    bots: [], runs: [], chats: [{ id: "c", messages: [message] }],
    pendingMessages: { c: [message] }, unused: [],
  });
  const opened = readWorkspace(file);
  assert.deepEqual(opened.chats[0].messages[0], { text: message.text, mentions: [{ kind: "label", id: "0", label: "My notes" }, project] });
  assert.deepEqual(opened.pendingMessages.c[0], { text: message.text, mentions: [project] });
  assert.deepEqual(readdirSync(dir), ["workspace.json"]);
});
