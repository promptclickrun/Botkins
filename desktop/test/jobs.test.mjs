// Jobs (desktop/jobs.mjs): a prompt per bot, each in a chat and a git worktree of its own. These run real git
// in temporary repositories, with a stand-in for the workspace.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { branchFor, catchUpPrompt, Jobs, parseConfig, parseMergeTree, parseNumstat, titleOf, topicOf } from "../desktop/jobs.mjs";

const made = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
const temp = (name) => {
  const dir = mkdtempSync(join(tmpdir(), name));
  made.push(dir);
  return dir;
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: cwd } }).trim();

/** A repository on main with one commit, and its own name and email for commits. */
function repo(files = { "README.md": "hello\n" }) {
  const dir = temp("botkins-jobs-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

/** The parts of the workspace that jobs use. `submitted` is every prompt that would start a turn. */
function workspace(folder) {
  const state = {
    projects: [{ id: "p1", name: "Demo", folder, folders: folder ? [folder] : [], todos: [] }],
    chats: [],
    bots: [{ id: "b1", name: "Nova" }, { id: "b2", name: "Orbit" }],
  };
  const submitted = [];
  const ws = {
    dir: temp("botkins-jobs-ws-"),
    state,
    active: new Map(),
    submitted,
    save() {},
    chat(id) {
      const chat = state.chats.find((entry) => entry.id === id);
      if (!chat) throw new Error("There is no such chat.");
      return chat;
    },
    bot(id) {
      const bot = state.bots.find((entry) => entry.id === id);
      if (!bot) throw new Error("There is no such bot.");
      return bot;
    },
    submit(chatId, text, options) {
      submitted.push({ chatId, text, options });
      return null;
    },
    projects: {
      get: (id) => state.projects.find((entry) => entry.id === id),
      folderOf: (id, chosen) => chosen ?? state.projects.find((entry) => entry.id === id).folder,
      chats: (id) => state.chats.filter((chat) => chat.projectId === id),
      startChat(botIds, projectId, mode) {
        const id = randomUUID();
        state.chats.push({ id, botId: botIds[0], projectId, mode: mode ?? "default", messages: [] });
        return id;
      },
    },
  };
  ws.jobs = new Jobs(ws);
  return ws;
}
/** Waits for a job's setup to finish and its prompt to be sent (begin runs on its own). */
async function settled(ws, count) {
  for (let i = 0; i < 200 && ws.submitted.length < count; i++) await new Promise((done) => setTimeout(done, 25));
  assert.equal(ws.submitted.length, count, "the prompts were sent");
}

test("a branch's name comes from the prompt's first words", () => {
  assert.equal(topicOf("Fix the login bug on Safari!"), "fix-the-login-bug-on-safari");
  assert.equal(topicOf("Café menu: über cool"), "cafe-menu-uber-cool");
  assert.equal(topicOf("!!!"), "job");
  assert.ok(topicOf("one two three four five six seven eight nine ten eleven").length <= 32);
  assert.equal(branchFor("Add dark mode"), "botkins/add-dark-mode");
  assert.equal(branchFor("Add dark mode", "jobs/{topic}"), "jobs/add-dark-mode");
  assert.equal(titleOf("First line\nsecond"), "First line");
  assert.equal(titleOf("x".repeat(100)).length, 80);
  assert.match(catchUpPrompt({ base: "main", branch: "botkins/a" }, ["a.txt"]), /merge main into botkins\/a/);
});

test("the setup file is read with care: commands, the branch's pattern, and a hash of the list", () => {
  assert.deepEqual(parseConfig(null), { setup: [], branch: "botkins/{topic}", file: false, hash: "" });
  const one = parseConfig(JSON.stringify({ setup: ["npm ci", " npm run build "] }));
  assert.deepEqual(one.setup, ["npm ci", "npm run build"]);
  assert.equal(one.hash.length, 16);
  assert.notEqual(parseConfig(JSON.stringify({ setup: ["npm ci"] })).hash, one.hash);
  // Cursor's .cursor/worktrees.json words work too.
  assert.deepEqual(parseConfig(JSON.stringify({ "setup-worktree": ["pnpm i"] })).setup, ["pnpm i"]);
  assert.ok(parseConfig("{ nope").error);
  assert.ok(parseConfig(JSON.stringify({ setup: [42] })).error);
  assert.ok(parseConfig(JSON.stringify({ setup: Array(21).fill("x") })).error);
  assert.ok(parseConfig(JSON.stringify({ branch: "no-topic" })).error);
  assert.ok(parseConfig(JSON.stringify({ branch: "bad..{topic}" })).error);
  assert.equal(parseConfig(JSON.stringify({ branch: "team/{topic}" })).branch, "team/{topic}");
});

test("merge-tree's answer and numstat are read as files", () => {
  assert.deepEqual(parseMergeTree(0, "abc\n"), []);
  assert.deepEqual(parseMergeTree(1, "abc\na.txt\nb.txt\n\nmessages"), ["a.txt", "b.txt"]);
  assert.equal(parseMergeTree(128, ""), null);
  assert.deepEqual(parseNumstat("3\t1\ta.txt\0-\t-\tpic.png\0"), [{ path: "a.txt", added: 3, removed: 1 }, { path: "pic.png", added: 0, removed: 0 }]);
  // A rename is its old and new path after an empty one.
  assert.deepEqual(parseNumstat("1\t0\t\0old.txt\0new.txt\0"), [{ path: "new.txt", added: 1, removed: 0 }]);
});

test("each bot's job gets its own branch and worktree from the checkout's commit, then its prompt", async () => {
  const root = repo();
  const ws = workspace(root);
  const setup = await ws.jobs.setupOf("p1");
  assert.equal(setup.repo, true);
  assert.equal(setup.base, "main");
  assert.equal(setup.approved, true, "no setup commands need no yes");
  const ids = await ws.jobs.start("p1", { botIds: ["b1", "b2"], prompt: "Add a greeting" });
  assert.equal(ids.length, 2);
  await settled(ws, 2);
  const [a, b] = ids.map((id) => ws.chat(id));
  assert.equal(a.title, "Add a greeting");
  assert.equal(a.job.branch, "botkins/add-a-greeting");
  assert.notEqual(b.job.branch, a.job.branch, "the second job's branch has its own name");
  assert.notEqual(a.job.path, b.job.path);
  assert.ok(!a.job.path.startsWith(root), "the worktree is outside the repository");
  assert.equal(git(a.job.path, "rev-parse", "--abbrev-ref", "HEAD"), a.job.branch);
  assert.equal(a.job.setup, "none");
  assert.deepEqual(ws.submitted.map((entry) => entry.text), ["Add a greeting", "Add a greeting"]);
  // The checkout is as it was.
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(root, "status", "--porcelain"), "");
});

test("a job is brought in when it merges cleanly, and its worktree goes while its branch stays", async () => {
  const root = repo();
  const ws = workspace(root);
  const [id] = await ws.jobs.start("p1", { botIds: ["b1"], prompt: "Write notes" });
  await settled(ws, 1);
  const { job } = ws.chat(id);
  assert.equal((await ws.jobs.status(id)).reason, "Nothing changed yet.");
  // The bot's work: one file committed, one left uncommitted.
  writeFileSync(join(job.path, "notes.txt"), "one\ntwo\n");
  git(job.path, "add", "notes.txt");
  git(job.path, "commit", "-q", "-m", "notes");
  writeFileSync(join(job.path, "more.txt"), "three\n");
  const status = await ws.jobs.status(id);
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);
  assert.equal(status.uncommitted, 1);
  assert.deepEqual(status.files.map((file) => file.path).sort(), ["more.txt", "notes.txt"]);
  assert.equal(status.canBringIn, true, status.reason);
  const done = await ws.jobs.bringIn(id);
  assert.equal(done.ok, true);
  assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "one\ntwo\n");
  assert.equal(readFileSync(join(root, "more.txt"), "utf8"), "three\n", "what was left uncommitted came too");
  assert.equal(job.state, "brought-in");
  assert.equal(existsSync(job.path), false);
  assert.ok(git(root, "branch", "--list", job.branch), "the branch stays");
  assert.match(git(root, "log", "-1", "--format=%s"), /^Bring in botkins\/write-notes: Write notes$/);
  await assert.rejects(ws.jobs.bringIn(id), /brought in already/);
});

test("a job that clashes with the checkout is not brought in, and catch-up asks the bot to merge", async () => {
  const root = repo({ "a.txt": "base\n" });
  const ws = workspace(root);
  const [id] = await ws.jobs.start("p1", { botIds: ["b1"], prompt: "Change a" });
  await settled(ws, 1);
  const { job } = ws.chat(id);
  writeFileSync(join(job.path, "a.txt"), "from the job\n");
  git(job.path, "commit", "-q", "-am", "job");
  writeFileSync(join(root, "a.txt"), "from the checkout\n");
  git(root, "commit", "-q", "-am", "checkout");
  const status = await ws.jobs.status(id);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.conflicts, ["a.txt"]);
  assert.equal(status.canBringIn, false);
  const before = git(root, "rev-parse", "HEAD");
  assert.deepEqual(await ws.jobs.bringIn(id), { ok: false, conflicts: ["a.txt"] });
  assert.equal(git(root, "rev-parse", "HEAD"), before, "the checkout didn't change");
  assert.equal(git(root, "status", "--porcelain"), "");
  await ws.jobs.catchUp(id);
  assert.match(ws.submitted.at(-1).text, /merge main into botkins\/change-a/);
  assert.match(ws.submitted.at(-1).text, /a\.txt/);
});

test("bring-in waits for the checkout to be on the job's branch with nothing uncommitted", async () => {
  const root = repo({ "a.txt": "base\n" });
  const ws = workspace(root);
  const [id] = await ws.jobs.start("p1", { botIds: ["b1"], prompt: "Add b" });
  await settled(ws, 1);
  writeFileSync(join(ws.chat(id).job.path, "b.txt"), "b\n");
  writeFileSync(join(root, "a.txt"), "edited\n");
  assert.match((await ws.jobs.status(id)).reason, /aren't committed/);
  await assert.rejects(ws.jobs.bringIn(id), /aren't committed/);
  git(root, "checkout", "-q", "--", "a.txt");
  git(root, "checkout", "-q", "-b", "other");
  assert.match((await ws.jobs.status(id)).reason, /Switch it to main/);
  ws.active.set(id, {});
  await assert.rejects(ws.jobs.bringIn(id), /Wait for the job/);
});

test("setup commands run only once they were allowed, and only the list that was allowed", async () => {
  const root = repo({ ".botkins/worktrees.json": JSON.stringify({ setup: ["echo ran > setup.txt"] }) });
  const ws = workspace(root);
  const setup = await ws.jobs.setupOf("p1");
  assert.deepEqual(setup.setup, ["echo ran > setup.txt"]);
  assert.equal(setup.approved, false);
  await assert.rejects(ws.jobs.start("p1", { botIds: ["b1"], prompt: "Go" }), /allow them first/);
  await assert.rejects(ws.jobs.approveSetup("p1", undefined, "0000000000000000"), /changed/);
  await ws.jobs.approveSetup("p1", undefined, setup.hash);
  const [id] = await ws.jobs.start("p1", { botIds: ["b1"], prompt: "Go" });
  await settled(ws, 1);
  const { job } = ws.chat(id);
  assert.equal(job.setup, "done");
  assert.equal(readFileSync(join(job.path, "setup.txt"), "utf8").trim(), "ran");
  // What the setup made is the setup's: not a change of the job's, and not brought in.
  assert.deepEqual(job.setupFiles, ["setup.txt"]);
  assert.equal((await ws.jobs.status(id)).reason, "Nothing changed yet.");
  writeFileSync(join(job.path, "work.txt"), "done\n");
  const status = await ws.jobs.status(id);
  assert.deepEqual(status.files.map((file) => file.path), ["work.txt"]);
  assert.equal(status.uncommitted, 1);
  assert.equal((await ws.jobs.bringIn(id)).ok, true);
  assert.equal(existsSync(join(root, "work.txt")), true);
  assert.equal(existsSync(join(root, "setup.txt")), false);
  assert.equal(job.setupFiles, undefined);
  // A changed list needs a yes again.
  writeFileSync(join(root, ".botkins/worktrees.json"), JSON.stringify({ setup: ["echo other"] }));
  assert.equal((await ws.jobs.setupOf("p1")).approved, false);
});

test("a setup that fails stops before the prompt, and Start anyway sends it", async () => {
  const root = repo({ ".botkins/worktrees.json": JSON.stringify({ setup: ["echo nope >&2; exit 3"] }) });
  const ws = workspace(root);
  await ws.jobs.approveSetup("p1", undefined, (await ws.jobs.setupOf("p1")).hash);
  const [id] = await ws.jobs.start("p1", { botIds: ["b1"], prompt: "Try" });
  const chat = ws.chat(id);
  for (let i = 0; i < 200 && chat.job.setup !== "failed"; i++) await new Promise((done) => setTimeout(done, 25));
  assert.equal(chat.job.setup, "failed");
  assert.match(chat.job.setupError, /nope/);
  assert.equal(ws.submitted.length, 0);
  ws.jobs.startTurn(id);
  assert.equal(chat.job.setup, "skipped");
  assert.equal(ws.submitted.length, 1);
  assert.throws(() => ws.jobs.startTurn(id), /started already/);
});

test("jobs in the checkout go one at a time; uncommitted changes can come along into a worktree", async () => {
  const root = repo({ "a.txt": "base\n" });
  const ws = workspace(root);
  await assert.rejects(ws.jobs.start("p1", { botIds: ["b1", "b2"], prompt: "Both", where: "checkout" }), /one at a time/);
  const [id] = await ws.jobs.start("p1", { botIds: ["b1"], prompt: "Here", where: "checkout" });
  assert.equal(ws.chat(id).job.where, "checkout");
  assert.equal(ws.chat(id).job.branch, undefined);
  ws.active.set(id, {});
  await assert.rejects(ws.jobs.start("p1", { botIds: ["b2"], prompt: "Also here", where: "checkout" }), /working in your checkout/);
  ws.active.delete(id);
  writeFileSync(join(root, "a.txt"), "edited in the checkout\n");
  const [carried] = await ws.jobs.start("p1", { botIds: ["b2"], prompt: "Carry", carry: true });
  assert.equal(readFileSync(join(ws.chat(carried).job.path, "a.txt"), "utf8"), "edited in the checkout\n");
  assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "edited in the checkout\n", "the checkout keeps its changes");
});

test("removing a worktree keeps what wasn't committed on the job's branch", async () => {
  const root = repo();
  const ws = workspace(root);
  const [id] = await ws.jobs.start("p1", { botIds: ["b1"], prompt: "Draft" });
  await settled(ws, 1);
  const { job } = ws.chat(id);
  writeFileSync(join(job.path, "draft.txt"), "half done\n");
  await ws.jobs.removeWorktree(id);
  assert.equal(job.state, "removed");
  assert.equal(existsSync(job.path), false);
  assert.equal(git(root, "show", job.branch + ":draft.txt"), "half done");
});

test("a project with no repository can't have worktree jobs", async () => {
  const plain = temp("botkins-jobs-plain-");
  const ws = workspace(plain);
  assert.equal((await ws.jobs.setupOf("p1")).repo, false);
  await assert.rejects(ws.jobs.start("p1", { botIds: ["b1"], prompt: "Go" }), /not a git repository/);
  await assert.rejects(ws.jobs.start("p1", { botIds: [], prompt: "Go" }), /Choose 1 to 6 bots/);
  const empty = temp("botkins-jobs-empty-");
  git(empty, "init", "-q", "-b", "main");
  await assert.rejects(workspace(empty).jobs.start("p1", { botIds: ["b1"], prompt: "Go" }), /no commits yet/);
});
