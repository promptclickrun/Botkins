import test from "node:test";
import assert from "node:assert/strict";
import { moveBot } from "../src/moveBot.ts";
import { settleChatDisplay } from "../src/chatDisplay.ts";
import { leftEmpty, newChatToReuse } from "../src/emptyChat.ts";
import { commitInterim, finishReply } from "../desktop/transcript.mjs";

test("old profiles migrate to Folded once and keep later explicit choices", () => {
  assert.equal(settleChatDisplay({steps:"every"}, false).steps, "folded");
  assert.equal(settleChatDisplay({steps:"every"}, false).foldFinishedSteps, true);
  assert.equal(settleChatDisplay({steps:"hidden"}, true).steps, "folded");
  assert.equal(settleChatDisplay({}, false).thinking, "hidden");
  assert.equal(settleChatDisplay({steps:"every", stepsPicked:true}, true).steps, "open");
  assert.equal(settleChatDisplay({steps:"every", stepsPicked:true}, true).foldFinishedSteps, false);
  assert.equal(settleChatDisplay({steps:"open", stepsPicked:true}, true).steps, "open");
  assert.equal(settleChatDisplay({steps:"open"}, true).foldFinishedSteps, false);
});

test("a drop keeps the primary and hidden bots, supports both edges and empty sections", () => {
  const bots = ["p","a","b","hidden","c"].map(id => ({id, hidden:id === "hidden", pinned:id === "c"}));
  assert.equal(moveBot(bots,"p",{pinned:true,sectionId:null}), null);
  assert.deepEqual(moveBot(bots,"a",{pinned:true,sectionId:null},"c",true).ids, ["p","b","hidden","c","a"]);
  assert.deepEqual(moveBot(bots,"c",{pinned:false,sectionId:null},"a",false).ids, ["p","c","a","b","hidden"]);
  assert.deepEqual(moveBot(bots,"a",{pinned:false,sectionId:"empty"}).flags, {pinned:false,sectionId:"empty"});
});

test("turn text before a step is kept and cumulative finals do not repeat it", () => {
  const chat = {messages:[]}, run = {id:"r", recovery:{}}, task = {stream:"First", streamTime:1};
  commitInterim(chat, run, task);
  assert.equal(task.stream,"");
  task.stream = "Second";
  finishReply(chat, run, task, "First\n\nSecond");
  assert.deepEqual(chat.messages.map(m=>[m.text,!!m.interim]), [["First",true],["Second",false]]);
});

test("a workspace stores interims and a value-free receipt across a request and restart", async t => {
  const { Workspace } = await import("./starter.mjs");
  const { fakeClient, tempDir } = await import("./fake-copilot.mjs");
  const dir = tempDir(t);
  const {client} = fakeClient(async (_id, _opts, session) => {
    const delta = text => session.emit({type:"assistant.message_delta", data:{messageId:"first", deltaContent:text}});
    delta("Before the step");
    session.emit({type:"tool.execution_start",data:{toolCallId:"s", toolName:"tool"}});
    delta("Before the request");
    await session.config().interaction.onUserInputRequest({question:"Enter a choice", choices:["A"], allowFreeform:true});
    delta("After the answer");
    return {data:{content:"After the answer"}};
  });
  const ws = new Workspace(dir, client, () => {});
  const id = ws.createChat("pip");
  ws.events.once("request", view => ws.interactions.respond(view.id, { action:"answer",value:"private test input" }));
  await ws.send(id, "Begin");
  const expected = ["Begin","Before the step","Before the request","Answered","After the answer"];
  const check = records => {
    assert.deepEqual(records.map(m => m.text), expected);
    assert.deepEqual(records.filter(m => m.interim).map(m => m.text), expected.slice(1,3));
    assert.equal(records[3].answer.runId, records[0].runId);
    assert.equal(records[3].runId, undefined);
    assert.ok(records.every(m => Number.isFinite(m.time)));
  };
  check(ws.chat(id).messages);
  check(new Workspace(dir, client, () => {}).chat(id).messages);
});

test("a repeated provider message supplies only missing deltas across a boundary", async () => {
  const { wholeMessage } = await import("../desktop/transcript.mjs");
  const chat = {messages:[]}, run = {id:"r"};
  const task = {stream:"First", sourceMessageId:"a", sourceText:"First"};
  commitInterim(chat, run, task);
  wholeMessage(task,{messageId:"a", content:"First"});
  assert.equal(task.stream,"");
  wholeMessage(task,{messageId:"a", content:"First and second"});
  finishReply(chat,run,task,"First and second");
  assert.deepEqual(chat.messages.map(m=>m.text), ["First","and second"]);
});

test("helper steps carry only an explicitly associated helper id", async () => {
  const { recordActivity } = await import("../desktop/activity.mjs");
  const { recordCanvas } = await import("../desktop/canvas.mjs");
  const run = { id:"r" };
  recordActivity(run,{type:"tool.execution_start", agentId:"child-session", data:{toolCallId:"step"}},()=>{});
  assert.equal(run.steps[0].agentId,undefined);
  recordCanvas(run,null,{}, {type:"subagent.started", data:{toolCallId:"task", instanceId:"child-session", prompt:"Read the file"}});
  assert.equal(run.steps[0].agentId,"task");
  assert.equal(run.agents[0].prompt,"Read the file");
});

test("selecting a bot opens its latest chat unless this device chose a new chat", () => {
  assert.equal(settleChatDisplay({}).botTap, "latest");
  assert.equal(settleChatDisplay({ botTap: "new" }).botTap, "new");
  for (const value of ["latest", "", "New", null, 1, undefined]) assert.equal(settleChatDisplay({ botTap: value }).botTap, "latest", String(value));
});

test("a chat nobody wrote in is archived when it is left; every other chat is kept", () => {
  const idle = { streams: {}, queued: {} };
  const chat = (more = {}) => ({ id: "c", botId: "pip", title: "New chat", time: 1, messages: [], ...more });
  assert.equal(leftEmpty(chat(), idle), true);
  // A chat this window just took out of the archive: what the window knows can still say archived.
  assert.equal(leftEmpty(chat({ archived: true }), idle), false);
  assert.equal(leftEmpty(chat({ archived: true }), idle, "", true), true, "leaving it archives it again");
  assert.equal(leftEmpty(chat({ archived: true }), idle, "typed", true), false, "typed text keeps it");
  assert.equal(leftEmpty(chat({ botIds: ["pip", "ivy"] }), idle), true, "a group nobody wrote in");
  assert.equal(leftEmpty(chat({ projectId: "p1" }), idle), true, "a project's new chat");
  assert.equal(leftEmpty(chat(), { streams: {} }), true, "a computer that sends no queue");
  // A message from the person or a bot, in the chat or only counted so far.
  assert.equal(leftEmpty(chat({ messages: [{ role: "user", text: "Hello" }] }), idle), false);
  assert.equal(leftEmpty(chat({ messages: [{ role: "assistant", text: "Hi" }] }), idle), false);
  assert.equal(leftEmpty(chat({ messages: [{ role: "command", text: "/help" }] }), idle), false);
  assert.equal(leftEmpty(chat({ count: 3 }), idle), false, "a chat whose page has not arrived from another computer");
  // Working, or with something queued.
  assert.equal(leftEmpty(chat(), { streams: { c: "" }, queued: {} }), false);
  assert.equal(leftEmpty(chat(), { streams: {}, queued: { c: [{ text: "next" }] } }), false);
  assert.equal(leftEmpty(chat(), { streams: { other: "" }, queued: { other: [{}], c: [] } }), true);
  // Not an ordinary conversation, or one the person set something on.
  assert.equal(leftEmpty(chat({ panelId: "panel" }), idle), false, "a panel's chat");
  assert.equal(leftEmpty(chat({ schedules: [{ id: 1, routine: true }] }), idle), false, "a routine's chat");
  assert.equal(leftEmpty(chat({ schedules: [{ id: 1 }] }), idle), false, "a chat with a schedule");
  assert.equal(leftEmpty(chat({ pinned: true }), idle), false);
  assert.equal(leftEmpty(chat({ archived: true }), idle), false, "already archived");
  assert.equal(leftEmpty(chat(), idle, "  half a sentence"), false, "typed text is not thrown away");
  assert.equal(leftEmpty(chat(), idle, "   "), true);
  assert.equal(leftEmpty(undefined, idle), false, "a chat that is gone");
});

test("Start a new chat reuses the bot's empty new chat, listed or archived, before making another", () => {
  const idle = { streams: {}, queued: {} };
  const chat = (id, more = {}) => ({ id, botId: "pip", title: "New chat", time: 1, messages: [], ...more });
  const talk = chat("talk", { messages: [{ role: "user", text: "Hello" }], time: 9 });
  const pick = (chats, state = idle) => newChatToReuse(chats, "pip", state)?.id;
  assert.equal(pick([talk]), undefined, "a conversation is never reused");
  assert.equal(pick([talk, chat("blank")]), "blank");
  assert.equal(pick([talk, chat("old", { archived: true, time: 2 }), chat("newer", { archived: true, time: 5 })]), "newer", "the newest archived one");
  assert.equal(pick([chat("archived", { archived: true, time: 8 }), chat("listed", { time: 1 })]), "listed", "one still in the lists comes first");
  assert.equal(pick([chat("scouts", { botId: "scout" })]), undefined, "another bot's");
  // Not the bot's plain new chat: a group, a project's chat, a panel's, a routine's, a pinned one, one that is working.
  for (const more of [{ botIds: ["pip", "ivy"] }, { projectId: "p1" }, { panelId: "panel" }, { schedules: [{ id: 1, routine: true }] }, { pinned: true }, { count: 2 }])
    assert.equal(pick([chat("no", { archived: true, ...more })]), undefined, JSON.stringify(more));
  assert.equal(pick([chat("busy")], { streams: { busy: "" }, queued: {} }), undefined);
  assert.equal(pick([chat("waiting")], { streams: {}, queued: { waiting: [{ text: "next" }] } }), undefined);
});
