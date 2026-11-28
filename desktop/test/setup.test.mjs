// Setting the app up: ChatGPT, Claude and GitHub Copilot are offered as equals, and a new
// workspace has no default model until the person connects a provider.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "../desktop/workspace.mjs";
import { readPersistedWorkspace } from "./starter.mjs";
import { ModelProvider, Providers, SETUP_ORDER } from "../desktop/providers/index.mjs";
import { tempDir, tick } from "./fake-copilot.mjs";

/** The providers by the names people know them by. */
const NAMES = { copilot: "GitHub Copilot", codex: "ChatGPT", claude: "Claude", opencode: "OpenCode", acp: "Antigravity" };
/** A stand-in provider: connected or not, with a model list, and optionally slow to answer. */
class Stand extends ModelProvider {
  constructor(id, { connected = false, models, delay = 0, defaultEnabled = true } = {}) {
    super();
    Object.assign(this, { id, name: NAMES[id] ?? id, connected, delay, defaultEnabled, list: models ?? [{ id: id + "-small", name: "Small", efforts: [], available: true }, { id: id + "-best", name: "Best", efforts: [], available: true, recommended: true }] });
  }
  async status() {
    if (this.delay) await tick(this.delay);
    return { installed: true, connected: this.connected, signIn: "browser", signOut: this.connected };
  }
  async models() {
    return this.list;
  }
}
/** The three as the app registers them: GitHub Copilot first (the provider of a choice that names none), then ChatGPT and Claude. */
const three = (state = {}) => ["copilot", "codex", "claude"].map((id) => new Stand(id, state[id]));
const open = (t, list, options) => {
  const dir = join(tempDir(t), "data");
  return { dir, ws: new Workspace(dir, new Providers(list, options), () => {}) };
};
const saved = (dir) => readPersistedWorkspace(dir).settings;

test("the three are offered in the order ChatGPT, Claude, GitHub Copilot", () => {
  assert.deepEqual(SETUP_ORDER, ["codex", "claude", "copilot"]);
  // The page keeps its own copy of the order (it can't read this module): the two must agree.
  const page = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf8");
  assert.match(page, /export const SETUP_PROVIDERS = \["codex", "claude", "copilot"\];/);
});

test("a new workspace has no default model until a provider is connected, then it is that provider's", async (t) => {
  const list = three();
  const { dir, ws } = open(t, list);
  assert.equal(ws.state.settings.modelUnset, true);
  // Nothing connected: nothing is chosen, and no provider is assumed.
  await ws.providerStatuses();
  assert.equal(ws.state.settings.modelUnset, true);
  // The person signs in to Claude: the default becomes Claude's recommended model.
  list[2].connected = true;
  await ws.providerChanged("claude");
  assert.deepEqual(ws.state.settings.model, { model: "claude-best", provider: "claude" });
  assert.equal(ws.state.settings.modelUnset, undefined);
  assert.deepEqual(saved(dir).model, { model: "claude-best", provider: "claude" });
  // Connecting another one later doesn't move it.
  list[0].connected = true;
  list[1].connected = true;
  await ws.providerChanged("copilot");
  await ws.providerChanged("codex");
  assert.deepEqual(ws.state.settings.model, { model: "claude-best", provider: "claude" });
});

test("whichever of the three is connected first decides, GitHub Copilot and ChatGPT alike", async (t) => {
  for (const id of ["copilot", "codex", "claude"]) {
    const list = three();
    const { ws } = open(t, list);
    list.find((p) => p.id === id).connected = true;
    await ws.providerChanged(id);
    assert.deepEqual(ws.state.settings.model, { model: id + "-best", provider: id }, id);
  }
});

test("with several already signed in at the first start, the first by name decides, alphabetically", async (t) => {
  // All three tools were signed in before the app was installed.
  const all = open(t, three({ copilot: { connected: true }, codex: { connected: true }, claude: { connected: true } }));
  await all.ws.providerStatuses();
  assert.deepEqual(all.ws.state.settings.model, { model: "codex-best", provider: "codex" });
  // Claude and GitHub Copilot only.
  const two = open(t, three({ copilot: { connected: true }, claude: { connected: true } }));
  await two.ws.providerStatuses();
  assert.deepEqual(two.ws.state.settings.model, { model: "claude-best", provider: "claude" });
  // No provider is preferred, the three included: GitHub Copilot comes before OpenCode, and Antigravity before them all.
  const other = open(t, [new Stand("copilot", { connected: true }), new Stand("opencode", { connected: true })]);
  await other.ws.providerStatuses();
  assert.equal(other.ws.state.settings.model.provider, "copilot");
  const first = open(t, [...three({ copilot: { connected: true }, codex: { connected: true } }), new Stand("acp", { connected: true })]);
  await first.ws.providerStatuses();
  assert.equal(first.ws.state.settings.model.provider, "acp");
  // Only a provider outside the three: it is the one.
  const only = open(t, [new Stand("copilot"), new Stand("opencode", { connected: true })]);
  await only.ws.providerStatuses();
  assert.deepEqual(only.ws.state.settings.model, { model: "opencode-best", provider: "opencode" });
});

test("one that is still starting and comes earlier in the alphabet is waited for, so the answer doesn't depend on which is quickest", async (t) => {
  // GitHub Copilot answers at once; ChatGPT takes longer than the registry waits for a status.
  const list = three({ copilot: { connected: true }, codex: { connected: true, delay: 120 } });
  const { ws } = open(t, list, { statusWait: 20 });
  const first = await ws.providerStatuses();
  assert.equal(first.find((s) => s.id === "codex").starting, true);
  assert.equal(ws.state.settings.modelUnset, true, "not decided while ChatGPT is still starting");
  await tick(160);
  await ws.providerStatuses();
  assert.deepEqual(ws.state.settings.model, { model: "codex-best", provider: "codex" });
  // One that comes later in the alphabet is not waited for: it couldn't be the one.
  const later = open(t, three({ codex: { connected: true }, copilot: { connected: true, delay: 120 } }), { statusWait: 20 });
  await later.ws.providerStatuses();
  assert.deepEqual(later.ws.state.settings.model, { model: "codex-best", provider: "codex" });
});

test("a workspace that already exists keeps its default, and the person's own choice is final", async (t) => {
  // A workspace from before: its default names no provider, which means GitHub Copilot's.
  const dir = join(tempDir(t), "data");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workspace.json"), JSON.stringify({ bots: [], chats: [], runs: [], settings: { model: { model: "auto" } } }));
  const list = three({ copilot: { connected: true }, codex: { connected: true }, claude: { connected: true } });
  const ws = new Workspace(dir, new Providers(list), () => {});
  assert.equal(ws.state.settings.modelUnset, undefined);
  await ws.providerStatuses();
  assert.deepEqual(ws.state.settings.model, { model: "auto" }, "left as it was");
  // As before, a default whose provider can no longer answer moves to one that can.
  list[0].connected = false;
  await ws.providerChanged("copilot");
  assert.notEqual(ws.state.settings.model.provider ?? "copilot", "copilot");

  // On a new workspace, a default the person sets themselves is not replaced by the first connection.
  const fresh = three({ copilot: { connected: true } });
  const next = open(t, fresh);
  await next.ws.setModel("global", null, { model: "copilot-small", provider: "copilot" });
  assert.equal(next.ws.state.settings.modelUnset, undefined);
  fresh[1].connected = true;
  await next.ws.providerChanged("codex");
  assert.deepEqual(next.ws.state.settings.model, { model: "copilot-small", provider: "copilot" });
});
