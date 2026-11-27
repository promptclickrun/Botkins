// A project's jobs ("project-jobs-v1") on the phone: where a job stands, the batch the person writes, the link's
// shapes and policy, and the demo end to end. Also the Tasks page as a pipeline (overview.ts).
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LinkHost } from "../link-host/index.mjs";
import { jobArgs, JOB_METHODS, REMOTE_METHODS } from "../link-host/methods.mjs";
import { MockBackend } from "../link-host/mock-backend.mjs";
import { baseParts } from "../link-host/parts.mjs";
import { TEAM_METHODS } from "../link-host/team.mjs";
import { jobCounts, jobStage, launchable, launchLabel, projectJobs, toggleBot } from "../src/features/projects/jobLogic";
import { firstStage, pipeline, stageOf } from "../src/features/work/overview";
import { type FetchLike, LinkClient, pair } from "../src/link/client";
import type { BotTask, ChatSummary, JobSetup, JobStatus } from "../src/link/types";

const real = fetch as unknown as FetchLike;
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});
const job = (id: string, more: Partial<NonNullable<ChatSummary["job"]>> = {}, chat: Partial<ChatSummary> = {}): ChatSummary => ({
  id,
  botId: "patch",
  title: id,
  time: 1,
  count: 2,
  projectId: "p1",
  job: { where: "worktree", state: "open", createdAt: 1, branch: "botkins/" + id, setup: "done", ...more },
  ...chat,
});
const quiet = { requests: [], streams: {} };

test("a job's stage: the person's turn first, then the bot's, then the job's own", () => {
  assert.equal(jobStage(quiet, job("a")), "finished");
  assert.equal(jobStage({ requests: [{ chatId: "a" }], streams: { a: "" } }, job("a")), "needs-you");
  assert.equal(jobStage({ requests: [], streams: { a: "" } }, job("a")), "working");
  assert.equal(jobStage(quiet, job("a", { setup: "running" })), "setting-up");
  assert.equal(jobStage(quiet, job("a", { setup: "failed" })), "setup-failed");
  assert.equal(jobStage({ requests: [{ chatId: "a" }], streams: {} }, job("a", { state: "brought-in" })), "brought-in");
  assert.equal(jobStage(quiet, job("a", { state: "removed" })), "closed");
  assert.equal(jobCounts({ requests: [{ chatId: "b" }], streams: { a: "" } }, [job("a"), job("b"), job("c"), job("d", { setup: "failed" })]), "1 working · 2 need you · 1 finished");
  assert.equal(jobCounts(quiet, [job("a", { setup: "failed" })]), "1 needs you");
  assert.equal(jobCounts(quiet, []), "");
  // A project's jobs, newest first; not another project's, not an archived one, not a plain chat.
  const list = projectJobs([job("old", { createdAt: 1 }), job("new", { createdAt: 9 }), job("there", {}, { projectId: "p2" }), job("gone", {}, { archived: true }), { id: "plain", botId: "x", title: "", time: 1, count: 0, projectId: "p1" }], "p1");
  assert.deepEqual(list.map((chat) => chat.id), ["new", "old"]);
});

test("the batch: a prompt needs words and a bot, each bot is a job, and a draft never has none", () => {
  const drafts = [
    { id: 1, prompt: "Fix the coupon", botIds: ["patch", "mira"] },
    { id: 2, prompt: "  ", botIds: ["patch"] },
    { id: 3, prompt: "Write notes", botIds: [] },
    { id: 4, prompt: "Tidy", botIds: ["quill"] },
  ];
  const { ready, jobs } = launchable(drafts);
  assert.deepEqual(ready.map((draft) => draft.id), [1, 4]);
  assert.equal(jobs, 3);
  assert.equal(launchLabel(3), "Start 3 jobs");
  assert.equal(launchLabel(1), "Start job");
  assert.equal(launchLabel(0), "Start job");
  assert.deepEqual(toggleBot(drafts[0]!, "quill", false), ["patch", "mira", "quill"]);
  assert.deepEqual(toggleBot(drafts[0]!, "mira", false), ["patch"]);
  assert.deepEqual(toggleBot(drafts[3]!, "quill", false), ["quill"], "the last bot stays");
  assert.deepEqual(toggleBot(drafts[0]!, "quill", true), ["quill"], "in the checkout, one bot");
});

test("the link: the job calls are the owner's, and their arguments are cut to their shape", () => {
  for (const method of JOB_METHODS) {
    assert.ok(REMOTE_METHODS.has(method), method);
    assert.equal(TEAM_METHODS[method as keyof typeof TEAM_METHODS], "owner", method);
  }
  assert.deepEqual(jobArgs("startProjectJob", ["p1", { botIds: ["patch"], prompt: "Go", where: "somewhere", carry: "yes", path: "/etc", mode: "plan" }]), ["p1", { botIds: ["patch"], prompt: "Go", where: "worktree", mode: "plan" }]);
  assert.deepEqual(jobArgs("startProjectJob", ["p1", { botIds: ["patch"], prompt: "Go", where: "checkout", carry: true, folder: "/Users/demo/site" }]), ["p1", { botIds: ["patch"], prompt: "Go", where: "checkout", folder: "/Users/demo/site", carry: true }]);
  assert.throws(() => jobArgs("startProjectJob", ["p1", { botIds: [], prompt: "Go" }]), /1 to 6 bots/);
  assert.throws(() => jobArgs("startProjectJob", ["p1", { botIds: Array(7).fill("b"), prompt: "Go" }]), /1 to 6 bots/);
  assert.throws(() => jobArgs("startProjectJob", ["p1", { botIds: ["b"], prompt: " " }]), /prompt/);
  assert.throws(() => jobArgs("startProjectJob", ["p1", { botIds: ["b"], prompt: "Go", mode: "wild" }]), /mode/);
  assert.throws(() => jobArgs("approveJobSetup", ["p1", null, "not hex!"]), /changed/);
  assert.deepEqual(jobArgs("approveJobSetup", ["p1", null, "5d1c0e2b7a9f3c48"]), ["p1", undefined, "5d1c0e2b7a9f3c48"]);
  assert.deepEqual(jobArgs("bringInJob", ["chat-1", ""]), ["chat-1"]);
  assert.deepEqual(jobArgs("catchUpJob", ["chat-1", "extra"]), ["chat-1"]);
  assert.throws(() => jobArgs("projectJobStatus", [""]), /Choose a job/);
  assert.equal(jobArgs("projectChanges", ["p1"]), null);
});

async function demo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "botkins-jobs-")));
  folders.push(dir);
  const backend = new MockBackend({ speed: 0.01 });
  const link = new LinkHost({ dir, backend, port: 0, extraHosts: ["127.0.0.1"], relay: false });
  await link.setEnabled(true);
  const paired = await pair(real, { hosts: ["127.0.0.1:" + link.port], code: link.startPairing().code }, { name: "Owner phone", platform: "ios" });
  const client = new LinkClient(paired, { fetch: real, onParts() {}, onState() {} });
  return { backend, call: <T,>(method: string, ...args: unknown[]) => client.call<T>(method, ...args), stop: async () => (client.stop(), await link.stop()) };
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(check());
};

test("the demo runs jobs: the setup's yes, a job per bot, bringing one in, and a clash caught up", async () => {
  const { backend, call, stop } = await demo();
  try {
    assert.ok(backend.capabilities.includes("project-jobs-v1"));
    const setup = await call<JobSetup>("projectJobSetup", "p1");
    assert.ok(setup.repo);
    if (!setup.repo) return;
    assert.equal(setup.approved, false);
    assert.deepEqual(setup.setup, ["npm ci", "cp $BOTKINS_CHECKOUT/.env .env"]);
    await assert.rejects(call("startProjectJob", "p1", { botIds: ["bot-patch"], prompt: "Add a pricing test" }), /allow them first/);
    await assert.rejects(call("approveJobSetup", "p1", null, "abcdef"), /changed/);
    await call("approveJobSetup", "p1", null, setup.hash);
    assert.equal((await call<JobSetup & { repo: true }>("projectJobSetup", "p1")).approved, true);
    // A project with no folder has no repository; its jobs are chats in it.
    assert.equal((await call<JobSetup>("projectJobSetup", "p3")).repo, false);

    const ids = await call<string[]>("startProjectJob", "p1", { botIds: ["bot-patch", "bot-mira"], prompt: "Add a pricing test" });
    assert.equal(ids.length, 2);
    const [a, b] = ids.map((id) => backend.chat(id));
    assert.equal(a.title, "Add a pricing test");
    assert.equal(a.job.branch, "botkins/add-a-pricing-test");
    assert.notEqual(b.job.branch, a.job.branch);
    // The setup runs, then the prompt starts a turn, and the turn ends with a reply.
    await until(() => ids.every((id) => backend.chat(id).messages.some((m: { role: string }) => m.role === "assistant") && !backend.turns.has(id)));
    const status = await call<JobStatus>("projectJobStatus", a.id);
    assert.equal(status.canBringIn, true, status.reason);
    assert.ok(status.files?.length);
    const done = await call<{ ok: boolean; commit?: string }>("bringInJob", a.id);
    assert.equal(done.ok, true);
    assert.equal(a.job.state, "brought-in");
    await assert.rejects(call("bringInJob", a.id), /brought in already/);
    await call("removeJobWorktree", b.id);
    assert.equal(b.job.state, "removed");

    // The seeded job that clashes: nothing changes, and catching up clears it.
    const clash = backend.chat("chat-job-lockfile");
    const before = await call<JobStatus>("projectJobStatus", clash.id);
    assert.deepEqual(before.conflicts, ["mobile/package.json", "mobile/package-lock.json"]);
    assert.deepEqual(await call("bringInJob", clash.id), { ok: false, conflicts: before.conflicts });
    assert.equal(clash.job.state, "open");
    await call("catchUpJob", clash.id);
    await until(() => !backend.turns.has(clash.id));
    assert.equal((await call<JobStatus>("projectJobStatus", clash.id)).canBringIn, true);

    // The checkout takes one job at a time, with one bot.
    await assert.rejects(call("startProjectJob", "p1", { botIds: ["bot-patch", "bot-mira"], prompt: "Both", where: "checkout" }), /one at a time/);
    // What a phone hears of a job: its facts, never a path or the commands it ran.
    const raw = { ...clash.job, path: "/Users/demo/.botkins/worktrees/x", root: "/Users/demo/site", commands: ["npm ci"] };
    const sent = baseParts({ ...backend.state, chats: [{ ...clash, job: raw }] }, {}).chats[0].job;
    assert.deepEqual(Object.keys(sent).sort(), ["base", "baseSha", "branch", "createdAt", "setup", "state", "where"]);
    assert.equal(sent.baseSha.length, 7);
  } finally {
    await stop();
  }
});

test("the Tasks page is a pipeline: Needs you apart, then Later › Ready › Working › Review › Done", () => {
  const task = (id: string, status: BotTask["status"], more: Partial<BotTask> = {}) => ({ id, status, priority: "normal", updatedAt: 1, ...more }) as Pick<BotTask, "id" | "status" | "priority" | "updatedAt" | "reviewerBotId">;
  const tasks = [
    task("blocked", "blocked"),
    task("mine", "review"),
    task("bots", "review", { reviewerBotId: "mira" }),
    task("w", "working"),
    task("r1", "ready", { updatedAt: 5 }),
    task("r2", "ready", { priority: "urgent" }),
    task("l", "later"),
    task("d1", "done", { updatedAt: 3 }),
    task("d2", "done", { updatedAt: 9 }),
    task("old", "archived" as BotTask["status"]),
  ];
  const { needs, stages } = pipeline(tasks);
  assert.deepEqual(needs.map((t) => t.id).sort(), ["blocked", "mine"]);
  assert.deepEqual(stages.later.map((t) => t.id), ["l"]);
  assert.deepEqual(stages.ready.map((t) => t.id), ["r2", "r1"], "urgent first");
  assert.deepEqual(stages.working.map((t) => t.id), ["w"]);
  assert.deepEqual(stages.reviewing.map((t) => t.id), ["bots"]);
  assert.deepEqual(stages.done.map((t) => t.id), ["d2", "d1"], "newest done first");
  assert.equal(stageOf({ status: "review" }), null);
  assert.equal(firstStage(stages), "working");
  assert.equal(firstStage({ later: [], ready: [], working: [], reviewing: [], done: [] }), "done");
  assert.equal(firstStage({ later: [1], ready: [], working: [], reviewing: [], done: [1] }), "later");
});
