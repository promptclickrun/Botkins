// Jobs: prompts sent from a project's page, one chat each ("project-jobs-v1").
//
// A job is a chat in a project started with one prompt for one bot. Each job works in its own git
// worktree, made from the person's current checkout (the branch and commit it is on), so jobs that
// run side by side never touch each other's files, or the checkout. This is how T3 Code's worktree
// threads work (a branch of their own from HEAD, in a folder of their own); the setup a new worktree
// needs comes from the repository, in `.botkins/worktrees.json`:
//
//   { "setup": ["npm ci", "cp \"$BOTKINS_CHECKOUT/.env\" .env"], "branch": "botkins/{topic}" }
//
// `setup` (Cursor's `setup-worktree` is read too) is a list of shell commands run in the new worktree,
// one after the other, before the prompt is sent. They are the repository's, so they run only after
// the person has seen them and said yes, once for each version of the list (`approveSetup`; the
// project keeps the yes as a hash). `$BOTKINS_CHECKOUT` (and Cursor's `$ROOT_WORKTREE_PATH`) is the
// checkout's folder, `$BOTKINS_WORKTREE` the job's.
//
// A job can also work in the checkout itself ("Your checkout"): one such job at a time per folder.
//
// When a job is done, "Bring in" commits what is left in its worktree, checks that the checkout is on
// the branch the job started from and has no uncommitted changes, checks for conflicts without
// touching anything (`git merge-tree`), merges the job's branch into the checkout, and removes the
// worktree. The branch stays, as in T3 Code. When the checkout's branch moved and the two clash,
// nothing is merged: "Catch up" asks the job's bot to merge the branch in its own worktree.
//
// Git runs here with the repository's hooks, filters and programs off (SAFE in projects.mjs).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { assertProject } from "./access.mjs";
import { textField } from "./panels.mjs";
import { ENV, filterOverrides, SAFE } from "./projects.mjs";

const run = promisify(execFile);

export const PROJECT_JOBS = "project-jobs-v1";
export const JOB_CALLS = ["projectJobSetup", "approveJobSetup", "startProjectJob", "projectJobStatus", "bringInJob", "catchUpJob", "removeJobWorktree", "startJobTurn"];
export const CONFIG_FILE = ".botkins/worktrees.json";
export const DEFAULT_BRANCH = "botkins/{topic}";
const MAX_BOTS = 6;
const MAX_SETUP = 20;
const SETUP_LIMIT_MS = 10 * 60_000;
/** The files a setup made that are kept, to leave them out of the job's changes. */
const MAX_SETUP_FILES = 500;

const lastLine = (error) => String(error?.stderr || error?.message || "git failed").trim().split("\n").at(-1);

/** Runs git with the repository's own programs off. `long` is for work that can take a while (a new worktree, a merge). */
async function git(cwd, args, { allowFail = false, long = false } = {}) {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...SAFE, ...(await filterOverrides(cwd)), ...args], { maxBuffer: 16 * 1024 * 1024, timeout: long ? SETUP_LIMIT_MS : 30_000, env: ENV });
    return stdout;
  } catch (error) {
    if (allowFail) return null;
    throw new Error(lastLine(error));
  }
}
/** The same, with the exit code: `{ code, stdout }`. */
async function gitCode(cwd, args) {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...SAFE, ...(await filterOverrides(cwd)), ...args], { maxBuffer: 16 * 1024 * 1024, timeout: SETUP_LIMIT_MS, env: ENV });
    return { code: 0, stdout };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : -1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

/** A prompt as the topic of a branch name: its first words, lower case, joined with dashes. */
export function topicOf(prompt) {
  const words = String(prompt).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}\s-]/gu, " ").match(/[a-z0-9]+/g) ?? [];
  let topic = "";
  for (const word of words) {
    if ((topic + "-" + word).length > 32) break;
    topic = topic ? topic + "-" + word : word;
  }
  return topic || "job";
}

/** The job's branch: the pattern with its topic, and the job's id at the end when the plain name is taken. */
export function branchFor(prompt, pattern = DEFAULT_BRANCH) {
  return pattern.replace("{topic}", topicOf(prompt));
}

/**
 * `.botkins/worktrees.json` as the app uses it. A missing file is no setup and the default branch
 * name; a file that can't be read is an error the page shows. `hash` names this version of the list.
 */
export function parseConfig(text) {
  if (text === null || text === undefined) return { setup: [], branch: DEFAULT_BRANCH, file: false, hash: "" };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { setup: [], branch: DEFAULT_BRANCH, file: true, hash: "", error: CONFIG_FILE + " is not valid JSON." };
  }
  const setup = data?.setup ?? data?.["setup-worktree-unix"] ?? data?.["setup-worktree"] ?? [];
  const list = typeof setup === "string" ? [setup] : setup;
  if (!Array.isArray(list) || list.length > MAX_SETUP || list.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 1000 || entry.includes("\0")))
    return { setup: [], branch: DEFAULT_BRANCH, file: true, hash: "", error: "\"setup\" in " + CONFIG_FILE + " is a list of up to " + MAX_SETUP + " commands." };
  const branch = data?.branch ?? DEFAULT_BRANCH;
  if (typeof branch !== "string" || !branch.includes("{topic}") || branch.length > 100 || /\s|\.\.|[~^:?*[\\]|^\/|\/$|\.lock$|@\{/.test(branch.replace("{topic}", "x")))
    return { setup: [], branch: DEFAULT_BRANCH, file: true, hash: "", error: "\"branch\" in " + CONFIG_FILE + " is a branch name with {topic} in it." };
  const commands = list.map((entry) => entry.trim());
  return { setup: commands, branch, file: true, hash: commands.length ? createHash("sha256").update(JSON.stringify(commands)).digest("hex").slice(0, 16) : "" };
}
export function readConfig(root) {
  let text = null;
  try {
    text = readFileSync(join(root, CONFIG_FILE), "utf8");
  } catch {}
  return parseConfig(text);
}

/** `git merge-tree --write-tree --name-only` as the conflicting files: [] when the two merge cleanly. */
export function parseMergeTree(code, stdout) {
  if (code === 0) return [];
  if (code !== 1) return null;
  const lines = stdout.split("\n").slice(1);
  const end = lines.indexOf("");
  return [...new Set((end < 0 ? lines : lines.slice(0, end)).filter(Boolean))];
}
async function conflictsOf(root, base, tip) {
  const { code, stdout } = await gitCode(root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, tip]);
  return parseMergeTree(code, stdout);
}

/** Lines of `git diff --numstat -z`: each file's path and its added and removed lines. */
export function parseNumstat(text) {
  const parts = String(text ?? "").split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let path = m[3];
    if (!path) {
      path = parts[i + 2] ?? "";
      i += 2;
    }
    files.push({ path, added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return files;
}

/** A job's title: the prompt's first line, cut at 80 characters. */
export const titleOf = (prompt) => {
  const line = String(prompt).trim().split("\n")[0];
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
};

/** What a job's bot is asked when the checkout moved on and their changes clash. */
export const catchUpPrompt = (job, conflicts) =>
  "The branch " + job.base + " moved on since this job started" + (conflicts?.length ? ", and it clashes with your changes in " + conflicts.join(", ") : "") +
  ". In your worktree, merge " + job.base + " into " + job.branch + ", resolve any conflicts, check that it still works, and commit the result.";

/** The files in a worktree that git doesn't track yet (ignored ones left out). */
async function untracked(path) {
  return ((await git(path, ["ls-files", "--others", "--exclude-standard", "-z"], { allowFail: true })) ?? "").split("\0").filter(Boolean);
}
/** Every path `git status` names in a worktree, untracked files one by one. */
async function changedPaths(path) {
  const parts = ((await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { allowFail: true })) ?? "").split("\0");
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or a copy names where it came from in the next entry.
    if (entry[0] === "R" || entry[0] === "C") i++;
  }
  return paths;
}
/** A file the setup made: the setup's, not the job's. */
const setupOnly = (job, path) => !!job.setupFiles?.includes(path);
/**
 * Commits what a job left uncommitted in its worktree, but what its setup made. Hooks don't run (SAFE).
 * Nothing is committed when nothing else is left.
 */
async function commitLeftovers(job, message) {
  if (!(await changedPaths(job.path)).some((path) => !setupOnly(job, path))) return;
  await git(job.path, ["add", "-A"]);
  const setup = (job.setupFiles ?? []).filter((path) => existsSync(join(job.path, path)));
  for (let i = 0; i < setup.length; i += 100) await git(job.path, ["reset", "-q", "--", ...setup.slice(i, i + 100)], { allowFail: true });
  if ((await gitCode(job.path, ["diff", "--cached", "--quiet"])).code === 0) return;
  await git(job.path, ["commit", "--no-verify", "-m", message]);
}

export class Jobs {
  constructor(ws) {
    this.ws = ws;
  }
  job(chatId) {
    const chat = this.ws.chat(chatId);
    if (!chat.job) throw new Error("This chat is not a job.");
    return chat;
  }
  idle(chat) {
    if (this.ws.active.has(chat.id)) throw new Error("Wait for the job to finish first.");
  }

  /** Where a project's jobs would start: its repository, the checkout's branch and commit, and the setup to run. */
  async setupOf(projectId, folder) {
    const project = this.ws.projects.get(projectId);
    if (!project.folder) return { repo: false };
    const path = this.ws.projects.folderOf(projectId, folder);
    const root = (await git(path, ["rev-parse", "--show-toplevel"], { allowFail: true }))?.trim();
    if (!root) return { repo: false, folder: path };
    const base = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true }))?.trim() || null;
    const sha = (await git(root, ["rev-parse", "-q", "--verify", "HEAD"], { allowFail: true }))?.trim() || null;
    const changed = ((await git(root, ["status", "--porcelain=v1", "--untracked-files=no"], { allowFail: true })) ?? "").split("\n").filter(Boolean).length;
    const config = readConfig(root);
    return {
      repo: true,
      folder: path,
      root,
      base,
      sha,
      short: sha ? sha.slice(0, 7) : null,
      changed,
      setup: config.setup,
      branch: config.branch,
      file: config.file,
      hash: config.hash,
      ...(config.error && { error: config.error }),
      approved: !config.setup.length || project.jobSetup?.[root] === config.hash,
    };
  }

  /** The person saw the setup commands and said yes: kept for this version of the list (`hash`). */
  async approveSetup(projectId, folder, hash) {
    const project = this.ws.projects.get(projectId);
    const info = await this.setupOf(projectId, folder);
    if (!info.repo) throw new Error("This project's folder is not a git repository.");
    if (!info.hash || info.hash !== hash) throw new Error("The setup commands changed. Look at them again.");
    project.jobSetup = { ...project.jobSetup, [info.root]: hash };
    this.ws.save();
    return info.root;
  }

  /**
   * Starts one job for each bot: a chat in the project, a worktree (unless `where` is "checkout"), the
   * setup, then the prompt. Returns the chats' ids. `options`: { botIds, prompt, where?, folder?, mode?, carry? }.
   */
  async start(projectId, options = {}, author) {
    const prompt = textField(options?.prompt, 32000, "prompt");
    const botIds = [...new Set(Array.isArray(options?.botIds) ? options.botIds : [])];
    if (!botIds.length || botIds.length > MAX_BOTS || botIds.some((id) => typeof id !== "string")) throw new Error("Choose 1 to " + MAX_BOTS + " bots.");
    const where = options.where === "checkout" ? "checkout" : "worktree";
    const project = this.ws.projects.get(projectId);
    // Every bot is checked before any job starts: a refusal halfway would leave some jobs started.
    for (const id of botIds) assertProject(this.ws.state, this.ws.bot(id), project);
    let info = null;
    let folder = null;
    if (where === "worktree") {
      if (!project.folder) throw new Error("A job in its own worktree needs a project folder that is a git repository. Choose “Your checkout”.");
      info = await this.setupOf(projectId, options.folder);
      if (!info.repo) throw new Error("This project's folder is not a git repository. Choose “Your checkout”.");
      if (!info.sha) throw new Error("This repository has no commits yet. Make a first commit, then start a job.");
      if (info.error) throw new Error(info.error);
      if (!info.approved) throw new Error("Look at this project's setup commands and allow them first.");
      folder = info.folder;
    } else {
      folder = project.folder ? this.ws.projects.folderOf(projectId, options.folder) : null;
      if (botIds.length > 1) throw new Error("Jobs in your checkout go one at a time. Choose one bot, or give each its own worktree.");
      const busy = this.ws.projects.chats(projectId).find((c) => c.job?.where === "checkout" && c.job.state === "open" && (c.job.folder ?? null) === folder && this.ws.active.has(c.id));
      if (busy) throw new Error("A job is working in your checkout. Give this one its own worktree, or wait for it.");
    }
    // Changes not yet committed in the checkout go with each job when asked ("Bring uncommitted changes").
    const carry = where === "worktree" && options.carry === true && info.changed ? (await git(info.root, ["stash", "create"], { allowFail: true }))?.trim() || null : null;
    const ids = [];
    for (const botId of botIds) {
      const chatId = this.ws.projects.startChat([botId], projectId, options.mode, options.folder);
      const chat = this.ws.chat(chatId);
      chat.title = titleOf(prompt);
      chat.job = { prompt, where, state: "open", createdAt: Date.now(), ...(folder && { folder }) };
      if (where === "worktree") {
        try {
          await this.makeWorktree(chat, info, carry);
        } catch (error) {
          chat.job.setup = "failed";
          chat.job.setupError = "The worktree couldn't be made: " + (error?.message ?? error);
        }
      }
      this.ws.save();
      ids.push(chatId);
      if (chat.job.setup !== "failed") void this.begin(chat, author);
    }
    return ids;
  }

  async makeWorktree(chat, info, carry) {
    let branch = branchFor(chat.job.prompt, info.branch);
    if ((await git(info.root, ["show-ref", "--verify", "--quiet", "refs/heads/" + branch], { allowFail: true })) !== null) branch += "-" + chat.id.replace(/-/g, "").slice(0, 6);
    if ((await git(info.root, ["check-ref-format", "--branch", branch], { allowFail: true })) === null) branch = "botkins/job-" + chat.id.replace(/-/g, "").slice(0, 8);
    const path = join(this.ws.dir, "worktrees", chat.id);
    mkdirSync(dirname(path), { recursive: true });
    await git(info.root, ["worktree", "add", "-b", branch, path, info.sha], { long: true });
    // The commands that run are the ones the person allowed (their hash was checked in `start`), kept with the job: a list changed since doesn't run.
    Object.assign(chat.job, { root: info.root, base: info.base ?? info.sha, baseSha: info.sha, branch, path, setup: info.setup.length ? "waiting" : "none", ...(info.setup.length && { commands: info.setup }) });
    if (carry && (await git(path, ["stash", "apply", carry], { allowFail: true })) === null) chat.job.carryFailed = true;
  }

  /** Runs the setup in the job's worktree, then sends its prompt. A setup that fails stops there: the page offers "Start anyway". */
  async begin(chat, author) {
    const job = chat.job;
    if (job.where === "worktree" && job.setup === "waiting") {
      job.setup = "running";
      this.ws.save();
      for (const command of job.commands ?? []) {
        try {
          const shell = process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", command]] : ["/bin/sh", ["-c", command]];
          await run(shell[0], shell[1], { cwd: job.path, timeout: SETUP_LIMIT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, BOTKINS_CHECKOUT: job.root, ROOT_WORKTREE_PATH: job.root, BOTKINS_WORKTREE: job.path } });
        } catch (error) {
          job.setup = "failed";
          const said = String(error?.stderr || error?.stdout || error?.message || "").trim().split("\n").slice(-3).join("\n");
          job.setupError = ("“" + command + "” failed" + (said ? ": " + said : ".")).slice(0, 600);
          this.ws.save();
          return;
        }
      }
      job.setup = "done";
      // What the setup made that git would see (a copied .env that isn't ignored, say) is the setup's, not the job's:
      // it is left out of the job's changes and of what Bring in commits.
      job.setupFiles = (await untracked(job.path)).slice(0, MAX_SETUP_FILES);
      this.ws.save();
    }
    this.send(chat, author);
  }
  send(chat, author) {
    try {
      const turn = this.ws.submit(chat.id, chat.job.prompt, { delivery: "queue", ...(author && { author }) });
      turn?.catch?.((error) => console.error("Job turn:", error?.message ?? error));
    } catch (error) {
      console.error("Job turn:", error?.message ?? error);
    }
  }
  /** "Start anyway": sends the prompt of a job whose setup failed or was not run. */
  startTurn(chatId, author) {
    const chat = this.job(chatId);
    this.idle(chat);
    if (chat.job.setup !== "failed" && chat.job.setup !== "waiting") throw new Error("This job has started already.");
    if (chat.job.where === "worktree" && !existsSync(chat.job.path ?? "")) throw new Error("This job has no worktree.");
    chat.job.setup = "skipped";
    this.ws.save();
    this.send(chat, author);
  }

  /** What the job changed, how far the checkout's branch moved since, what clashes, and whether it can be brought in now. */
  async status(chatId) {
    const chat = this.job(chatId);
    const job = chat.job;
    const working = this.ws.active.has(chat.id);
    if (job.where !== "worktree" || !job.root) return { where: job.where, state: job.state, working, canBringIn: false, reason: job.where === "checkout" ? "Its changes are in your checkout already." : "This job has no worktree." };
    const exists = !!job.path && existsSync(job.path);
    let tip = job.branch;
    let uncommitted = 0;
    if (exists) {
      // A commit of the worktree as it is, uncommitted changes included, made without touching it.
      const snapshot = (await git(job.path, ["stash", "create"], { allowFail: true }))?.trim();
      if (snapshot) tip = snapshot;
      uncommitted = (await changedPaths(job.path)).filter((path) => !setupOnly(job, path)).length;
    }
    const known = (await git(job.root, ["rev-parse", "-q", "--verify", job.base], { allowFail: true })) !== null;
    const base = known ? job.base : job.baseSha;
    const fork = (await git(job.root, ["merge-base", base, tip], { allowFail: true }))?.trim() || job.baseSha;
    const behind = Number((await git(job.root, ["rev-list", "--count", fork + ".." + base], { allowFail: true })) ?? 0) || 0;
    const ahead = Number((await git(job.root, ["rev-list", "--count", fork + ".." + job.branch], { allowFail: true })) ?? 0) || 0;
    const files = parseNumstat(await git(job.root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", fork, tip], { allowFail: true }));
    const fresh = exists ? (await untracked(job.path)).filter((path) => !setupOnly(job, path)) : [];
    for (const path of fresh.slice(0, 200)) if (!files.some((file) => file.path === path)) files.push({ path, added: 0, removed: 0, new: true });
    const conflicts = job.state === "open" ? await conflictsOf(job.root, base, tip) : [];
    const checkout = (await git(job.root, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true }))?.trim() || null;
    const checkoutChanged = ((await git(job.root, ["status", "--porcelain=v1", "--untracked-files=no"], { allowFail: true })) ?? "").split("\n").filter(Boolean).length;
    const reason =
      job.state === "brought-in" ? "Brought in." :
      job.state === "removed" ? "Its worktree was removed." :
      working ? "The bot is still working." :
      !exists ? "Its worktree is gone." :
      !files.length ? "Nothing changed yet." :
      conflicts === null ? "This computer's git is too old to check for conflicts (2.38 or newer is needed)." :
      conflicts.length ? "It clashes with " + job.base + " in " + conflicts.length + (conflicts.length === 1 ? " file." : " files.") :
      checkout !== job.base ? "Your checkout is on " + (checkout ?? "no branch") + ". Switch it to " + job.base + " first." :
      checkoutChanged ? "Your checkout has changes that aren't committed. Commit or stash them first." : "";
    return {
      where: job.where,
      state: job.state,
      working,
      branch: job.branch,
      base: job.base,
      baseSha: job.baseSha.slice(0, 7),
      exists,
      ahead,
      behind,
      uncommitted,
      files: files.slice(0, 300),
      added: files.reduce((n, file) => n + file.added, 0),
      removed: files.reduce((n, file) => n + file.removed, 0),
      conflicts: conflicts ?? [],
      ...(conflicts === null && { conflictsUnknown: true }),
      checkout,
      checkoutChanged,
      canBringIn: job.state === "open" && !reason,
      reason,
      ...(job.mergedSha && { mergedSha: job.mergedSha }),
    };
  }

  /** "Bring in": commits what is left in the worktree, merges the job's branch into the checkout, and removes the worktree. */
  async bringIn(chatId, message) {
    const chat = this.job(chatId);
    this.idle(chat);
    const job = chat.job;
    if (job.where !== "worktree") throw new Error("This job worked in your checkout: its changes are there already.");
    if (job.state !== "open") throw new Error(job.state === "brought-in" ? "This job was brought in already." : "This job's worktree was removed.");
    if (!job.path || !existsSync(job.path)) throw new Error("This job's worktree is gone.");
    const words = message === undefined || message === null || message === "" ? "Botkins: " + titleOf(job.prompt) : textField(message, 2000, "commit message");
    await commitLeftovers(job, words);
    const checkout = (await git(job.root, ["symbolic-ref", "--short", "-q", "HEAD"], { allowFail: true }))?.trim() || null;
    if (checkout !== job.base) throw new Error("Your checkout is on " + (checkout ?? "no branch") + ". Switch it to " + job.base + ", then bring the job in.");
    if (((await git(job.root, ["status", "--porcelain=v1", "--untracked-files=no"])) ?? "").trim()) throw new Error("Your checkout has changes that aren't committed. Commit or stash them, then bring the job in.");
    const conflicts = await conflictsOf(job.root, job.base, job.branch);
    if (conflicts === null) throw new Error("This computer's git is too old to check for conflicts first (2.38 or newer is needed).");
    if (conflicts.length) return { ok: false, conflicts };
    const merged = await gitCode(job.root, ["merge", "--no-ff", "--no-edit", "-m", "Bring in " + job.branch + ": " + titleOf(job.prompt), job.branch]);
    if (merged.code !== 0) {
      await git(job.root, ["merge", "--abort"], { allowFail: true });
      throw new Error("The merge didn't finish: " + String(merged.stderr || merged.stdout).trim().split("\n").at(-1));
    }
    job.mergedSha = (await git(job.root, ["rev-parse", "--short", "HEAD"])).trim();
    await this.dropWorktree(job);
    job.state = "brought-in";
    job.broughtAt = Date.now();
    this.ws.save();
    return { ok: true, commit: job.mergedSha };
  }

  /** "Catch up": asks the job's bot to merge the checkout's branch into its own, in its worktree. */
  async catchUp(chatId, author) {
    const chat = this.job(chatId);
    this.idle(chat);
    const job = chat.job;
    if (job.where !== "worktree" || job.state !== "open") throw new Error("Only an open job in its own worktree can catch up.");
    const conflicts = await conflictsOf(job.root, job.base, job.branch);
    const turn = this.ws.submit(chat.id, catchUpPrompt(job, conflicts ?? []), { delivery: "queue", ...(author && { author }) });
    turn?.catch?.((error) => console.error("Job turn:", error?.message ?? error));
  }

  /** Removes a job's worktree and keeps its branch. */
  async removeWorktree(chatId) {
    const chat = this.job(chatId);
    this.idle(chat);
    if (chat.job.where !== "worktree" || chat.job.state !== "open") throw new Error("This job has no worktree to remove.");
    // What wasn't committed goes on the job's branch first: the branch stays, so nothing is lost.
    const path = chat.job.path;
    if (path && existsSync(path)) await commitLeftovers(chat.job, "Botkins: unfinished work of " + titleOf(chat.job.prompt)).catch(() => {});
    await this.dropWorktree(chat.job);
    chat.job.state = "removed";
    this.ws.save();
  }
  async dropWorktree(job) {
    delete job.setupFiles;
    if (!job.path) return;
    await git(job.root, ["worktree", "remove", "--force", job.path], { allowFail: true });
    if (existsSync(job.path)) rmSync(job.path, { recursive: true, force: true });
    await git(job.root, ["worktree", "prune"], { allowFail: true });
  }
  /** A deleted chat's worktree goes with it. The branch stays. */
  forget(chat) {
    if (chat?.job?.where === "worktree" && chat.job.state === "open" && chat.job.path) void this.dropWorktree(chat.job).catch(() => {});
  }
}
