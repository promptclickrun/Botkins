// The tool a bot uses to propose a plugin change (desktop/plugin-tools.mjs): a card that is not
// whole is not asked about, and plugin text that goes outside the card is safe and bounded. The
// tool is driven with the smallest stand-in for the workspace (a real Workspace is used in
// plugins-manager.test.mjs), so that a test can describe any plugin.
import test from "node:test";
import assert from "node:assert/strict";
import { pluginTools } from "../desktop/plugin-tools.mjs";
import { hasUnshown } from "../desktop/shown-text.mjs";

const NOT_WHOLE = "This plugin is too large to look at in a chat. Make this change in Settings, Marketplace, Plugins, or with `botkins plugins` on the command line, where all of it is shown.";

function harness(card, { answer = { action: "approve" } } = {}) {
  const requests = [];
  const notes = [];
  const calls = [];
  const task = {};
  const chat = { id: "c1" };
  const bot = { id: "b1", name: "Pip" };
  const plugins = {
    generation: 1,
    list: () => [{ ...card, id: "p", bots: "all" }],
    preview: async () => card,
    install: async (...args) => calls.push(["install", ...args.slice(0, 2)]),
    configure: async (...args) => calls.push(["configure", ...args.slice(0, 2)]),
    setEnabled: async (...args) => calls.push(["setEnabled", ...args.slice(0, 3)]),
  };
  const ws = {
    closing: false,
    active: new Map([[chat.id, task]]),
    state: { bots: [bot] },
    plugins,
    pluginNote: (...args) => notes.push(args),
    interactions: {
      request: async (_chat, _task, view) => {
        requests.push(view);
        return view.kind === "secure" ? { action: "accept", content: Object.fromEntries(view.fields.map((f) => [f.key, "secret"])) } : answer;
      },
    },
  };
  const tool = pluginTools(ws, bot, chat, { id: "run" }, task).find((t) => t.name === "propose_plugin");
  return { tool, requests, notes, calls, ws };
}

test("a plugin that is too large for the card is not asked about", async () => {
  const card = { name: "big", config: [], contents: { hooks: Array.from({ length: 500 }, (_, i) => ({ event: "e" + i, command: "run", env: [] })) } };
  for (const action of ["install", "update"]) {
    const { tool, requests, notes, calls } = harness(card);
    assert.equal(await tool.handler({ id: "p", action }), NOT_WHOLE);
    assert.equal(requests.length, 0);
    assert.deepEqual(notes, [["c1", NOT_WHOLE]]);
    assert.deepEqual(calls, []);
  }
  // A workspace without pluginNote still gives the bot the sentence.
  const bare = harness(card);
  delete bare.ws.pluginNote;
  assert.equal(await bare.tool.handler({ id: "p", action: "install" }), NOT_WHOLE);
  assert.equal(bare.requests.length, 0);
});

test("a plugin whose description holds less than it counts is not asked about", async () => {
  const card = { name: "p", config: [], contents: { notRun: { count: 9, items: [{ what: "hook", name: "x", why: "no" }] } } };
  const { tool, requests } = harness(card);
  assert.equal(await tool.handler({ id: "p", action: "install" }), NOT_WHOLE);
  assert.equal(requests.length, 0);
});

test("a whole card is asked about, and a yes goes on as before", async () => {
  const card = { name: "small", revision: "r1", config: [{ key: "K", label: "Key", secret: true, required: true }], contents: {} };
  const { tool, requests, notes, calls } = harness(card);
  assert.equal(await tool.handler({ id: "p", action: "install" }), "Plugin change saved.");
  assert.deepEqual(requests.map((r) => r.kind), ["permission", "secure"]);
  assert.equal(requests[0].preview, "install · small");
  assert.equal(requests[1].fields[0].key, "K");
  assert.equal(requests[1].fields[0].label, "Key");
  assert.deepEqual(notes, []);
  assert.equal(calls.length, 1);
  assert.deepEqual({ ...calls[0][2], config: { ...calls[0][2].config } }, { bots: ["b1"], config: { K: "secret" }, revision: "r1" });
});

test("a yes to switch on is tied to the revision that the card showed, and a switch-off names none", async () => {
  const card = { name: "small", revision: "a".repeat(64), config: [], contents: { hooks: [{ event: "sessionStart", command: "true", env: [] }] } };
  const on = harness(card);
  assert.equal(await on.tool.handler({ id: "p", action: "enable" }), "Plugin change saved.");
  assert.deepEqual(on.calls, [["setEnabled", "p", true, { revision: card.revision }]]);
  const off = harness(card);
  assert.equal(await off.tool.handler({ id: "p", action: "disable" }), "Plugin change saved.");
  assert.deepEqual(off.calls, [["setEnabled", "p", false, undefined]]);
  // A no sends nothing.
  const declined = harness(card, { answer: { action: "deny" } });
  assert.equal(await declined.tool.handler({ id: "p", action: "enable" }), "The person declined.");
  assert.deepEqual(declined.calls, []);
});

test("a name and a label from the plugin are safe and bounded in every request", async () => {
  const bad = "x‮y​z" + "a".repeat(500);
  const card = { name: bad, revision: "r1", config: [{ key: "KEY_1", label: bad, secret: true, required: true }], contents: {} };
  for (const action of ["install", "configure"]) {
    const { tool, requests, calls } = harness(card);
    assert.equal(await tool.handler({ id: "p", action }), "Plugin change saved.");
    assert.deepEqual(requests.map((r) => r.kind), ["permission", "secure"]);
    for (const view of requests) {
      // The card's detail is lines, so each line is looked at; the new line between them is its own.
      for (const text of [view.title, view.preview ?? "", ...view.detail.split("\n"), ...(view.fields ?? []).map((f) => f.label)]) {
        assert.equal(hasUnshown(text), false, text);
        assert.ok(!text.includes("‮"));
      }
    }
    const [permission, secure] = requests;
    assert.ok(permission.preview.startsWith(action + " · x\\u{202e}y\\u{200b}z"));
    assert.ok(permission.preview.length <= (action + " · ").length + 80);
    assert.ok(secure.title.length <= "Configure ".length + 80);
    assert.ok(secure.detail.length <= 300);
    assert.ok(secure.fields[0].label.length <= 120 + 2);
    assert.ok(secure.fields[0].label.endsWith(" …"));
    // The key that sends the value back stays exact.
    assert.equal(secure.fields[0].key, "KEY_1");
    assert.deepEqual(Object.keys(calls[0][2].config ?? calls[0][2]), ["KEY_1"]);
    assert.equal(calls[0][0], action);
  }
});

test("a workflow step's turn gets no plugin tools, like a routine or a task", () => {
  const ws = { closing: false, active: new Map([["c1", {}]]), state: { bots: [] }, plugins: { list: () => [] } };
  const chat = { id: "c1" };
  const bot = { id: "b1", name: "Pip" };
  assert.ok(pluginTools(ws, bot, chat, { id: "run" }, {}).length > 0);
  assert.deepEqual(pluginTools(ws, bot, chat, { id: "run", workflowRunId: "wr1" }, {}), []);
});
