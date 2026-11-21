// What a chat's session gets for every skills folder that is not Botkins' own.
//
// A skill is a folder with a SKILL.md. The Copilot runtime reads the header of that file by
// itself, and a header can carry more than anybody was shown: `allowed-tools` lets a skill use
// the shell with no question, and `mcp-servers` and `hooks` start things. A linked skills folder
// can sit where a bot may write, so a tricked bot could write such a skill and the person would
// lose the permission question at the next session. For that reason the runtime never sees the
// person's own folder. It sees a copy that is made for this chat, in which each header is written
// again from a short list of keys (`plainHeaderFile` in desktop/plugin-runtime.mjs), as for the
// skills of a plugin.
//
// Botkins' own shipped skills are not copied here. They are Botkins' own files, and nobody else
// writes them.
//
// The rules of a copy:
// - Every folder and file keeps its name, so that a skill keeps its folder name, and switching
//   it off by name still works.
// - A symbolic link is never followed or copied, at any level, and not at the top either: a
//   source that is a link gives an empty copy. A name that starts with "." and `node_modules`
//   are left out, as `skillsIn` leaves them out too. The copy is at most 12 parts deep and holds
//   at most 5,000 files of one source. Past that it stops, and it does not fail.
// - A file called SKILL.md, in any letter case (a disk may not tell the cases apart), is written
//   again as a new file with a plain header. One that is larger than 1,000,000 bytes is left out.
// - Another Markdown file keeps the header it has: a paper or a template of a skill may have a
//   header of its own that the person needs. Only one whose header names tools or hooks is
//   written again, because nobody knows that the runtime never reads such a file as a skill.
// - Every other file is a hard link to the original, so nothing is copied and a large resource
//   costs nothing. When a link cannot be made (another disk, no right), the file is copied if it
//   is at most 50,000,000 bytes, else it is left out.
// - A copy is made again only when the source changed. A stamp of every folder and file of the
//   source (name, type, size, times, mode, inode) is kept for that. The stamp of the copy is
//   kept too, so a copy that was changed by someone else is made again.
// - Removing a copy removes names only. It never removes an original, and it never removes a
//   path that is not below the copy place.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { plainHeaderFile } from "./plugin-runtime.mjs";

const FOLDER = ".botkins-skills-runtime";
const MAX_DEPTH = 12;
const MAX_FILES = 5_000;
// (Folders are counted too, so a tree of empty folders cannot keep the walk busy.)
const MAX_ENTRIES = 20_000;
const MAX_SKILL_BYTES = 1_000_000;
const MAX_COPY_BYTES = 50_000_000;
const HEADER_CHARS = 65_536;
const RISKY_HEADER = /allowed[-_]?tools|mcp[-_]?servers|hooks/i;

const kept = new Map();

const safeId = (value, fallback = "chat") => {
  const id = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return !id || id === "." || id === ".." ? fallback : id;
};
const digest = (text) => createHash("sha256").update(text);
const skipped = (name) => name.startsWith(".") || name === "node_modules";

const lstatOrNull = (path, options) => {
  try {
    return lstatSync(path, options);
  } catch {
    return null;
  }
};

/** The copy place of the chats, and the one folder of a chat. */
const placeOf = (dir) => resolve(dir, FOLDER);
const below = (base, path) => path.startsWith(base + sep);

/** Removes a path only when it is below the copy place. A link is removed as a name, never followed. */
function removeBelow(dir, path) {
  const target = resolve(path);
  if (!below(placeOf(dir), target)) return;
  rmSync(target, { recursive: true, force: true });
  for (const key of [...kept.keys()]) if (key === target || below(target, key)) kept.delete(key);
}

/** Makes sure a path is a real folder that this module made. Anything else there (a file, a link) is taken away first. */
function realFolder(dir, path) {
  const info = lstatOrNull(path);
  if (info && !info.isDirectory()) {
    if (path === placeOf(dir)) rmSync(path, { recursive: true, force: true });
    else removeBelow(dir, path);
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Every folder and file of a tree that counts, in sorted order. `skip` says which names are left out.
 * Links are not entries. `capped` is for the source: past the limits the walk stops and does not fail.
 */
function scan(root, { skip = skipped, capped = true } = {}) {
  const entries = [];
  let files = 0;
  const walk = (parts) => {
    let names;
    try {
      names = readdirSync(join(root, ...parts)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (skip(name) || (capped && (files >= MAX_FILES || entries.length >= MAX_ENTRIES))) continue;
      const next = [...parts, name];
      if (capped && next.length > MAX_DEPTH) continue;
      const path = join(root, ...next);
      const info = lstatOrNull(path, { bigint: true });
      if (!info) continue;
      if (info.isDirectory()) {
        entries.push({ parts: next, path, info, type: "d" });
        walk(next);
      } else if (info.isFile()) {
        files++;
        entries.push({ parts: next, path, info, type: "f" });
      } else if (!capped) {
        // (In the copy, anything that is not a folder or a file is something that was put there by someone else.)
        entries.push({ parts: next, path, info, type: "x" });
      }
    }
  };
  walk([]);
  return entries;
}

/**
 * Two digests of a tree. `core` holds what a change of the content changes. `full` also holds the
 * time of the last change of the file's own data, which a person's edit cannot keep. That time
 * moves when a hard link is made to the file, so it counts only for a folder and for a file that
 * has no other name: a file that a copy links to would otherwise look changed after each copy.
 */
function stampOf(root, entries) {
  const rootInfo = lstatOrNull(root, { bigint: true });
  const line = (label, info, { ctime }) =>
    [label, info.isDirectory() ? "d" : info.isFile() ? "f" : "x", info.size, info.mtimeNs, ctime ? info.ctimeNs : "", info.mode, info.ino].join("\t");
  const core = digest("core\n");
  const full = digest("full\n");
  const add = (text, fullText) => {
    core.update(text + "\n");
    full.update(fullText + "\n");
  };
  add(rootInfo ? line("", rootInfo, { ctime: false }) : "absent", rootInfo ? line("", rootInfo, { ctime: true }) : "absent");
  for (const { parts, info } of entries) {
    const label = parts.join("/");
    add(line(label, info, { ctime: false }), line(label, info, { ctime: info.isDirectory() || info.nlink === 1n }));
  }
  return { core: core.digest("hex"), full: full.digest("hex") };
}

const treeStamp = (root, options) => stampOf(root, scan(root, options)).full;

/** The first part of a Markdown file's header block, or "" when it does not start with one. */
function headerBlock(text) {
  const start = /^﻿?\s*---[ \t]*\r?\n/.exec(text);
  if (!start) return "";
  const rest = text.slice(start[0].length, start[0].length + HEADER_CHARS);
  const end = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

function readStart(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const length = readSync(fd, buffer, 0, bytes, 0);
    return buffer.toString("utf8", 0, length);
  } finally {
    closeSync(fd);
  }
}

/** Puts one file of the source into the copy: written again, linked, copied, or left out. */
function place(fromPath, toPath, info) {
  const name = fromPath.split(sep).at(-1);
  const executable = (info.mode & 0o111n) !== 0n;
  const mode = executable ? 0o755 : 0o644;
  const again = (text) => writeFileSync(toPath, plainHeaderFile(text, "skill"), { mode });
  const size = Number(info.size);
  if (/^skill\.md$/i.test(name)) {
    if (size > MAX_SKILL_BYTES) return;
    return again(readFileSync(fromPath, "utf8"));
  }
  if (/\.md$/i.test(name) && RISKY_HEADER.test(headerBlock(readStart(fromPath, HEADER_CHARS * 4)))) {
    if (size > MAX_SKILL_BYTES) return;
    return again(readFileSync(fromPath, "utf8"));
  }
  try {
    linkSync(fromPath, toPath);
    // Some systems follow a link when they link. The file that was linked must be the file that was looked at.
    const made = lstatSync(toPath, { bigint: true });
    if (!made.isFile() || made.ino !== info.ino) {
      rmSync(toPath, { force: true });
      throw new Error("not the same file");
    }
    return;
  } catch {
    rmSync(toPath, { force: true });
  }
  if (size > MAX_COPY_BYTES) return;
  copyFileSync(fromPath, toPath);
  try {
    chmodSync(toPath, mode);
  } catch {}
}

function writeCopy(dir, source, copy, entries) {
  const base = placeOf(dir);
  realFolder(dir, base);
  realFolder(dir, resolve(copy, ".."));
  removeBelow(dir, copy);
  mkdirSync(copy, { recursive: true, mode: 0o700 });
  for (const { parts, path, type } of entries) {
    const to = join(copy, ...parts);
    try {
      if (type === "d") {
        mkdirSync(to, { recursive: true });
        continue;
      }
      // The file is looked at again: it can have become a link since the walk.
      const info = lstatSync(path, { bigint: true });
      if (info.isFile()) place(path, to, info);
    } catch {
      // A file that changed or disappeared while it was copied is left out.
    }
  }
}

/**
 * One copy of each source for one chat, in the order of the sources.
 * `dir` is the data folder, `sources` are the person's skills folders (never Botkins' own).
 * `revision` is a short digest that changes when anything in any source changes.
 */
export function sessionSkills({ dir, chatId, sources }) {
  const chatFolder = join(placeOf(dir), safeId(chatId));
  const directories = [];
  const cores = [];
  sources.forEach((source, index) => {
    const copy = join(chatFolder, index + "-" + digest(String(source)).digest("hex").slice(0, 10));
    directories.push(copy);
    const top = lstatOrNull(source);
    const entries = top?.isDirectory() ? scan(source) : [];
    const before = stampOf(source, entries);
    cores.push(before.core);
    const known = kept.get(copy);
    if (known && known.source === before.full && existsSync(copy) && known.copy === treeStamp(copy, { skip: () => false, capped: false })) return;
    kept.delete(copy);
    writeCopy(dir, source, copy, entries);
    // Linking moves the time of change of the original files, so the stamp is taken again after the copy was written.
    const afterEntries = top?.isDirectory() ? scan(source) : [];
    const after = stampOf(source, afterEntries);
    // A source that changed while it was copied is not kept: the next call writes it again.
    if (after.core === before.core) kept.set(copy, { source: after.full, copy: treeStamp(copy, { skip: () => false, capped: false }) });
  });
  return { directories, revision: digest(cores.join("\n")).digest("hex").slice(0, 16) };
}

/** Removes the copies of the chats that are not in `keepChatIds`. It never throws. */
export function sweepSkillCopies(dir, keepChatIds) {
  try {
    const base = placeOf(dir);
    const keep = new Set([...(keepChatIds ?? [])].map((id) => safeId(id)));
    for (const name of readdirSync(base)) {
      if (keep.has(name)) continue;
      try {
        removeBelow(dir, join(base, name));
      } catch {}
    }
  } catch {}
}
