// The turn's hot path writes the state soon, not on every step (Workspace.saveSoon in desktop/workspace.mjs):
// many changes make one write, the window still hears of each at once, and a save, a flush or a
// new Workspace on the same folder leaves nothing waiting.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

function setup(t) {
  const dir = tempDir(t);
  let heard = 0;
  const ws = new Workspace(dir, fakeClient().client, () => heard++);
  const onDisk = () => JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8"));
  t.after(() => ws.flushSave());
  return { dir, ws, onDisk, heard: () => heard };
}

test("many hot-path changes make one write, after the window heard each", async (t) => {
  const { ws, onDisk, heard } = setup(t);
  ws.save();
  const before = heard();
  for (let i = 0; i < 50; i++) {
    ws.state.settings.saveSoonProbe = i;
    ws.saveSoon();
  }
  assert.equal(heard() - before, 50, "the window hears every change at once");
  assert.equal(onDisk().settings.saveSoonProbe, undefined, "nothing written yet");
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(onDisk().settings.saveSoonProbe, 49, "one write with the newest state");
  assert.equal(ws.saveTimer, null);
});

test("a save or a flush writes what was waiting and leaves no timer", (t) => {
  const { ws, onDisk } = setup(t);
  ws.state.settings.saveSoonProbe = "soon";
  ws.saveSoon();
  ws.flushSave();
  assert.equal(onDisk().settings.saveSoonProbe, "soon");
  assert.equal(ws.saveTimer, null);

  ws.state.settings.saveSoonProbe = "then saved";
  ws.saveSoon();
  ws.save();
  assert.equal(onDisk().settings.saveSoonProbe, "then saved");
  assert.equal(ws.saveTimer, null);
  ws.flushSave();
});
