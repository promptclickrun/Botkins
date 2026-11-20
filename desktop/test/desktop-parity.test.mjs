import test from "node:test";
import assert from "node:assert/strict";
import { moveBot } from "../src/moveBot.ts";
import { settleChatDisplay } from "../src/chatDisplay.ts";
import { commitInterim, finishReply } from "../desktop/transcript.mjs";

test("old profiles migrate to Folded once and keep later explicit choices", () => {
  assert.equal(settleChatDisplay({steps:"every"}, false).steps, "folded");
  assert.equal(settleChatDisplay({}, false).thinking, "hidden");
  assert.equal(settleChatDisplay({steps:"every", stepsPicked:true}, true).steps, "every");
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
