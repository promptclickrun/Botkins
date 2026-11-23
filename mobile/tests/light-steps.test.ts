// Light steps ("step-details-v1"): a client that asks for them follows a chat without the long
// inputs and outputs of its steps, which are most of a long turn's bytes, and reads one step's when
// it is opened (`link.step`). A client that doesn't ask gets them whole, from the same computer.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { activitySteps } from "../link-host/activity-steps.mjs";
import { LIGHT_STEP_TEXT, lightPart, lightRun, stepDetail } from "../link-host/parts.mjs";
import { authorize, TEAM_METHODS } from "../link-host/team.mjs";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { ChatDetail, Run, Step, StepDetail } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const long = (label: string, size = 3000) => (label + " ").repeat(Math.ceil(size / (label.length + 1))).slice(0, size);
const step = (id: string, more: Partial<Step> = {}): Step => ({ id, name: "bash", label: "Ran a command", status: "Done", started: 1, finished: 2, input: long("in-" + id), output: long("out-" + id), ...more });

test("activity groups background commands after light transfer and shows the newest calls first", () => {
  const shell = step("background", { input: JSON.stringify({ command: long("build"), mode: "async" }) });
  const run = {
    agents: [{ id: "agent" }],
    steps: [
      step("new", { started: 5 }), shell, step("agent"), step("child", { agentId: "agent" }),
      step("old", { started: 2 }), step("tie", { started: 5 }),
    ],
  };
  const light = lightRun(run);
  assert.equal(light.steps[1].input, undefined);
  const feed = activitySteps<Step>(light.steps, light.agents);
  assert.deepEqual(feed.tools.map((step) => step.id), ["tie", "new", "old"]);
  assert.deepEqual(feed.background.map((step) => step.id), ["background"]);
  assert.deepEqual(feed.byAgent.get("agent")?.map((step) => step.id), ["child", "agent"]);
  assert.equal(run.steps[1], shell);
});

test("a light step keeps what a chat draws and says there is more", () => {
  const run = {
    id: "r1",
    chatId: "c1",
    status: "Completed",
    agents: [{ id: "helper", name: "explorer", status: "Done", started: 1 }],
    steps: [
      step("big"),
      step("small", { input: '{"query":"launch"}', output: "3 pages" }),
      step("half", { input: '{"path":"a.ts"}' }),
      step("asked", { name: "ask_user", input: JSON.stringify({ question: long("Which one", 900) }) }),
      step("helper", { name: "task" }),
      step("bare", { input: undefined, output: undefined }),
    ],
    teamwork: [{ id: "t1", steps: [step("team")] }],
  };
  const light = lightRun(run) as any;
  const by = Object.fromEntries(light.steps.map((s: Step) => [s.id, s]));
  // Long input and output go, and the step says so.
  assert.deepEqual(by.big, { id: "big", name: "bash", label: "Ran a command", status: "Done", started: 1, finished: 2, more: true });
  // Short ones stay as they are.
  assert.equal(by.small.input, '{"query":"launch"}');
  assert.equal(by.small.output, "3 pages");
  assert.equal(by.small.more, undefined);
  // A short input beside a long output stays; the output is fetched.
  assert.equal(by.half.input, '{"path":"a.ts"}');
  assert.equal(by.half.output, undefined);
  assert.equal(by.half.more, true);
  // A question the chat reads from the step, and the step that started a helper, stay whole.
  assert.equal(by.asked.input, run.steps[3].input);
  assert.equal(by.helper.output, run.steps[4].output);
  assert.equal(by.bare.more, undefined);
  assert.equal(light.teamwork[0].steps[0].more, true);
  assert.equal(light.teamwork[0].steps[0].output, undefined);
  // The run itself is untouched, and so is a run with no steps.
  assert.ok(run.steps[0].input!.length > LIGHT_STEP_TEXT);
  const plain = { id: "r2", status: "Completed" };
  assert.equal(lightRun(plain), plain);
  // A chat's page and a run part both go through lightPart.
  assert.equal((lightPart({ id: "c1", from: 0, total: 1, messages: [], runs: [run] }) as any).runs[0].steps[0].more, true);
  assert.equal((lightPart(run) as any).steps[0].more, true);
  assert.equal(lightPart(null), null);
});

test("a step's detail is read by chat, run and step, and only from that chat", () => {
  const state = { runs: [{ id: "r1", chatId: "c1", steps: [step("s1", { output: "x".repeat(9000) })], teamwork: [{ id: "t1", steps: [step("s2")] }] }] };
  const detail = stepDetail(state, "c1", "r1", "s1")!;
  assert.equal(detail.input, state.runs[0].steps[0].input);
  // Cut as a whole step always was.
  assert.equal(detail.output!.length, 4001);
  assert.ok(stepDetail(state, "c1", "r1", "s2")!.input);
  assert.equal(stepDetail(state, "c2", "r1", "s1"), null, "another chat's id reads nothing");
  assert.equal(stepDetail(state, "c1", "r1", "nope"), null);
  assert.equal(stepDetail(state, "c1", "nope", "s1"), null);
  assert.equal(stepDetail({}, "c1", "r1", "s1"), null);
});

test("a member reads a step only in a chat they may read", () => {
  assert.deepEqual(TEAM_METHODS["link.step"], TEAM_METHODS["link.messages"]);
  const team = { roles: [{ id: "r_one", name: "One", perms: { agents: ["view", "chat"], today: [], skills: [], mcp: [], plugins: [], settings: [] }, bots: ["bot-a"] }], groups: [{ id: "g", name: "G", roleId: "r_one" }], members: [{ id: "m_1", name: "Sam", groupId: "g" }] };
  const member = { kind: "member", memberId: "m_1", name: "Sam", groupId: "g" };
  const chats: Record<string, unknown> = { mine: { id: "mine", botId: "bot-a", createdBy: "m_1" }, theirs: { id: "theirs", botId: "bot-b" } };
  const lookups = { chat: (id: string) => chats[id], bot: (id: string) => ({ id }) };
  assert.equal(authorize(member, team, "link.step", ["mine", "r", "s"], lookups), authorize(member, team, "link.messages", ["mine", 0, 60], lookups));
  assert.notEqual(authorize(member, team, "link.step", ["theirs", "r", "s"], lookups), "");
  assert.equal(authorize({ kind: "owner" }, team, "link.step", ["theirs", "r", "s"], lookups), "");
});

/** A computer whose first chat has a finished turn of heavy steps, and a client that follows it. */
async function withChat() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-light-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const chat = backend.state.chats[0];
  const run = { id: "run-heavy", chatId: chat.id, title: "Heavy", time: 1, status: "Completed", detail: "", finished: 2, steps: Array.from({ length: 40 }, (_, i) => step("s" + i)) };
  backend.state.runs.unshift(run);
  chat.messages.push({ role: "user", text: "Do the heavy thing", runId: run.id, time: 1 }, { role: "assistant", text: "Done.", runId: run.id, time: 2 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false });
  await link.setEnabled(true);
  const clients: LinkClient[] = [];
  const follow = async (lightSteps: boolean) => {
    const paired = await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: lightSteps ? "New phone" : "Older phone", platform: "ios" });
    const parts: Record<string, unknown> = {};
    const client = new LinkClient(paired, { fetch: real, lightSteps, onState() {}, onParts: (next) => void Object.assign(parts, next) });
    clients.push(client);
    client.start();
    client.watch([chat.id]);
    const until = async (check: () => boolean) => {
      for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(check(), "the part arrived");
    };
    await until(() => !!parts["chat:" + chat.id]);
    return { client, parts, until };
  };
  return { link, backend, chat, run, follow, stop: async () => (clients.forEach((client) => client.stop()), await link.stop()) };
}

test("one computer serves light steps to a phone that asks and whole steps to one that doesn't", async () => {
  const { link, backend, chat, run, follow, stop } = await withChat();
  try {
    assert.ok(link.meta().capabilities.includes("step-details-v1"));
    const light = await follow(true);
    const whole = await follow(false);
    const steps = (parts: Record<string, unknown>) => (parts["chat:" + chat.id] as ChatDetail).runs.find((r) => r.id === run.id)!.steps!;
    assert.ok(steps(light.parts).every((s) => s.more && s.input === undefined && s.output === undefined));
    assert.ok(steps(whole.parts).every((s) => !s.more && s.input!.length === 3000 && s.output!.length === 3000));
    // The page is a small part of what it was.
    const size = (parts: Record<string, unknown>) => JSON.stringify(parts["chat:" + chat.id]).length;
    assert.ok(size(light.parts) * 10 < size(whole.parts), size(light.parts) + " against " + size(whole.parts));
    // Opening a step reads it, cut as before; a step that isn't there reads nothing.
    const detail = await light.client.call<StepDetail>("link.step", chat.id, run.id, "s3");
    assert.deepEqual(detail, { input: run.steps[3].input, output: run.steps[3].output });
    assert.equal(await light.client.call("link.step", chat.id, run.id, "gone"), null);
    assert.equal(await light.client.call("link.step", backend.state.chats[1].id, run.id, "s3"), null);
    // Earlier pages come in the form the session follows in.
    const lightPage = await light.client.call<ChatDetail>("link.messages", chat.id, chat.messages.length, 60);
    const wholePage = await whole.client.call<ChatDetail>("link.messages", chat.id, chat.messages.length, 60);
    assert.equal(lightPage.runs.find((r) => r.id === run.id)!.steps![0].more, true);
    assert.equal(wholePage.runs.find((r) => r.id === run.id)!.steps![0].input!.length, 3000);
    // A turn under way: its run part is light too, and a change reaches both phones in their own form.
    await light.client.call("send", chat.id, "plan the launch", {});
    const working: Run = { id: "run-now", chatId: chat.id, title: "Now", time: 3, status: "Working", detail: "", steps: [step("n1", { status: "Running", finished: undefined, output: undefined })] } as Run;
    backend.state.runs.unshift(working);
    backend.changed();
    const live = (parts: Record<string, unknown>) => parts["run:" + chat.id] as Run | undefined;
    await light.until(() => live(light.parts)?.id === "run-now");
    await whole.until(() => live(whole.parts)?.id === "run-now");
    assert.equal(live(light.parts)!.steps![0].more, true);
    assert.equal(live(light.parts)!.steps![0].input, undefined);
    assert.equal(live(whole.parts)!.steps![0].input!.length, 3000);
  } finally {
    await stop();
  }
});
