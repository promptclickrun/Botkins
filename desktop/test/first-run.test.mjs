// A new workspace has no bots. The person's existing Copilot agents (<Copilot home>/agents) are
// offered as bots; with none, the first-run screen shows the Create a bot form.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Workspace } from "../desktop/workspace.mjs";
import { readPersistedWorkspace } from "./starter.mjs";
import { Providers, ModelProvider } from "../desktop/providers/index.mjs";
import { CopilotProvider } from "../desktop/providers/copilot/index.mjs";
import { agentTitle, matchModel, parseAgentFile, readAgents } from "../desktop/providers/copilot/agents.mjs";
import { roleFrom } from "../desktop/agents.mjs";
import { fakeClient, tempDir } from "./fake-copilot.mjs";

const BACKEND = `---
name: backend-development
description: Backend development specialist for APIs, services, data models, auth, integrations, queues, workers, testing, and production-grade server-side implementation. Use for backend feature work.
target: github-copilot
model: gpt-5.5
tools: ['*']
---

You are the backend development specialist.

Rules:
1. Build the real feature end to end.
`;
const REVIEWER = `---
description: >
  Reviews a change for bugs
  and missed cases.
model: Claude Opus 4.8 (copilot)
tools:
  - read
  - search
mcp-servers:
  tracker:
    command: npx
---
Review the diff. Report findings by severity.
`;

/** A Copilot home with an agents folder holding the given files. */
function copilotHome(t, files) {
  const home = tempDir(t, "botkins-copilot-home-");
  mkdirSync(join(home, "agents"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(home, "agents", name), text);
  return home;
}
const models = [
  { id: "auto", name: "Auto" },
  { id: "gpt-5.5", name: "GPT-5.5" },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8" },
  { id: "o-blocked", name: "Blocked", policy: { state: "disabled" } },
];
function workspace(t, home, extra) {
  const { client, log } = fakeClient(undefined, { models, ...extra });
  const copilot = new CopilotProvider({ connect: client, userHome: home });
  const ws = new Workspace(tempDir(t), new Providers([copilot]), () => {});
  return { ws, log, copilot };
}

test("a new workspace starts with no bots, and still opens and saves", (t) => {
  const dir = tempDir(t);
  const ws = new Workspace(dir, fakeClient().client, () => {});
  assert.deepEqual(ws.state.bots, []);
  assert.deepEqual(ws.snapshot().bots, []);
  assert.deepEqual(readPersistedWorkspace(dir).bots, []);
  // The first bot made in Botkins is the primary bot.
  const id = ws.addBot({ name: "Nova", role: "Helper", instructions: "Help.", face: "idle" });
  assert.equal(ws.state.bots[0].id, id);
  assert.equal(new Workspace(dir, fakeClient().client, () => {}).state.bots.length, 1, "bots made in Botkins are kept");
});

test("an agent file's front matter and prompt are read", () => {
  const a = parseAgentFile(BACKEND);
  assert.equal(a.meta.name, "backend-development");
  assert.equal(a.meta.model, "gpt-5.5");
  assert.deepEqual(a.meta.tools, ["*"]);
  assert.match(a.prompt, /^You are the backend development specialist\.\n\nRules:\n1\. Build/);
  const b = parseAgentFile(REVIEWER);
  assert.equal(b.meta.description, "Reviews a change for bugs and missed cases.");
  assert.deepEqual(b.meta.tools, ["read", "search"]);
  assert.deepEqual(b.meta["mcp-servers"], {});
  assert.equal(b.prompt, "Review the diff. Report findings by severity.");
  assert.deepEqual(parseAgentFile("Just a prompt."), { meta: {}, prompt: "Just a prompt." });
  assert.equal(parseAgentFile("---\r\nname: \"Win\"\r\n---\r\nBody\r\n").meta.name, "Win");
});

test("agent names read as titles and descriptions give a short role", () => {
  assert.equal(agentTitle("backend-development"), "Backend Development");
  assert.equal(agentTitle("ui_ux-reviewer"), "UI UX Reviewer");
  assert.equal(agentTitle("Security Reviewer"), "Security Reviewer");
  assert.equal(roleFrom("Backend development specialist for APIs, services, data models, auth and more things than fit.", "x"), "Backend development specialist");
  assert.equal(roleFrom("Front-end, UI, UX, interaction, visual polish, design-system, accessibility, and product-feel specialist. Use for React.", "x"), "Front-end");
  assert.equal(roleFrom("Reviews pull requests.", "x"), "Reviews pull requests");
  assert.equal(roleFrom("", "GitHub Copilot agent"), "GitHub Copilot agent");
  const long = roleFrom("word ".repeat(40).trim(), "x");
  assert.ok(long.length <= 90 && long.endsWith("…"));
});

test("the agents folder is read: .agent.md files, and plain .md only with agent front matter", (t) => {
  const home = copilotHome(t, {
    "backend-development.agent.md": BACKEND,
    "reviewer.agent.md": REVIEWER,
    "README.md": "# Notes\n\nNot an agent.",
    "old-style.md": "---\ndescription: An older agent file\n---\nDo the old thing.",
    "empty.agent.md": "---\nname: empty\n---\n",
    ".hidden.agent.md": BACKEND,
    "copy.agent.md": BACKEND,
  });
  mkdirSync(join(home, "agents", "folder.agent.md"));
  const found = readAgents(join(home, "agents"));
  assert.deepEqual(found.map((a) => a.name), ["backend-development", "old-style", "reviewer"], "one per name; no README, empty or hidden file");
  const [backend, , reviewer] = found;
  assert.equal(backend.title, "Backend Development");
  assert.equal(backend.model, "gpt-5.5");
  assert.equal(backend.ownTools, false, "tools: ['*'] is every tool");
  assert.equal(backend.file, join(home, "agents", "backend-development.agent.md"));
  assert.equal(reviewer.name, "reviewer", "a file without a name uses its file name");
  assert.equal(reviewer.ownTools, true);
  assert.deepEqual(readAgents(join(home, "missing")), []);
});

test("a model in an agent file is matched to the catalog by id or name", () => {
  const catalog = [
    { id: "gpt-5.5", name: "GPT-5.5", available: true },
    { id: "claude-opus-4.8", name: "Claude Opus 4.8", available: true },
    { id: "o-blocked", name: "Blocked", available: false },
  ];
  assert.equal(matchModel(catalog, "gpt-5.5").id, "gpt-5.5");
  assert.equal(matchModel(catalog, "GPT-5.5").id, "gpt-5.5");
  assert.equal(matchModel(catalog, "Claude Opus 4.8 (copilot)").id, "claude-opus-4.8");
  assert.equal(matchModel(catalog, "o-blocked"), undefined, "a model the account can't use is left out");
  assert.equal(matchModel(catalog, "made-up"), undefined);
  assert.equal(matchModel(catalog, undefined), undefined);
});

test("existing Copilot agents are offered as bots and become bots when chosen", async (t) => {
  const home = copilotHome(t, { "backend-development.agent.md": BACKEND, "reviewer.agent.md": REVIEWER });
  const { ws } = workspace(t, home);
  const offered = await ws.agents.importable();
  assert.deepEqual(
    offered.map((a) => [a.key, a.name, a.role, a.modelName, a.ownTools, a.added]),
    [
      ["copilot:backend-development", "Backend Development", "Backend development specialist", "GPT-5.5", false, false],
      ["copilot:reviewer", "Reviewer", "Reviews a change for bugs and missed cases", "Claude Opus 4.8", true, false],
    ],
  );
  assert.ok(offered[0].summary.length <= 240);
  assert.equal(offered[0].providerName, "GitHub Copilot");

  await assert.rejects(ws.agents.importAgents([]), /Choose at least one agent/);
  await assert.rejects(ws.agents.importAgents(["copilot:gone"]), /no longer available/);
  assert.equal(ws.state.bots.length, 0, "a refused import adds nothing");

  const ids = await ws.agents.importAgents(["copilot:reviewer", "copilot:backend-development", "copilot:reviewer"]);
  assert.equal(ids.length, 2);
  const [reviewer, backend] = ws.state.bots;
  assert.equal(reviewer.name, "Reviewer", "the first agent chosen is the primary bot");
  assert.equal(reviewer.instructions, "Review the diff. Report findings by severity.");
  assert.deepEqual(reviewer.model, { model: "claude-opus-4.8", provider: "copilot" });
  assert.deepEqual(reviewer.origin, { provider: "copilot", agent: "reviewer", file: join(home, "agents", "reviewer.agent.md") });
  assert.match(backend.instructions, /^You are the backend development specialist\./);
  assert.deepEqual(backend.model, { model: "gpt-5.5", provider: "copilot" });
  assert.ok(reviewer.look.head && backend.look.head && reviewer.look.head !== backend.look.head, "each gets its own character");
  assert.equal(backend.hidden, undefined);

  // They are bots now: the list says so, and choosing them again adds nothing.
  assert.deepEqual((await ws.agents.importable()).map((a) => a.added), [true, true]);
  assert.deepEqual(await ws.agents.importAgents(["copilot:reviewer"]), []);
  assert.equal(ws.state.bots.length, 2);

  // A chat with an imported bot runs on the agent's instructions and model.
  const chat = ws.createChat(backend.id);
  assert.match(ws.instructionsFor(ws.chat(chat), backend), /You are the backend development specialist\./);
  assert.deepEqual(ws.effectiveModel(ws.chat(chat)), { model: "gpt-5.5", provider: "copilot" });

  // The agent files are only read.
  assert.equal(readFileSync(join(home, "agents", "backend-development.agent.md"), "utf8"), BACKEND);
});

test("the Create a bot form can start from an agent and keeps what the person changed", async (t) => {
  const home = copilotHome(t, { "backend-development.agent.md": BACKEND });
  const { ws } = workspace(t, home);
  const id = await ws.agents.create({
    agent: "copilot:backend-development",
    name: "Bea",
    role: "Backend",
    instructions: "My own wording.",
    face: "idle",
  });
  const bot = ws.bot(id);
  assert.deepEqual([bot.name, bot.role, bot.instructions], ["Bea", "Backend", "My own wording."]);
  assert.equal(bot.origin.agent, "backend-development");
  assert.deepEqual(bot.model, { model: "gpt-5.5", provider: "copilot" });
  await assert.rejects(ws.agents.create({ agent: "copilot:gone", name: "x", role: "y", instructions: "z" }), /no longer available/);
  // Without an agent it is the plain form.
  const plain = await ws.agents.create({ name: "Nova", role: "Helper", instructions: "Help.", face: "idle" });
  assert.equal(ws.bot(plain).origin, undefined);
  assert.equal(ws.state.bots.length, 2);
});

test("agents are offered signed out or with an unknown model, and long prompts are refused", async (t) => {
  const home = copilotHome(t, {
    "backend-development.agent.md": BACKEND,
    "odd.agent.md": "---\nname: odd\nmodel: not-a-model\n---\nBe odd.",
    "huge.agent.md": "---\nname: huge\n---\n" + "x".repeat(30001),
  });
  const { ws } = workspace(t, home, { client: { listModels: async () => Promise.reject(new Error("Not signed in")) } });
  const offered = await ws.agents.importable();
  assert.deepEqual(offered.map((a) => [a.agent, a.model, !!a.problem]), [
    ["backend-development", undefined, false],
    ["huge", undefined, true],
    ["odd", undefined, false],
  ]);
  assert.equal(offered[2].role, "GitHub Copilot agent", "an agent without a description still gets a role");
  assert.ok(offered.every((a) => a.missingModel === undefined), "without a model list nothing is said about a model");
  // With the model list, a model the account doesn't have is named, and the bot gets no model of its own.
  const signedIn = workspace(t, home);
  const seen = await signedIn.ws.agents.importable();
  assert.deepEqual(seen.map((a) => [a.agent, a.modelName, a.missingModel]), [
    ["backend-development", "GPT-5.5", undefined],
    ["huge", undefined, undefined],
    ["odd", undefined, "not-a-model"],
  ]);
  const [oddId] = await signedIn.ws.agents.importAgents(["copilot:odd"]);
  assert.equal(signedIn.ws.bot(oddId).model, undefined);
  await assert.rejects(ws.agents.importAgents(["copilot:huge"]), /Huge can't be added\. Its instructions are longer than 30,000 characters/);
  const [id] = await ws.agents.importAgents(["copilot:backend-development"]);
  assert.equal(ws.bot(id).model, undefined, "it uses the default model");
});

test("a provider without a Copilot home, or another provider, offers what it has", async (t) => {
  // Tests and other embedders that give no home never read the real ~/.copilot.
  assert.deepEqual(await new CopilotProvider({ connect: fakeClient().client }).agents(), []);
  class Other extends ModelProvider {
    id = "other";
    name = "Other";
    async agents() {
      return [{ name: "helper", title: "Helper", description: "Helps with anything.", instructions: "Help." }];
    }
  }
  class Broken extends ModelProvider {
    id = "broken";
    name = "Broken";
    async agents() {
      throw new Error("no agents today");
    }
  }
  const copilot = new CopilotProvider({ connect: fakeClient().client });
  const errors = t.mock.method(console, "error", () => {});
  const ws = new Workspace(tempDir(t), new Providers([copilot, new Other(), new Broken()]), () => {});
  const offered = await ws.agents.importable();
  assert.deepEqual(offered.map((a) => [a.key, a.providerName]), [["other:helper", "Other"]]);
  assert.equal(errors.mock.callCount(), 1, "a provider that fails is skipped and logged");
  const [id] = await ws.agents.importAgents(["other:helper"], "m_avery");
  assert.deepEqual(ws.state.chats.filter(c => c.botId === id && c.main).map(c => c.createdBy), ["m_avery"]);
  assert.deepEqual(ws.bot(id).origin, { provider: "other", agent: "helper" });
});

test("an empty workspace and an agent file with no usable name cause no trouble", async (t) => {
  const home = copilotHome(t, { "-.agent.md": "---\ndescription: No name to show\n---\nDo things.", "ok.agent.md": "---\nname: ok\n---\nBe OK." });
  assert.deepEqual(readAgents(join(home, "agents")).map((a) => [a.name, a.title]), [["-", "-"], ["ok", "Ok"]]);
  const { ws } = workspace(t, home);
  ws.agents.reorderBots([]);
  assert.deepEqual(ws.state.bots, []);
  // Agents are all made before any is added.
  const ids = await ws.agents.importAgents(["copilot:-", "copilot:ok"]);
  assert.equal(ids.length, 2);
  assert.deepEqual(ws.state.bots.map((b) => b.name), ["-", "Ok"]);
});

test("a bot's instructions hold a full Copilot agent prompt", (t) => {
  const ws = new Workspace(tempDir(t), fakeClient().client, () => {});
  const id = ws.addBot({ name: "Long", role: "Reader", instructions: "y".repeat(30000), face: "idle" });
  assert.equal(ws.bot(id).instructions.length, 30000);
  assert.throws(() => ws.updateBot(id, { instructions: "y".repeat(30001) }), /Use up to 30,000 characters/);
  assert.throws(() => ws.addBot({ name: "Empty", role: "None", instructions: "  ", face: "idle" }), /Invalid instructions/);
});
