import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedFiles } from "../scripts/check-release.mjs";
import { uploadDraft } from "../scripts/release-draft.mjs";

const version = "1.2.3";
const desktop = "Botkins-1.2.3-win.zip";
const terminal = "botkins-terminal-1.2.3-linux-x64.tar.gz";
const names = expectedFiles(version).map(file => file.name);
const local = {
  paths: new Map(names.map(name => [name, "/fixture/" + name])),
  files: new Map(names.map((name, i) => [name, i.toString(16).repeat(64)])),
};
function fixture({ existing = false, published = false, rejectGate = false } = {}) {
  const calls = [];
  const assets = [];
  let draft = existing;
  const run = (tool, args) => {
    calls.push([tool, args]);
    if (tool === process.execPath) {
      if (rejectGate) throw Error("Release signature failed");
      return "";
    }
    assert.equal(tool, "gh");
    const action = args[1];
    if (action === "list") return JSON.stringify(draft || published ? [{ tagName: "v" + version, isDraft: !published }] : []);
    if (action === "create") {
      assert.ok(args.includes("--draft") && args.includes("--verify-tag"));
      draft = true;
    } else if (action === "view") {
      return JSON.stringify({ isDraft: draft, assets });
    } else if (action === "upload") {
      assert.ok(draft && !published);
      assert.ok(!args.includes("--clobber"));
      for (const name of names.filter(n => args.includes(local.paths.get(n)))) {
        assets.push({ name, digest: "sha256:" + local.files.get(name), state: "uploaded" });
      }
    } else assert.fail("Unexpected release action " + action);
    return "";
  };
  return { calls, assets, run };
}
function prepare(mock, overrides = {}) {
  return uploadDraft({ version, names, local, run: mock.run, ...overrides });
}
test("uploads installer and terminal assets and ends by checking the GitHub draft", () => {
  const mock = fixture();
  prepare(mock);
  assert.deepEqual(mock.assets.map(a => a.name), names);
  assert.equal(names.filter(name => name.startsWith("botkins-terminal-")).length, 4);
  assert.ok(names.includes("install.sh"));
  assert.deepEqual(mock.calls.at(-1), [process.execPath, ["scripts/check-release.mjs", version]]);
});
test("a missing terminal build stops before a draft is created", () => {
  const mock = fixture();
  const partial = { ...local, paths: new Map(local.paths) };
  partial.paths.delete(terminal);
  assert.throws(() => prepare(mock, { local: partial }), /linux-x64/);
  assert.equal(mock.calls.length, 0);
});
test("a failed draft gate fails the command and the release stays a draft", () => {
  const mock = fixture({ rejectGate: true });
  assert.throws(() => prepare(mock), /signature failed/);
  assert.ok(!mock.calls.some(([, args]) => args.includes("--latest")));
});
test("a retry keeps matching assets and rejects different bytes and a published version", () => {
  const mock = fixture({ existing: true });
  mock.assets.push({ name: desktop, digest: "sha256:" + local.files.get(desktop), state: "uploaded" });
  prepare(mock);
  assert.ok(!mock.calls.find(([, args]) => args[1] === "upload")[1].includes(local.paths.get(desktop)));
  mock.assets[0].digest = "sha256:" + "f".repeat(64);
  assert.throws(() => prepare(mock), /different|match/i);
  assert.throws(() => prepare(fixture({ published: true })), /published/i);
});
