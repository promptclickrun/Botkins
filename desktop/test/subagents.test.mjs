// Host-level subagents (desktop/subagents.mjs): single, parallel, async/status/wait/stop,
// Activity Island integration (run.agents + child steps), model/cwd overrides, and recursion guard.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { MAX_PARALLEL, MAX_SUBAGENTS } from "../desktop/subagents.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";

function setup(t, reply, options = {}) {
  const dir = tempDir(t);
  const fake = fakeClient(reply, options.extra);
  const ws = new Workspace(join(dir, "data"), fake.client, () => {});
  return { dir, ws, ...fake };
}
const system = (log, id) => log.configs.get(id).systemMessage.content;
/** The task a child was given: the last part of its first message (its name, mode and limits come before it). */
const taskOf = (prompt) => prompt.split("Task:\n").pop().trim();

test("top-level turns expose subagent_* tools and guidance, while subagent children cannot recurse", async (t) => {
  const { ws, log } = setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) {
      return { data: { content: "child saw: " + taskOf(options.prompt) } };
    }
    const res = JSON.parse(await session.tool("subagent_run", {
      task: "Inspect workspace",
      label: "Workspace check",
      readonly: true,
      expecting: "one line",
    }));
    return { data: { content: "parent got: " + res.reply } };
  });

  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Run a subagent check");
  const chat = ws.chat(chatId);
  const run = ws.state.runs[0];

  assert.equal(chat.messages.at(-1).text, "parent got: child saw: Inspect workspace");
  const parentTools = log.sessions.get(chatId).toolNames();
  for (const name of ["subagent_run", "subagent_status", "subagent_wait", "subagent_stop"]) {
    assert.ok(parentTools.includes(name), `parent should have ${name}`);
  }
  assert.match(system(log, chatId), /## Subagents\n/);

  const childId = [...log.sessions.keys()].find((k) => k.includes("-sub-"));
  assert.ok(childId, "child session should have been created");
  const childTools = log.sessions.get(childId).toolNames();
  assert.ok(!childTools.includes("subagent_run"), "subagent child must not get subagent_run");
  assert.ok(!childTools.includes("ask_teammate"), "subagent child must not get ask_teammate");
  // The child's system prompt is the same for every child of this bot; its name, mode and
  // expected output come with its task, in its first message.
  assert.match(system(log, childId), /isolated Botkins subagent launched by Pip/);
  assert.doesNotMatch(system(log, childId), /Workspace check|Read-only mode|one line/);
  const childPrompt = log.sent.find(([id]) => id === childId)[1];
  assert.match(childPrompt, /Subagent: Workspace check\.\nRead-only mode: [^\n]+\nExpected output: one line\.\n\nTask:\nInspect workspace$/);

  // Activity Island record on parent run
  assert.equal(run.agents.length, 1);
  assert.equal(run.agents[0].name, "Workspace check");
  assert.equal(run.agents[0].status, "Done");
  assert.equal(run.agents[0].result, "child saw: Inspect workspace");
  assert.ok(run.agents[0].finished >= run.agents[0].started);
});

test("parallel subagent_run fans out multiple children concurrently and collects all results", async (t) => {
  const seen = [];
  const { ws } = setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) {
      seen.push(taskOf(options.prompt));
      await tick(10);
      return { data: { content: "ok:" + taskOf(options.prompt) } };
    }
    const res = JSON.parse(await session.tool("subagent_run", {
      tasks: [
        { task: "task-alpha", label: "Alpha" },
        { task: "task-beta", label: "Beta" },
        { task: "task-gamma", label: "Gamma" },
      ],
    }));
    return { data: { content: res.results.map((r) => `${r.label}=${r.reply}`).join(" | ") } };
  });

  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Fan out");
  const chat = ws.chat(chatId);
  const run = ws.state.runs[0];

  assert.equal(seen.length, 3);
  assert.equal(chat.messages.at(-1).text, "Alpha=ok:task-alpha | Beta=ok:task-beta | Gamma=ok:task-gamma");
  assert.equal(run.agents.length, 3);
  assert.deepEqual(run.agents.map((a) => a.status), ["Done", "Done", "Done"]);
});

test("sibling subagents share a byte-identical system prompt; each one's own text is in its first message", async (t) => {
  // Children started side by side share the start of their requests (tools, then the system
  // prompt), which a model caches once for all of them: nothing per child may be in it.
  const { ws, log } = setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) return { data: { content: "done" } };
    await session.tool("subagent_run", {
      tasks: [
        { task: "Read the logs", label: "Logs", readonly: true, expecting: "three lines" },
        { task: "Fix the typo", label: "Typo", constraints: "touch only README.md" },
        { task: "Count the files" },
      ],
    });
    return { data: { content: "ok" } };
  });
  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Fan out");
  const children = [...log.sessions.keys()].filter((id) => id.includes("-sub-"));
  assert.equal(children.length, 3);
  const prompts = children.map((id) => system(log, id));
  assert.ok(prompts.every((prompt) => prompt === prompts[0]), "every child's system prompt is the same, byte for byte");
  assert.doesNotMatch(prompts[0], /Logs|Typo|Read-only mode|three lines|README/);
  const firsts = children.map((id) => log.sent.find(([sent]) => sent === id)[1]).sort();
  assert.deepEqual(firsts.map((prompt) => prompt.slice(prompt.indexOf("Subagent:"))), [
    "Subagent: Logs.\nRead-only mode: inspect and report only; do not modify files, run mutating commands, or perform external writes.\nExpected output: three lines.\n\nTask:\nRead the logs",
    "Subagent: Subagent 3.\n\nTask:\nCount the files",
    "Subagent: Typo.\nConstraints: touch only README.md.\n\nTask:\nFix the typo",
  ].sort());
});

test("async subagent_run supports status, wait, and stop", async (t) => {
  const { ws } = setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) {
      if (options.prompt.includes("slow-stop")) {
        await tick(200);
        return { data: { content: "should be aborted" } };
      }
      await tick(25);
      return { data: { content: "async-done" } };
    }
    const fast = JSON.parse(await session.tool("subagent_run", { task: "fast-job", label: "Fast", async: true }));
    assert.equal(fast.async, true);
    assert.equal(fast.status, "Running");

    const slow = JSON.parse(await session.tool("subagent_run", { task: "slow-stop", label: "Slow", async: true }));
    const st = JSON.parse(await session.tool("subagent_status", {}));
    assert.equal(st.subagents.length, 2);

    const stopped = JSON.parse(await session.tool("subagent_stop", { id: slow.id }));
    assert.equal(stopped.status, "Stopped");

    const waited = JSON.parse(await session.tool("subagent_wait", { id: fast.id }));
    assert.equal(waited.status, "Done");
    assert.equal(waited.reply, "async-done");

    return { data: { content: `${waited.status}:${stopped.status}` } };
  });

  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Async lifecycle");
  assert.equal(ws.chat(chatId).messages.at(-1).text, "Done:Stopped");
  const run = ws.state.runs[0];
  assert.equal(run.agents.length, 2);
  assert.equal(run.agents.find((a) => a.name === "Fast").status, "Done");
  assert.equal(run.agents.find((a) => a.name === "Slow").detail, "Cancelled");
});

test("subagent_run validates cwd override, unknown models, and parallel/total limits", async (t) => {
  const { dir, ws, log } = setup(t, async (id, options, session) => {
    if (id.includes("-sub-")) return { data: { content: "cwd-ok" } };
    const subDir = join(dir, "custom-cwd");
    mkdirSync(subDir, { recursive: true });

    await assert.rejects(
      () => session.tool("subagent_run", { task: "x", cwd: join(dir, "does-not-exist") }),
      /does not exist/,
    );
    await assert.rejects(
      () => session.tool("subagent_run", { task: "x", model: "nope/not-a-real-model" }),
      /Unknown subagent model/,
    );
    await assert.rejects(
      () => session.tool("subagent_run", { tasks: Array.from({ length: MAX_PARALLEL + 1 }, (_, i) => ({ task: `t${i}` })) }),
      new RegExp(`at most ${MAX_PARALLEL}`),
    );

    const ok = JSON.parse(await session.tool("subagent_run", { task: "check cwd", label: "CWD check", cwd: subDir }));
    return { data: { content: ok.reply } };
  });

  const chatId = ws.createChat("pip");
  await ws.send(chatId, "Validate options");
  assert.equal(ws.chat(chatId).messages.at(-1).text, "cwd-ok");
  const childId = [...log.configs.keys()].find((k) => k.includes("-sub-"));
  assert.equal(log.configs.get(childId).workingDirectory, join(dir, "custom-cwd"));
  assert.ok(MAX_SUBAGENTS >= MAX_PARALLEL);
});
