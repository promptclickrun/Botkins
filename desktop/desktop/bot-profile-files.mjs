// A bot's personal working directory stays the same when a chat opens a project.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const profileFiles = ["AGENTS.md", "USER.md", "IDENTITY.md"];
const maxBytes = 64 * 1024;
const promptChars = 4000;

function profilePath(ws, botId, file, create = false) {
  ws.bot(botId);
  if (!/^[\w-]{1,80}$/.test(botId) || !profileFiles.includes(file)) throw new Error("Choose a bot profile file: " + profileFiles.join(", "));
  const base = join(realpathSync(ws.dir), "files");
  const folder = join(base, botId);
  for (const dir of [base, folder]) {
    if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (realpathSync(dir) !== dir) throw new Error("The bot profile folder must be inside its own workspace.");
  }
  return join(folder, file);
}

export function readProfile(ws, botId, file) {
  let fd;
  try {
    const path = profilePath(ws, botId, file);
    if (!lstatSync(path).isFile()) throw new Error("Use a regular profile file.");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("Use a regular profile file up to 64 KiB.");
    const bytes = Buffer.alloc(stat.size);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    return bytes.toString("utf8", 0, count);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeProfile(ws, botId, { file, previous, text }) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maxBytes) throw new Error("Use Markdown text up to 64 KiB.");
  if (readProfile(ws, botId, file) !== previous) throw new Error("The profile file changed. Read it again before saving.");
  const path = profilePath(ws, botId, file, true);
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
  ws.releaseBotSessions(botId, { busy: true });
  return { saved: file };
}

export function profileContext(ws, botId) {
  const parts = [];
  for (const file of profileFiles) {
    try {
      const text = readProfile(ws, botId, file).trim();
      if (text) parts.push(file + "\n" + text.slice(0, promptChars) + (text.length > promptChars ? "\n[Use profile_read for the rest.]" : ""));
    } catch {
      // An invalid optional document must not prevent a bot from starting a turn.
      parts.push(file + " could not be read.");
    }
  }
  return parts.length ? "\n\nBot profile\n" + parts.join("\n\n") : "";
}
