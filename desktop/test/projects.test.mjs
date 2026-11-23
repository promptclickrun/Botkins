import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./starter.mjs";
import { MAX_PROJECT_ARTIFACTS, PROJECT_ARTIFACTS, Projects, parseStatus } from "../desktop/projects.mjs";
import { CAPABILITIES, linkCapabilities } from "../desktop/runtime.mjs";
import { PI_PACKAGE_METHODS } from "../desktop/link/methods.mjs";
import { decide } from "../desktop/providers/copilot/permissions.mjs";

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "botkins-projects-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ws = new Workspace(join(dir, "data"), async () => ({}), () => {});
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  git("add", "-A");
  git("commit", "-qm", "first");
  return { dir, ws, projects: new Projects(ws), repo, git };
}

test("status parsing covers branches, renames and untracked files", () => {
  const out = "## main...origin/main [ahead 2, behind 1]\0 M a.txt\0R  new.txt\0old.txt\0?? n.txt\0D  gone.txt\0";
  const s = parseStatus(out);
  assert.deepEqual([s.branch, s.upstream, s.ahead, s.behind], ["main", "origin/main", 2, 1]);
  assert.deepEqual(s.files.map((f) => [f.path, f.kind, f.staged]), [
    ["a.txt", "modified", false],
    ["new.txt", "renamed", true],
    ["n.txt", "untracked", false],
    ["gone.txt", "deleted", true],
  ]);
  assert.equal(s.files[1].from, "old.txt");
  assert.equal(parseStatus("## No commits yet on main\0").branch, "main");
});

test("projects report changes, diffs and commits in a real repository", async (t) => {
  const { projects, repo } = setup(t);
  const id = projects.add(repo);
  assert.equal(projects.add(repo), id, "adding the same folder twice reuses it");
  assert.equal(projects.get(id).name, "repo");
  writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(repo, "b.txt"), "new\n");
  const changes = await projects.changes(id);
  assert.equal(changes.repo, true);
  assert.equal(changes.branch, "main");
  const a = changes.files.find((f) => f.path === "a.txt");
  assert.deepEqual([a.kind, a.added, a.removed], ["modified", 2, 1]);
  const b = changes.files.find((f) => f.path === "b.txt");
  assert.deepEqual([b.kind, b.added], ["untracked", 1]);
  assert.equal(changes.added, 3);
  assert.match((await projects.diff(id, "a.txt")).text, /\+TWO/);
  assert.match((await projects.diff(id, "b.txt")).text, /\+new/);
  await assert.rejects(projects.diff(id, "../etc/passwd"), /Invalid file/);
  await assert.rejects(projects.diff(id, "/etc/passwd"), /Invalid file/);
  const sha = await projects.commit(id, "Update files");
  assert.match(sha, /^[0-9a-f]{4,}$/);
  assert.equal((await projects.changes(id)).files.length, 0);
});

test("a non-repository folder reports no changes; chats bind to projects before they start", async (t) => {
  const { dir, ws, projects, repo } = setup(t);
  const plain = join(dir, "plain");
  mkdirSync(plain);
  const pid = projects.add(plain, "Notes");
  assert.deepEqual(await projects.changes(pid), { repo: false, files: [] });
  const chat = ws.createChat(ws.state.bots[0].id);
  projects.setChatProject(chat, pid, "plan");
  assert.equal(projects.folderFor(ws.chat(chat)), plain);
  assert.equal(ws.chat(chat).mode, "plan");
  ws.chat(chat).established = true;
  const other = projects.add(repo);
  projects.setChatProject(chat, other);
  assert.equal(ws.chat(chat).restartSession, true);
  projects.setChatProject(chat, pid, "yolo");
  assert.equal(ws.chat(chat).mode, "yolo");
  assert.throws(() => projects.setChatProject(chat, pid, "turbo"), /default, plan or yolo/);
  assert.throws(() => projects.add(join(dir, "missing")), /Choose a folder/);
  projects.remove(pid);
  assert.equal(ws.chat(chat).projectId, undefined);
});

test("a repository's own config can't run programs when Botkins reads or commits it", async (t) => {
  const { dir, projects, repo, git } = setup(t);
  const marker = join(dir, "pwned");
  const script = join(dir, "evil.sh");
  writeFileSync(script, `#!/bin/sh\necho "$0 $@" >> ${marker}\ncat\n`, { mode: 0o755 });
  git("config", "core.fsmonitor", script);
  git("config", "core.hooksPath", join(dir, "hooks"));
  mkdirSync(join(dir, "hooks"));
  for (const hook of ["pre-commit", "commit-msg", "post-commit"]) writeFileSync(join(dir, "hooks", hook), `#!/bin/sh\necho hook >> ${marker}\n`, { mode: 0o755 });
  git("config", "filter.evil.clean", script);
  git("config", "filter.evil.process", script);
  git("config", "diff.external", script);
  git("config", "diff.evil.textconv", script);
  git("config", "commit.gpgSign", "true");
  git("config", "gpg.program", script);
  writeFileSync(join(repo, ".gitattributes"), "*.txt filter=evil diff=evil\n");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  const id = projects.add(repo);
  const changes = await projects.changes(id);
  assert.ok(changes.files.some((f) => f.path === "a.txt"));
  await projects.diff(id, "a.txt");
  await projects.commit(id, "Safe commit");
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
});

test("branch names with dots, rename counts, symlink escapes and a subfolder commit", async (t) => {
  const { dir, projects, repo, git } = setup(t);
  git("checkout", "-q", "-b", "release-1.2");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  git("add", "-A");
  git("commit", "-qm", "more");
  git("mv", "a.txt", "renamed.txt");
  const id = projects.add(repo);
  let changes = await projects.changes(id);
  assert.equal(changes.branch, "release-1.2");
  const renamed = changes.files.find((f) => f.kind === "renamed");
  assert.deepEqual([renamed.path, renamed.from], ["renamed.txt", "a.txt"]);
  git("commit", "-qm", "rename");
  symlinkSync("/etc", join(repo, "linkdir"));
  await assert.rejects(projects.diff(id, "linkdir/hosts"), /Invalid file/);
  rmSync(join(repo, "linkdir"));
  mkdirSync(join(repo, "sub"));
  writeFileSync(join(repo, "sub", "inside.txt"), "in\n");
  writeFileSync(join(repo, "outside.txt"), "out\n");
  const sub = projects.add(join(repo, "sub"));
  changes = await projects.changes(sub);
  assert.ok(changes.files.some((f) => f.path === "sub/inside.txt"));
  assert.match((await projects.diff(sub, "sub/inside.txt")).text, /\+in/);
  await projects.commit(sub, "Only the subfolder");
  const left = (await projects.changes(sub)).files.map((f) => f.path);
  assert.deepEqual(left, ["outside.txt"], "files outside the project folder stay uncommitted");
});

test("YOLO needs its project folder and still asks about sandbox escapes", async (t) => {
  const { dir, ws, projects, repo } = setup(t);
  const pid = projects.add(repo);
  const chatId = ws.createChat(ws.state.bots[0].id);
  projects.setChatProject(chatId, pid, "yolo");
  const chat = ws.chat(chatId);
  const task = { stopped: false };
  const asked = [];
  ws.interactions.request = async (_chat, _task, view) => {
    asked.push(view.title);
    return { action: "deny" };
  };
  const ask = (req) => decide((r) => ws.interactions.permission(chat, task, r), { kind: "shell", fullCommandText: "ls", intention: "List", ...req });
  assert.notEqual((await ask({})).kind, "reject", "a plain request runs without asking in YOLO");
  assert.equal((await ask({ requestSandboxBypass: true, intention: "Escape" })).kind, "reject");
  assert.deepEqual(asked, ["Escape"]);
  rmSync(repo, { recursive: true, force: true });
  assert.equal((await ask({ intention: "Missing folder" })).kind, "reject", "YOLO stops when the folder is gone");
  projects.setChatProject(chatId, pid, "default");
  assert.equal(chat.mode, "default", "the mode can still be turned off");
  projects.remove(pid);
  assert.equal(chat.mode, "default");
  void dir;
});

test("folder projects saved before workspaces migrate: path becomes folder, no to-dos", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-projects-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const folder = join(dir, "code");
  mkdirSync(folder);
  mkdirSync(join(dir, "data"));
  const legacy = {
    bots: [{ id: "pip", name: "Pip", role: "R", instructions: "I", face: "idle" }],
    chats: [{ id: "c1", botId: "pip", title: "Old", time: 1, messages: [], established: true, projectId: "p1", mode: "yolo" }],
    runs: [],
    projects: [{ id: "p1", name: "code", path: folder, lastUsed: 5 }],
  };
  writeFileSync(join(dir, "data", "workspace.json"), JSON.stringify(legacy));
  const ws = new Workspace(join(dir, "data"), async () => ({}), () => {});
  const p = ws.projects.get("p1");
  assert.deepEqual(p, { id: "p1", name: "code", folder, folders: [folder], description: "", todos: [], lastUsed: 5, createdAt: 5 });
  assert.equal(ws.projects.folderFor(ws.chat("c1")), folder, "the chat still runs in its folder");
  assert.equal(ws.chat("c1").mode, "yolo", "and keeps its mode");
  const saved = JSON.parse(readFileSync(join(dir, "data", "workspace.json"), "utf8")).projects[0];
  assert.equal(saved.path, undefined);
  assert.equal(new Workspace(join(dir, "data"), async () => ({}), () => {}).projects.get("p1").folder, folder, "loading again keeps it");
});

test("workspace projects: no folder, folder choose and remove, and modes only in a folder", (t) => {
  const { ws, repo } = setup(t);
  const id = ws.projects.create({ name: "Planning", description: "Q3" });
  const p = ws.projects.get(id);
  assert.equal(p.folder, undefined);
  assert.throws(() => ws.projects.create({ name: "" }), /project name/);
  assert.throws(() => ws.projects.folderOf(id), /has no folder/);
  const chat = ws.createChat("pip");
  ws.projects.setChatProject(chat, id, "yolo");
  assert.equal(ws.chat(chat).mode, "default", "modes need a folder");
  assert.equal(ws.projects.folderFor(ws.chat(chat)), null);
  ws.projects.update(id, { folder: repo, name: "Planning repo" });
  assert.equal(ws.projects.folderOf(id), repo);
  ws.projects.setChatProject(chat, id, "plan");
  assert.equal(ws.chat(chat).mode, "plan");
  ws.projects.update(id, { folder: null });
  assert.equal(ws.projects.get(id).folder, undefined);
  assert.equal(ws.chat(chat).mode, "default", "removing the folder turns the coding modes off");
  assert.throws(() => ws.projects.update(id, { folder: "/no/such/folder" }), /Choose a folder/);
  assert.throws(() => ws.projects.update(id, { owner: "x" }), /Unknown project field/);
  // An established chat can move into a folder on its next turn.
  ws.chat(chat).established = true;
  const other = ws.projects.create({ name: "Other" });
  ws.projects.setChatProject(chat, other);
  assert.equal(ws.chat(chat).projectId, other);
  ws.projects.setChatProject(chat, ws.projects.add(repo));
  assert.equal(ws.chat(chat).restartSession, true);
});

test("project to-dos: add, check off, rename, reorder and delete", (t) => {
  const { ws } = setup(t);
  const id = ws.projects.create({ name: "Launch" });
  const a = ws.projects.addTodo(id, "Write brief");
  const b = ws.projects.addTodo(id, "Book room");
  const c = ws.projects.addTodo(id, "Send invite");
  const order = () => ws.projects.get(id).todos.map((t) => t.text);
  assert.deepEqual(order(), ["Write brief", "Book room", "Send invite"]);
  ws.projects.updateTodo(id, a.id, { done: true });
  assert.ok(ws.projects.get(id).todos[0].doneAt, "checking off records when");
  assert.equal(ws.projects.addTodo(id, "Order food").text, "Order food");
  assert.deepEqual(order(), ["Write brief", "Book room", "Send invite", "Order food"]);
  ws.projects.updateTodo(id, a.id, { done: false });
  assert.equal(ws.projects.get(id).todos[0].doneAt, undefined);
  ws.projects.updateTodo(id, b.id, { text: "Book the big room" });
  ws.projects.moveTodo(id, c.id, -1);
  assert.deepEqual(order(), ["Write brief", "Send invite", "Book the big room", "Order food"]);
  ws.projects.moveTodo(id, a.id, -1);
  assert.equal(order()[0], "Write brief", "moving past the top does nothing");
  assert.throws(() => ws.projects.moveTodo(id, a.id, 3), /up or down/);
  ws.projects.deleteTodo(id, b.id);
  assert.equal(ws.projects.get(id).todos.length, 3);
  assert.throws(() => ws.projects.updateTodo(id, b.id, { done: true }), /no longer exists/);
  assert.throws(() => ws.projects.addTodo(id, " "), /1 to 500/);
  assert.throws(() => ws.projects.updateTodo(id, a.id, { done: "yes" }), /Invalid/);
});

test("artifacts on a project: attach, move to the front, take off, and one that is gone drops out", (t) => {
  const { dir, ws, projects } = setup(t);
  assert.equal(PROJECT_ARTIFACTS, "project-artifacts-v1");
  assert.ok(CAPABILITIES.includes(PROJECT_ARTIFACTS));
  // A paired device hears of it only when the link carries all three calls.
  const gated = new Set(["message-reactions-v1", "project-folders-v1", "project-mode-v1", "project-clone-v1", "spaces-v1", "voice-history-v1", "voice-turns-v1", "market-refresh-v1", "mcp-apps-v1", "pi-packages-v1", "skill-upload-v1", "skills-catalog-v1", "chat-title-regeneration-v1"]);
  const withArtifacts = CAPABILITIES.filter((name) => !gated.has(name));
  const withoutArtifacts = withArtifacts.filter((name) => name !== PROJECT_ARTIFACTS);
  assert.deepEqual(linkCapabilities(new Set()), withoutArtifacts);
  assert.deepEqual(linkCapabilities(new Set(["addProjectArtifact", "removeProjectArtifact"])), withoutArtifacts);
  assert.deepEqual(linkCapabilities(new Set(["addProjectArtifact", "removeProjectArtifact", "projectArtifacts"])), withArtifacts);
  assert.ok(linkCapabilities(new Set(["regenerateChatTitle"])).includes("chat-title-regeneration-v1"));
  assert.ok(linkCapabilities(new Set(["reactToMessage"])).includes("message-reactions-v1"));
  // Pi packages are named only when the link carries all five marketplace calls.
  assert.equal(linkCapabilities(new Set(PI_PACKAGE_METHODS.slice(1))).includes("pi-packages-v1"), false);
  assert.equal(linkCapabilities(new Set(PI_PACKAGE_METHODS)).includes("pi-packages-v1"), true);
  // ("market-refresh-v1" is named only when the link carries plugins.refresh.)
  assert.ok(linkCapabilities(new Set(["plugins.refresh"])).includes("market-refresh-v1"));
  const files = join(dir, "files");
  mkdirSync(join(files, "site"), { recursive: true });
  const put = (name, text = name) => (writeFileSync(join(files, name), text), join(files, name));
  const chatId = ws.createChat("pip");
  const record = (name, time) => ws.artifacts.record(put(name), { botId: "pip", chatId, source: "tool", time }).id;
  const [report, chart, notes] = [record("report.md", 1), record("chart.png", 2), record("notes.txt", 3)];
  put("site/index.html");
  const site = ws.artifacts.record(join(files, "site"), { botId: "pip", chatId, source: "tool", time: 4 }).id;
  const page = ws.artifacts.list({ botId: "pip", folder: site }).items[0].id;
  assert.match(page, /^child:/);

  const id = projects.create({ name: "Launch" });
  const shown = () => ws.snapshot().projects.find((p) => p.id === id).artifacts;
  assert.equal(shown(), undefined, "the field is left out while a project has none");
  assert.deepEqual(projects.addArtifact(id, report), [report]);
  assert.deepEqual(projects.addArtifact(id, chart), [chart, report], "newest first");
  assert.deepEqual(projects.addArtifact(id, report), [report, chart], "one that is already there moves to the front");
  assert.deepEqual(projects.addArtifact(id, page), [page, report, chart], "a file inside a shared folder can be attached");
  assert.deepEqual(projects.addArtifact(id, join(files, "notes.txt")), [notes, page, report, chart], "a path is kept as the artifact's id");
  assert.deepEqual(shown(), [notes, page, report, chart]);
  assert.deepEqual(projects.artifacts(id).items.map((item) => item.name), ["notes.txt", "index.html", "report.md", "chart.png"]);
  assert.equal(projects.artifacts(id).items[2].chatId, chatId, "each comes described as in the artifact list");

  for (const bad of ["nothing-by-this-id", join(files, "never-recorded.txt"), "child:not-a-key", "", null, 7, { id: report }])
    assert.throws(() => projects.addArtifact(id, bad), /^Error: This artifact no longer exists\.$/, String(bad));
  assert.throws(() => projects.addArtifact("no-such-project", report), /Unknown project/);
  assert.throws(() => projects.update(id, { artifacts: [] }), /Unknown project field/, "the list changes only through its two calls");

  assert.deepEqual(projects.removeArtifact(id, page), [notes, report, chart]);
  assert.deepEqual(projects.removeArtifact(id, page), [notes, report, chart], "taking off one that is not attached is no error");
  assert.deepEqual(projects.removeArtifact(id, "nothing-by-this-id"), [notes, report, chart]);

  // A file that is deleted: the described list drops it and cleans what is stored.
  rmSync(join(files, "chart.png"));
  assert.deepEqual(projects.artifacts(id).items.map((item) => item.id), [notes, report]);
  assert.deepEqual(projects.get(id).artifacts, [notes, report]);
  // A row that left the index is off the list a window gets at once, before anything is saved again.
  ws.artifacts.rows = ws.artifacts.rows.filter((row) => row.id !== report);
  assert.deepEqual(projects.get(id).artifacts, [notes, report], "still stored");
  assert.deepEqual(shown(), [notes]);
  assert.deepEqual(projects.removeArtifact(id, "nothing-by-this-id"), [notes], "and the next change cleans the stored list");
  assert.deepEqual(projects.get(id).artifacts, [notes]);
  assert.deepEqual(projects.removeArtifact(id, notes), []);
  assert.equal("artifacts" in projects.get(id), false);
  assert.equal(shown(), undefined);

  // A second project keeps its own list, and removing a project takes its list with it.
  const other = projects.create({ name: "Other" });
  projects.addArtifact(other, notes);
  projects.addArtifact(id, notes);
  projects.remove(other);
  assert.deepEqual(shown(), [notes]);

  // What is saved comes back, and a list from a damaged file is brought into shape.
  const again = new Workspace(join(dir, "data"), async () => ({}), () => {});
  assert.deepEqual(again.projects.get(id).artifacts, [notes]);
  again.state.projects[0].artifacts = [notes, 5, notes, null];
  const repaired = new Projects(again);
  assert.deepEqual(repaired.get(id).artifacts, [notes]);
});

test("a project holds up to 200 artifacts", (t) => {
  const { dir, ws, projects } = setup(t);
  const files = join(dir, "files");
  mkdirSync(files);
  const ids = [];
  for (let i = 0; i <= MAX_PROJECT_ARTIFACTS; i++) {
    writeFileSync(join(files, "f" + i + ".txt"), String(i));
    ids.push(ws.artifacts.record(join(files, "f" + i + ".txt"), { botId: "pip", source: "tool", time: i }).id);
  }
  const id = projects.create({ name: "Full" });
  ws.artifacts.batch(() => { for (const artifact of ids.slice(0, MAX_PROJECT_ARTIFACTS)) projects.addArtifact(id, artifact); });
  assert.equal(projects.get(id).artifacts.length, 200);
  assert.throws(() => projects.addArtifact(id, ids[200]), /^Error: A project holds up to 200 artifacts\. Remove one first\.$/);
  assert.equal(projects.addArtifact(id, ids[0])[0], ids[0], "one that is already attached still moves to the front");
  projects.removeArtifact(id, ids[1]);
  assert.equal(projects.addArtifact(id, ids[200]).length, 200);
});

test("folder order, fallback, project defaults and a moved session's transcript", async (t) => {
  const { ws, projects, repo, dir } = setup(t);
  const second = join(dir, "mobile");
  mkdirSync(second);
  const p = projects.add(repo);
  const other = projects.create({ name: "Other", folder: second });
  projects.editFolder(p, "add", second);
  projects.editFolder(p, "add", second);
  assert.deepEqual(projects.get(p).folders, [repo, second]);
  projects.update(p, { mode: "plan" });
  const restored = new Workspace(ws.dir, async () => ({}), () => {});
  assert.deepEqual(restored.projects.get(p).folders, [repo, second]);
  assert.equal(restored.projects.get(p).mode, "plan");
  const id = projects.startChat(["pip"], p);
  const chat = ws.chat(id);
  assert.equal(chat.mode, "plan");
  assert.equal(ws.chat(projects.startChat(["pip"], p, "default")).mode, "default");
  projects.setChatProject(id, null);
  chat.established = true;
  chat.messages = [{ role: "user", text: "Keep my notes" }, { role: "assistant", text: "Notes saved" }];
  const provider = ws.sessionProvider(chat);
  const specs = [], deleted = [];
  provider.deleteSession = async (key) => deleted.push(key);
  provider.openSession = async (spec) => { specs.push(spec); return {}; };
  ws.runnerFor = async () => ({ provider });
  const nextTurn = async (folder) => {
    const count = deleted.length;
    assert.ok(chat.restartSession);
    chat.messages.push({ role: "user", text: "Continue" });
    await ws.openSession(chat, ws.bot("pip"), { id: "turn" }, { stopped: false });
    assert.deepEqual(deleted.slice(count), [id]);
    assert.equal(specs.at(-1).established, false);
    assert.equal(specs.at(-1).folder, folder);
    assert.match(specs.at(-1).instructions, /Keep my notes/);
    assert.match(specs.at(-1).instructions, /Notes saved/);
    assert.ok(!chat.restartSession);
  };
  projects.setChatProject(id, p);
  assert.equal(chat.mode, "plan");
  await nextTurn(repo);
  projects.setChatProject(id, p, "default", second);
  assert.equal(projects.folderFor(chat), second);
  assert.match(projects.context(chat, ws.bot("pip")), /Other project folder: repo/);
  await nextTurn(second);
  projects.editFolder(p, "default", second);
  assert.equal(projects.get(p).folder, second);
  assert.equal(chat.folder, undefined);
  projects.editFolder(p, "remove", second);
  assert.equal(projects.folderFor(chat), repo);
  await nextTurn(repo);
  projects.setChatProject(id, other);
  await nextTurn(second);
  projects.setChatProject(id, null);
  await nextTurn(join(ws.dir, "files", "pip"));
  projects.editFolder(p, "add", second);
  projects.setChatProject(id, p, undefined, second);
  rmSync(second, { recursive: true });
  assert.equal(projects.folderFor(chat), repo);
  projects.update(p, { mode: "default" });
  assert.equal(projects.get(p).mode, undefined);
});
