import { statSync } from "node:fs";

export const MAX_PROJECT_FOLDERS = 12;
export function folderFor(project, chat) {
  const exists = (path) => {
    try { return path && statSync(path).isDirectory(); }
    catch { return false; }
  };
  // A job in its own worktree works there until it is brought in or its worktree removed (desktop/jobs.mjs).
  if (chat?.job?.where === "worktree" && chat.job.state === "open" && exists(chat.job.path)) return chat.job.path;
  if (project?.folders?.includes(chat?.folder) && exists(chat.folder)) return chat.folder;
  return exists(project?.folder) ? project.folder : null;
}

export function repositoryName(input) {
  const invalid = () => new Error("Enter a GitHub repository as owner/repo or a GitHub URL.");
  if (typeof input !== "string" || input.length > 512) throw invalid();
  const path = input.trim().replace(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)/i, "").replace(/\/$/, "");
  const parts = path.split("/");
  if (parts.length !== 2) throw invalid();
  const [owner, leaf] = parts;
  const repo = leaf.replace(/\.git$/i, "");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(owner) || !/^[a-z0-9_.-]{1,100}$/i.test(repo) ||
      repo.startsWith("-") || repo.endsWith(".") || repo.toLowerCase() === ".git") throw invalid();
  return owner + "/" + repo;
}

export function changedFolders(folders, action, path) {
  const rest = folders.filter((f) => f !== path);
  if (action === "add") {
    if (folders.includes(path)) return folders;
    if (folders.length >= MAX_PROJECT_FOLDERS) throw new Error("A project holds up to " + MAX_PROJECT_FOLDERS + " folders.");
    return [...folders, path];
  }
  if (!folders.includes(path)) throw new Error("That folder is no longer in the project.");
  if (action === "default") return [path, ...rest];
  if (action === "remove") return rest;
  throw new Error("Unknown folder action.");
}
