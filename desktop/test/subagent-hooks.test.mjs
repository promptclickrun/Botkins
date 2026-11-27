// A plugin's subagentStart and subagentStop hooks around Botkins' own subagent_run children
// (desktop/subagents.mjs), whatever harness the turn is on. What must hold is what the real Copilot
// runtime does around its own `task` children (test/subagent-hooks-probe-live.mjs): one start and,
// for a child that answered, one stop, with the child's stable id; no stop for a child that failed
// or was stopped; what subagentStart adds goes before the child's task; modifiedResponse is what the
// parent gets; a block is not kept (Botkins' reading of hook output); and nothing without
// plugin access. The child's own hooks say which child it is, and it runs no session hooks.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";
import { SUBAGENT_TYPE } from "../desktop/subagents.mjs";

const EVENTS = ["sessionStart", "userPromptSubmitted", "agentStop", "subagentStart", "subagentStop", "sessionEnd"];
const taskOf = (prompt) => prompt.split("Task:\n").pop().trim();

/** A workspace with one installed plugin whose hooks write what they are told and answer answers/<event>.json. */
async function setup(t, reply, { answers = {}, enabled = true } = {}) {
  const dir = tempDir(t);
  const source = join(dir, "lifecycle-plugin");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "plugin.json"), JSON.stringify({ name: "lifecycle", hooks: "hooks.json" }));
  const answersDir = join(dir, "answers");
  mkdirSync(answersDir, { recursive: true });
  for (const [event, answer] of Object.entries(answers)) writeFileSync(join(answersDir, event + ".json"), JSON.stringify(answer));
  const logFile = join(dir, "events.log");
  writeFileSync(
    join(source, "hook.mjs"),
    [
      'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
      "const [event, log, answers] = process.argv.slice(2);",
      'let d = ""; process.stdin.on("data", (b) => (d += b)).on("end", () => {',
      "  const x = JSON.parse(d);",
      "  appendFileSync(log, JSON.stringify({ event, agentId: x.agentId, agentType: x.agentType, agentName: x.agentName, agentDisplayName: x.agentDisplayName, parentAgentId: x.parentAgentId, stopHookActive: x.stopHookActive, response: x.response }) + \"\\n\");",
      '  const file = answers + "/" + event + ".json";',
      '  console.log(existsSync(file) ? readFileSync(file, "utf8").trim() : "{}");',
      "});",
    ].join("\n"),
  );
  writeFileSync(join(source, "hooks.json"), JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((event) => [event, [{ type: "command", command: `node "\${PLUGIN_ROOT}/hook.mjs" ${event} ${JSON.stringify(logFile)} ${JSON.stringify(answersDir)}` }]])) }));
  const fake = fakeClient(reply);
  const ws = new Workspace(join(dir, "data"), fake.client, () => {});
  const added = await ws.plugins.addFolder(source, { enabled });
  const events = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { ws, ...fake, events, added };
}
const lifecycle = (events) => events.filter((e) => e.event === "subagentStart" || e.event === "subagentStop");

test("a child that answers: one subagentStart and one subagentStop, with its stable id and the parent's scope", async (t) => {
  let launched;
  const { ws, events, log } = await setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) return { data: { content: "child answer" } };
    launched = JSON.parse(await session.tool("subagent_run", { task: "Look it up", label: "Lookup" }));
    return { data: { content: "parent got: " + launched.reply } };
  });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Go");
  const seen = lifecycle(events());
  assert.deepEqual(seen.map((e) => e.event), ["subagentStart", "subagentStop"]);
  for (const e of seen) {
    assert.equal(e.agentId, launched.id, "the id the parent was given");
    assert.equal(e.agentType, SUBAGENT_TYPE);
    assert.equal(e.agentDisplayName, "Lookup");
    assert.equal(e.parentAgentId, ws.state.runs[0].id);
  }
  assert.equal(seen[1].response, "child answer");
  assert.equal(seen[1].stopHookActive, false);
  // The child's own session gets the plugin's hooks as a child: they say which child, and it has no session or subagent hooks.
  const childId = [...log.sessions.keys()].find((k) => k.includes("-sub-"));
  const handlers = log.configs.get(childId).hooks.handlers;
  for (const name of ["onSessionStart", "onSessionEnd", "onSubagentStart", "onSubagentStop"]) assert.equal(handlers[name], undefined, name);
  await handlers.onUserPromptSubmitted({ prompt: "x" }, { sessionId: childId });
  const own = events().find((e) => e.event === "userPromptSubmitted" && e.agentId);
  assert.deepEqual([own.agentId, own.agentType], [launched.id, SUBAGENT_TYPE]);
  // The parent's session has all of them, and its own hooks say no child.
  const parent = log.configs.get(chatId).hooks.handlers;
  assert.equal(typeof parent.onSubagentStart, "function");
});

test("what subagentStart adds goes before the child's task, and modifiedResponse is what the parent gets", async (t) => {
  const first = [];
  const { ws } = await setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) return first.push(options.prompt), { data: { content: "original" } };
    const r = JSON.parse(await session.tool("subagent_run", { task: "Do it" }));
    return { data: { content: "parent got: " + r.reply } };
  }, { answers: { subagentStart: { additionalContext: "START CTX" }, subagentStop: { modifiedResponse: "REWRITTEN" } } });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Go");
  assert.match(first[0], /^START CTX\n\n/);
  assert.equal(taskOf(first[0]), "Do it");
  assert.equal(ws.chat(chatId).messages.at(-1).text, "parent got: REWRITTEN");
  assert.equal(ws.state.runs[0].agents[0].result, "REWRITTEN");
});

test("a plugin's subagentStop can't keep a child going: Botkins keeps no block for it, as on Copilot", async (t) => {
  // Copilot's runtime would honor a block (test/subagent-hooks-probe-live.mjs, case "block"), but a
  // plugin's hook output passes Botkins' reading first, which keeps only modifiedResponse for this
  // event, on every harness (plugin-runtime.mjs parseHookOutput). Each extra child turn is paid for.
  const prompts = [];
  const { ws, events } = await setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) return prompts.push(options.prompt), { data: { content: "try " + prompts.length } };
    const r = JSON.parse(await session.tool("subagent_run", { task: "Work" }));
    return { data: { content: r.reply } };
  }, { answers: { subagentStop: { decision: "block", reason: "child keep going" } } });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Go");
  assert.equal(prompts.length, 1);
  assert.equal(events().filter((e) => e.event === "subagentStop").length, 1);
  assert.equal(ws.chat(chatId).messages.at(-1).text, "try 1");
});

test("a child that fails, and one that is stopped: a subagentStart and no subagentStop", async (t) => {
  const { ws, events } = await setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) {
      if (options.prompt.includes("boom")) throw new Error("child broke");
      await tick(300);
      return { data: { content: "too late" } };
    }
    const failed = JSON.parse(await session.tool("subagent_run", { task: "boom", label: "Breaks" }));
    const slow = JSON.parse(await session.tool("subagent_run", { task: "slow", label: "Slow", async: true }));
    while (!events().some((e) => e.event === "subagentStart" && e.agentId === slow.id)) await tick(5);
    const stopped = JSON.parse(await session.tool("subagent_stop", { id: slow.id }));
    return { data: { content: failed.status + ":" + stopped.status } };
  });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Go");
  await tick(400);
  assert.equal(ws.chat(chatId).messages.at(-1).text, "Failed:Stopped");
  const seen = lifecycle(events());
  assert.deepEqual(seen.map((e) => [e.event, e.agentDisplayName]), [["subagentStart", "Breaks"], ["subagentStart", "Slow"]]);
});

test("parallel children: one start and one stop each, every callback with its own child's id", async (t) => {
  const { ws, events } = await setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) {
      const task = taskOf(options.prompt);
      await tick(task === "alpha" ? 60 : 5);
      return { data: { content: "did " + task } };
    }
    const r = JSON.parse(await session.tool("subagent_run", { tasks: [{ task: "alpha", label: "A" }, { task: "beta", label: "B" }, { task: "gamma", label: "C" }] }));
    return { data: { content: r.results.map((x) => x.id).join(",") } };
  });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Go");
  const ids = ws.chat(chatId).messages.at(-1).text.split(",");
  assert.equal(new Set(ids).size, 3);
  const seen = lifecycle(events());
  for (const [label, id] of [["A", ids[0]], ["B", ids[1]], ["C", ids[2]]]) {
    const mine = seen.filter((e) => e.agentId === id);
    assert.deepEqual(mine.map((e) => e.event), ["subagentStart", "subagentStop"], label);
    assert.ok(mine.every((e) => e.agentDisplayName === label), label);
    assert.equal(mine[1].response, "did " + { A: "alpha", B: "beta", C: "gamma" }[label]);
  }
  assert.equal(seen.length, 6, "no duplicate callbacks");
});

test("no subagent hook for a plugin that is off, or a turn without plugin access", async (t) => {
  const run = async (s) => {
    const chatId = s.ws.createChat("pip");
    await s.ws.send(chatId, "Go");
    return chatId;
  };
  const reply = async (id, options, session) => {
    if (id.includes("-sub-")) return { data: { content: "child" } };
    const r = JSON.parse(await session.tool("subagent_run", { task: "x" }));
    return { data: { content: r.status } };
  };
  const off = await setup(t, reply, { enabled: false });
  assert.equal(off.ws.chat(await run(off)).messages.at(-1).text, "Done");
  assert.deepEqual(off.events(), []);
  // No plugin access: the turn has no hooks, so neither the child's session nor its lifecycle has any.
  const bare = await setup(t, reply);
  bare.ws.accessForTurn = () => ({ member: true, skills: true, mcp: true, plugins: false });
  const chatId = await run(bare);
  assert.equal(bare.ws.chat(chatId).messages.at(-1).text, "Done");
  assert.deepEqual(bare.events(), []);
  const childId = [...bare.log.sessions.keys()].find((k) => k.includes("-sub-"));
  assert.equal(bare.log.configs.get(childId).hooks, undefined);
});
