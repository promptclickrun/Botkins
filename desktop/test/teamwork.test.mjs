// Teamwork (desktop/teamwork.mjs) and message mentions (desktop/mentions.mjs), with fake Copilot sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { helperSessionId, MAX_ASKS } from "../desktop/teamwork.mjs";
import { listFiles } from "../desktop/mentions.mjs";
import { memberSessionId } from "../desktop/groups.mjs";
import { fakeClient, tempDir, tick } from "./fake-copilot.mjs";

function setup(t, reply, options = {}) {
  const dir = tempDir(t);
  const fake = fakeClient(reply, options.extra);
  const ws = new Workspace(join(dir, "data"), fake.client, () => {});
  return { dir, ws, ...fake };
}
const system = (log, id) => log.configs.get(id).systemMessage.content;

test("a bot is told about its team and gets ask_teammate only where Teamwork applies", async (t) => {
  const { ws, log } = setup(t);
  const chat = ws.createChat("pip");
  await ws.send(chat, "Hi");
  assert.match(system(log, chat), /## Your team\nYou're Pip\.[\s\S]*- Scout: Research partner\.\n- Patch: Coding companion\./);
  assert.match(system(log, chat), /ask_teammate/);
  assert.ok(log.sessions.get(chat).toolNames().includes("ask_teammate"));
  // A bot kept out of Teamwork is neither listed nor able to ask.
  ws.agents.setBotFlags("patch", { teamwork: false });
  ws.agents.setBotFlags("scout", { hidden: true });
  assert.deepEqual(ws.teamwork.roster(ws.bot("pip"), ws.chat(chat)), [], "a hidden bot and one that opted out leave nobody to ask");
  ws.agents.setBotFlags("scout", { hidden: false });
  assert.deepEqual(ws.teamwork.roster(ws.bot("pip"), ws.chat(chat)).map((b) => b.id), ["scout"]);
  assert.deepEqual(ws.teamwork.roster(ws.bot("patch"), ws.chat(ws.createChat("patch"))), []);
  // The app-wide switch.
  ws.setPreferences({ teamwork: false });
  const off = ws.createChat("pip");
  await ws.send(off, "Hi");
  assert.doesNotMatch(system(log, off), /Your team/);
  assert.ok(!log.sessions.get(off).toolNames().includes("ask_teammate"));
  ws.setPreferences({ teamwork: true });
  ws.agents.setBotFlags("patch", { teamwork: true });
  // A group chat already has its bots in the room.
  const group = ws.createGroupChat(["pip", "scout"]);
  await ws.send(group, "Hello both");
  assert.doesNotMatch(system(log, memberSessionId(ws.chat(group), "pip")), /Your team/);
  assert.ok(!log.sessions.get(memberSessionId(ws.chat(group), "pip")).toolNames().includes("ask_teammate"));
  // A panel refresh doesn't bring anyone in.
  assert.deepEqual(ws.teamwork.tools(ws.bot("pip"), ws.chat(chat), { id: "r", panelId: "p" }, {}), []);
  // In a project chat, only bots that may use the project can be asked.
  const project = ws.projects.create({ name: "Migration" });
  ws.setPreferences({ access: { allBots: false } });
  ws.access.setBotAccess("pip", { all: true });
  ws.access.setBotAccess("scout", { projects: [project] });
  const inProject = ws.chat(ws.createChat("pip"));
  ws.projects.setChatProject(inProject.id, project);
  assert.deepEqual(ws.teamwork.roster(ws.bot("pip"), inProject).map((b) => b.id), ["scout"]);
});

test("asking a teammate runs it in its own session and returns its reply to the asker", async (t) => {
  let ws;
  const ctx = setup(t, async (id, options, session) => {
    if (id.includes("-team-")) return { data: { content: "Scout found 3 sources for: " + options.prompt.split("\n")[1] } };
    // The asker calls its tool mid-turn, the way the model would.
    const result = JSON.parse(await session.tool("ask_teammate", { teammate: "@scout", message: "Find sources on tide tables", expecting: "three links" }));
    return { data: { content: "With Scout's help: " + result.reply } };
  });
  ws = ctx.ws;
  const { log } = ctx;
  const id = ws.createChat("pip");
  await ws.send(id, "Research tide tables");
  const chat = ws.chat(id);
  const helper = helperSessionId(chat, "scout");
  assert.equal(chat.messages.at(-1).text, "With Scout's help: Scout found 3 sources for: Find sources on tide tables");
  // The teammate got only the message written for it, in its own session, as itself.
  const sent = log.sent.find((s) => s[0] === helper)[1];
  assert.equal(sent, "Message from Pip (Everyday helper):\nFind sources on tide tables\n\nWhat they need back: three links");
  assert.doesNotMatch(sent, /Research tide tables/, "the chat itself is not passed on");
  assert.match(system(log, helper), /^You are Scout, Research partner\./);
  assert.match(system(log, helper), /Your teammate Pip \(Everyday helper\) is asking for your help/);
  assert.doesNotMatch(system(log, helper), /Your team\n|today_\* tools/, "a helper has no team of its own and no dashboard tools");
  assert.deepEqual(log.sessions.get(helper).toolNames(), ["memory_read", "profile_read", "wiki_search", "wiki_read"], "a helper reads its memory and the wiki, and changes nothing");
  // What the turn recorded for the chat to show.
  const [ask] = ws.state.runs[0].teamwork;
  assert.deepEqual(
    { botId: ask.botId, fromBotId: ask.fromBotId, message: ask.message, expecting: ask.expecting, status: ask.status, reply: ask.reply },
    { botId: "scout", fromBotId: "pip", message: "Find sources on tide tables", expecting: "three links", status: "answered", reply: "Scout found 3 sources for: Find sources on tide tables" },
  );
  assert.ok(ask.finished >= ask.started);
  assert.deepEqual(chat.helpers.scout, { established: true, sessionProvider: "copilot" });
  assert.equal(ws.state.runs[0].status, "Completed");
  // A second turn asks the same teammate again: its session for this chat continues.
  await ws.send(id, "And tide charts");
  assert.deepEqual(log.created.filter((x) => x === helper).length, 1);
  assert.deepEqual(log.resumed.filter((x) => x === helper).length, 1);
  // Deleting the chat removes the teammate's session with it.
  await ws.agents.deleteChat(id);
  assert.deepEqual(log.deleted.sort(), [helper, id].sort());
});

test("a stalled teammate recovers its completed journal reply before failing the ask", async (t) => {
  let helperEventId;
  const ctx = setup(
    t,
    async (id, _options, session) => {
      if (id.includes("-team-")) return { data: { content: "unused" } };
      const ask = JSON.parse(await session.tool("ask_teammate", { teammate: "Scout", message: "Recover this" }));
      return { data: { content: "Recovered: " + ask.reply } };
    },
    {
      extra: {
        send: async (id, _options, session) => {
          if (!id.includes("-team-")) {
            const messageId = id + ":request";
            session.emit({ type: "user.message", id: id + ":root", data: { messageId } });
            const keepAlive = setInterval(() => session.emit({ type: "assistant.intent", data: { intent: "Waiting for Scout" } }), 5);
            try {
              const ask = JSON.parse(await session.tool("ask_teammate", { teammate: "Scout", message: "Recover this" }));
              session.emit({ type: "assistant.message", data: { originatingMessageId: messageId, content: "Recovered: " + ask.reply } });
              session.emit({ type: "session.idle", data: { mode: "interactive" } });
              return messageId;
            } finally {
              clearInterval(keepAlive);
            }
          }
          helperEventId = id + ":root";
          session.emit({ type: "user.message", id: helperEventId, data: { messageId: id + ":request" } });
          throw Object.assign(new Error("simulated inactivity stall"), { code: "BOTKINS_SESSION_STALL" });
        },
        events: (id) => id.includes("-team-") ? [
          { type: "user.message", id: helperEventId, data: { messageId: id + ":request" } },
          { type: "assistant.message", data: { originatingMessageId: id + ":request", content: "Journal answer" } },
          { type: "assistant.turn_end", data: {} },
        ] : [],
      },
    },
  );
  const id = ctx.ws.createChat("pip");
  await ctx.ws.send(id, "Ask Scout");
  await tick(50);
  assert.equal(ctx.ws.chat(id).messages.at(-1).text, "Recovered: Journal answer");
  assert.equal(ctx.ws.state.runs[0].teamwork[0].status, "answered");
  assert.equal(ctx.ws.state.runs[0].status, "Completed");
  assert.deepEqual(ctx.log.aborted, [], "a recovered helper is not aborted");
});

test("a teammate's tool use, approvals and questions stay tied to the chat that asked", async (t) => {
  let ws;
  const seen = {};
  const ctx = setup(t, async (id, options, session) => {
    if (id.includes("-team-")) {
      session.emit({ type: "assistant.intent", data: { intent: "Searching the web" } });
      seen.intent = ws.state.runs[0].teamwork[0].intent;
      seen.status = ws.state.runs[0].teamwork[0].status;
      session.emit({ type: "tool.execution_start", data: { toolCallId: "t1", toolName: "web_fetch", arguments: { url: "https://example.com" } } });
      session.emit({ type: "tool.execution_complete", data: { toolCallId: "t1", success: true, result: { content: "page" } } });
      session.emit({ type: "tool.execution_start", data: { toolCallId: "t2", toolName: "write", arguments: { path: "research.txt" } } });
      writeFileSync(join(ws.dir, "files", "scout", "research.txt"), "Notes from Scout");
      session.emit({ type: "tool.execution_complete", data: { toolCallId: "t2", success: true } });
      session.emit({ type: "assistant.usage", data: { inputTokens: 500, outputTokens: 20, model: "helper-model" } });
      // The helper needs approval for a shell command: it is asked in the asking chat, as the helper.
      const sdkResult = session.config().permissions.onRequest({ kind: "shell", fullCommandText: "curl x", intention: "Fetch" }, {});
      await tick();
      const request = ws.interactions.snapshot()[0];
      seen.request = { chatId: request.chatId, botId: request.botId };
      ws.interactions.respond(request.id, { action: "approve" });
      seen.approval = await sdkResult;
      // It can't put a question to the person.
      try {
        await session.config().interaction.onUserInputRequest({ question: "Which year?" });
      } catch (error) {
        seen.question = error.message;
      }
      return { data: { content: "Done" } };
    }
    await session.tool("ask_teammate", { teammate: "Scout", message: "Look it up" });
    session.emit({ type: "assistant.usage", data: { inputTokens: 100, outputTokens: 10, model: "asker-model" } });
    return { data: { content: "Answer" } };
  });
  ws = ctx.ws;
  const id = ws.createChat("pip");
  await ws.send(id, "Go");
  assert.equal(seen.status, "working");
  assert.equal(seen.intent, "Searching the web");
  assert.deepEqual(seen.request, { chatId: id, botId: "scout" });
  assert.equal(seen.approval.kind, "approve-once");
  assert.match(seen.question, /can't ask the person from here/);
  const run = ws.state.runs[0];
  const [ask] = run.teamwork;
  assert.deepEqual(ask.steps.map((s) => [s.name, s.status]), [["web_fetch", "Done"], ["write", "Done"]]);
  assert.deepEqual(ws.artifacts.list({ botId: "pip", chatId: id }).items.map((file) => [file.name, file.messageIndex]), [["research.txt", 0]]);
  assert.equal(ask.intent, undefined, "the live status is cleared when the teammate finishes");
  assert.equal(run.steps, undefined, "the teammate's tools are not listed as the asker's");
  assert.deepEqual([run.usage.input, run.usage.output, run.usage.model], [600, 30, "asker-model"], "its tokens count toward the turn, under the asker's model");
});

test("asks are limited, never repeated, fail clearly, and stop with the turn", async (t) => {
  let ws, mode;
  const errors = [];
  const ctx = setup(t, async (id, options, session) => {
    if (id.includes("-team-")) {
      if (mode === "fail") throw new Error("model overloaded");
      if (mode === "hang") await new Promise((resolve) => (session.onAbort = resolve));
      return { data: { content: mode === "empty" ? "" : "ok" } };
    }
    const ask = async (args) => {
      try {
        return await session.tool("ask_teammate", args);
      } catch (error) {
        errors.push(error.message);
      }
    };
    if (mode === "limits") {
      await ask({ teammate: "Nobody", message: "x" });
      await ask({ teammate: "Scout", message: "  " });
      await ask({ teammate: "Scout", message: "Same" });
      await ask({ teammate: "Scout", message: "Same" });
      for (let i = 0; i < MAX_ASKS; i++) await ask({ teammate: "Patch", message: "Part " + i });
    } else await ask({ teammate: "Scout", message: "Help" });
    return { data: { content: "Answer" } };
  });
  ws = ctx.ws;
  const id = ws.createChat("pip");
  mode = "limits";
  await ws.send(id, "Go");
  assert.match(errors[0], /No teammate is named “Nobody”\. Your teammates: Scout, Patch\./);
  assert.match(errors[1], /Write the message for Scout/);
  assert.match(errors[2], /already sent Scout this exact message/);
  assert.match(errors[3], /up to 8 times in one reply/);
  assert.equal(errors.length, 4);
  assert.equal(ws.state.runs[0].teamwork.length, MAX_ASKS);
  // A teammate that fails or says nothing is reported to the asker, and the turn goes on.
  for (const [kind, pattern] of [["fail", /Scout couldn't answer: model overloaded/], ["empty", /Scout couldn't answer: no reply came back/]]) {
    errors.length = 0;
    mode = kind;
    await ws.send(id, "Again " + kind);
    assert.match(errors[0], pattern);
    assert.equal(ws.state.runs[0].teamwork[0].status, "failed");
    assert.equal(ws.state.runs[0].status, "Completed");
  }
  // Stopping the turn stops the teammate.
  mode = "hang";
  errors.length = 0;
  const turn = ws.send(id, "Slow one");
  await tick(10);
  assert.equal(ws.state.runs[0].teamwork[0].status, "working");
  await ws.stop(id);
  await turn;
  assert.ok(ctx.log.aborted.includes(helperSessionId(ws.chat(id), "scout")));
  assert.equal(ws.state.runs[0].teamwork[0].status, "stopped");
  assert.equal(ws.state.runs[0].status, "Stopped");
  // Outside a live turn the tool refuses.
  const stale = ws.teamwork.tools(ws.bot("pip"), ws.chat(id), { id: "r" }, { stopped: false })[0];
  await assert.rejects(stale.handler({ teammate: "Scout", message: "x" }), /no longer active/);
});

test("the composer is offered the projects, wiki pages and workspace files this chat's bots may use", (t) => {
  const { ws, dir } = setup(t);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, "src", "main.ts"), "x");
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "x");
  writeFileSync(join(repo, ".git", "config"), "x");
  const project = ws.projects.create({ name: "Mail migration", folder: repo });
  const other = ws.projects.create({ name: "Internal" });
  const files = join(dir, "data", "files", "pip");
  mkdirSync(join(files, "reports"), { recursive: true });
  writeFileSync(join(files, "reports", "q3.md"), "report");
  writeFileSync(join(files, "old.txt"), "old");
  writeFileSync(join(files, ".secret"), "hidden");
  utimesSync(join(files, "old.txt"), new Date(1000), new Date(1000));
  const chat = ws.createChat("pip");
  ws.projects.setChatProject(chat, project);
  const found = ws.mentions.candidates(chat);
  assert.equal("customers" in found, false, "there are no customers to mention");
  assert.deepEqual(found.projects.map((p) => [p.name, p.hint, p.current]), [["Mail migration", "repo", true], ["Internal", "", false]], "a coding project shows its folder");
  assert.deepEqual(found.files.map((f) => [f.name, f.folder, f.where]).sort(), [["main.ts", "src", "Project folder"], ["old.txt", "", "Bot files"], ["q3.md", "reports", "Bot files"]]);
  assert.equal(found.files.at(-1).name, "old.txt", "newest first");
  assert.deepEqual(found.bots, []);
  // Before a chat exists the bot alone decides.
  assert.deepEqual(ws.mentions.candidates(undefined, "pip").files.map((f) => f.name).sort(), ["old.txt", "q3.md"]);
  // Access: with app-wide access off, only what every bot in the chat may use is offered.
  ws.setPreferences({ access: { allBots: false } });
  ws.access.setBotAccess("pip", { projects: [project] });
  const limited = ws.mentions.candidates(chat);
  assert.deepEqual(limited.projects.map((p) => p.name), ["Mail migration"], "only the granted project is offered");
  void other;
  // A group chat offers its members to "@" and no files.
  ws.setPreferences({ access: { allBots: true } });
  const group = ws.mentions.candidates(ws.createGroupChat(["pip", "scout"]));
  assert.deepEqual(group.bots.map((b) => b.name), ["Pip", "Scout"]);
  assert.deepEqual(group.files, []);
  assert.deepEqual(listFiles(join(dir, "nowhere"), "x"), []);
});

test("mentioned records reach the model as text and files, stay on the message, and respect access", async (t) => {
  const { ws, dir, log } = setup(t);
  const project = ws.projects.create({ name: "Mail migration", description: "Move 400 mailboxes" });
  const other = ws.projects.create({ name: "Internal" });
  ws.projects.addTodo(project, "Inventory mailboxes");
  const files = join(dir, "data", "files", "pip");
  mkdirSync(files, { recursive: true });
  const report = join(files, "report.md");
  writeFileSync(report, "# Report");
  const chat = ws.createChat("pip");
  await ws.send(chat, "Summarise #Mail migration and #Internal using #report.md", {
    mentions: [{ kind: "project", id: project }, { kind: "project", id: other }, { kind: "file", path: report }, { kind: "project", id: project }],
  });
  const [, prompt, options] = log.sent[0];
  assert.match(prompt, /^Summarise #Mail migration and #Internal using #report\.md\n\n\[Records the person mentioned\]\n#Mail migration is a project\.\nDescription: Move 400 mailboxes\nOpen to-dos \(1\): Inventory mailboxes/);
  assert.doesNotMatch(prompt, /customer/i);
  assert.match(prompt, /#report\.md is a file at .*report\.md \(attached\)\./);
  assert.deepEqual(options.attachments.map((a) => [a.type, a.displayName]), [["file", "report.md"]]);
  const message = ws.chat(chat).messages[0];
  assert.equal(message.text, "Summarise #Mail migration and #Internal using #report.md", "the message keeps what the person typed");
  assert.deepEqual(message.mentions.map((m) => [m.kind, m.label]), [["project", "Mail migration"], ["project", "Internal"], ["file", "report.md"]]);
  assert.equal(message.attachments, undefined, "a mentioned file is not listed as an attachment");
  // Retrying sends the same records again; one that has since been deleted is dropped.
  ws.state.runs[0].status = "Needs you";
  ws.projects.remove(other);
  await ws.retry(ws.state.runs[0].id);
  assert.deepEqual(ws.chat(chat).messages.at(-2).mentions.map((m) => m.label), ["Mail migration", "report.md"]);
  // Refusals: unknown or deleted records, too many, files outside the workspace (even through a link).
  const refuse = (mentions, pattern) => assert.throws(() => ws.send(chat, "x", { mentions }), pattern);
  refuse([{ kind: "customer", id: "gone" }], /Unknown mention/);
  refuse([{ kind: "project", id: "gone" }], /project no longer exists/);
  refuse([{ kind: "team", id: "x" }], /Unknown mention/);
  refuse(Array.from({ length: 13 }, () => ({ kind: "project", id: project })), /up to 12 records/);
  refuse([{ kind: "file", path: join(dir, "data", "workspace.json") }], /Only files in this bot's workspace/);
  refuse([{ kind: "file", path: join(files, "missing.md") }], /no longer exists: missing\.md/);
  writeFileSync(join(dir, "outside.txt"), "private");
  symlinkSync(join(dir, "outside.txt"), join(files, "link.txt"));
  refuse([{ kind: "file", path: join(files, "link.txt") }], /Only files in this bot's workspace/);
  assert.equal(ws.active.size, 0, "a refused message starts nothing");
  // Access is checked for every bot that answers.
  const fabrikam = ws.projects.create({ name: "Fabrikam" });
  ws.setPreferences({ access: { allBots: false } });
  ws.access.setBotAccess("pip", { projects: [fabrikam] });
  refuse([{ kind: "project", id: project }], /Pip doesn't have access to the project “Mail migration”/);
  await ws.send(chat, "About #Fabrikam", { mentions: [{ kind: "project", id: fabrikam }] });
  ws.setPreferences({ access: { allBots: true } });
  // A group chat passes the records to every member and takes no files.
  const group = ws.createGroupChat(["pip", "scout"]);
  assert.throws(() => ws.send(group, "x", { mentions: [{ kind: "file", path: report }] }), /Group chats take text only/);
  await ws.send(group, "Thoughts on #Fabrikam?", { mentions: [{ kind: "project", id: fabrikam }] });
  for (const member of ["pip", "scout"])
    assert.match(log.sent.find((s) => s[0] === memberSessionId(ws.chat(group), member))[1], /Person: Thoughts on #Fabrikam\?\n\n\[Records the person mentioned\]\n#Fabrikam is a project\./);
  // A message waiting behind a running turn keeps its mentions.
  ws.active.set(chat, { stopped: false });
  assert.equal(ws.submit(chat, "Later #Mail migration", { mentions: [{ kind: "project", id: project }] }), null);
  assert.throws(() => ws.submit(chat, "x", { mentions: [{ kind: "project", id: "gone" }] }), /no longer exists/);
  ws.active.delete(chat);
  ws.drain(chat);
  await tick(5);
  assert.deepEqual(ws.chat(chat).messages.findLast((m) => m.role === "user").mentions.map((m) => m.label), ["Mail migration"]);
});
