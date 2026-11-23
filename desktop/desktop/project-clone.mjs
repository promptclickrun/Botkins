import { lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { homedir, devNull } from "node:os";
import { isAbsolute, join } from "node:path";
import { repositoryName } from "./link/project-folders.mjs";
import { findTool, inherit, runTool, searchDirs, toolEnv } from "./link/tools.mjs";

const running = new Set();
export async function cloneProjectRepository(repository, parent, attach, { find = findTool, run = runTool } = {}) {
  const repo = repositoryName(repository);
  if (parent && !isAbsolute(parent)) throw new Error("Choose an absolute parent folder on the computer.");
  parent ||= homedir();
  mkdirSync(parent, { recursive: true });
  const dest = join(parent, repo.split("/")[1]);
  const checkDestination = () => {
    const stat = lstatSync(dest, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || readdirSync(dest).length)) throw new Error("The destination folder is not empty. Choose another parent.");
    return !!stat;
  };
  checkDestination();
  if (running.has(dest)) throw new Error("A clone into that folder is already running.");
  const dirs = searchDirs();
  const git = find("git", dirs);
  if (!git) throw new Error("Install Git on the computer to clone a repository.");
  const gh = find("gh", dirs);
  const env = toolEnv(dirs, { ...inherit(["GH_", "GITHUB_TOKEN"]), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", GIT_PAGER: "cat" });
  env.GH_HOST = "github.com";
  for (const key of ["XDG_CONFIG_HOME", "SSH_AUTH_SOCK"]) if (process.env[key]) env[key] = process.env[key];
  // A checkout must not execute filter drivers from the computer's system or global git config.
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = devNull;
  const config = { "core.fsmonitor": "false", "core.hooksPath": devNull, "diff.external": "", "core.pager": "cat", "commit.gpgSign": "false", "credential.helper": "" };
  env.GIT_CONFIG_COUNT = String(Object.keys(config).length);
  Object.entries(config).forEach(([key, value], i) => {
    env["GIT_CONFIG_KEY_" + i] = key;
    env["GIT_CONFIG_VALUE_" + i] = value;
  });
  const stage = mkdtempSync(join(parent, ".botkins-clone-"));
  const checkout = join(stage, "checkout");
  running.add(dest);
  try {
    const signedIn = gh && await run("GitHub CLI", gh, ["auth", "status", "--hostname", "github.com"], { env }).then(() => true, () => false);
    try {
      const options = { env, cwd: stage, keepError: true, timeout: 240_000 };
      if (signedIn) await run("GitHub CLI", gh, ["repo", "clone", "--no-upstream", "--", repo, checkout], options);
      else await run("Git", git, ["clone", "--", "https://github.com/" + repo + ".git", checkout], options);
    } catch (error) {
      if (/not found|could not resolve to a Repository|authentication|username|403|404|permission denied/i.test(error.detail ?? ""))
        throw new Error("Repository not found or access denied." + (gh && !signedIn ? " Sign in to GitHub CLI on the computer for private repositories." : ""));
      throw new Error("Clone failed. Check the computer's network connection and GitHub access.");
    }
    const empty = checkDestination();
    if (empty) rmdirSync(dest);
    try {
      renameSync(checkout, dest);
      try { return attach(dest); }
      catch (error) { renameSync(dest, checkout); throw error; }
    } catch (error) {
      if (empty) mkdirSync(dest, { recursive: true });
      throw error;
    }
  } finally {
    running.delete(dest);
    rmSync(stage, { recursive: true, force: true });
  }
}
