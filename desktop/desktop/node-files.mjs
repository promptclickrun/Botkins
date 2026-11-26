// Scoped file operations for a Botkins node host.
//
// By default, every file operation is locked inside one of the node's shared folders (`project` id).
// An owner can also opt in to `wholeComputer` on the node (`project: "@computer"` or an absolute
// path when `wholeComputer` is enabled).
//
// Security guarantees:
// - Path traversal (`..`) and symlink escapes are blocked on every operation, including writes,
//   mkdir, move, delete, stat, and recursive search.
// - Read and write payloads are size-capped so remote calls cannot exhaust memory or transport limits.
// - Overwriting an existing file is explicitly distinguished from creating a new file so the node
//   host can require a separate destructive grant.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const WHOLE_COMPUTER_RESOURCE = "@computer";
export const MAX_FILE_READ_BYTES = 256 * 1024;
export const MAX_FILE_WRITE_BYTES = 256 * 1024;
export const MAX_LIST_ENTRIES = 200;
export const MAX_SEARCH_RESULTS = 200;
export const MAX_SEARCH_DEPTH = 12;
export const MAX_SEARCH_SCAN_BYTES = 128 * 1024;

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertNoNullByte(value, label = "Path") {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${label} is not valid.`);
  }
}

function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Resolves the filesystem scope for a node file operation.
 * Returns `{ root, resourceId, resourceName, wholeComputer }`.
 */
export function resolveFileScope({ projectId, projects = [], wholeComputer = false } = {}) {
  const wantsWhole = !projectId || projectId === WHOLE_COMPUTER_RESOURCE;
  if (wantsWhole) {
    if (!wholeComputer) {
      throw new Error(
        projectId === WHOLE_COMPUTER_RESOURCE
          ? "Whole-computer file access is turned off on this node."
          : "Pick a shared folder (whole-computer access is turned off on this node).",
      );
    }
    return {
      root: null,
      resourceId: WHOLE_COMPUTER_RESOURCE,
      resourceName: "Whole computer",
      wholeComputer: true,
    };
  }
  const project = projects.find((item) => item.id === projectId);
  if (!project) throw new Error("That folder is not shared by this node.");
  if (!existsSync(project.path)) throw new Error("That shared folder no longer exists on this node.");
  const root = realpathSync(project.path);
  return {
    root,
    resourceId: project.id,
    resourceName: project.name,
    wholeComputer: false,
  };
}

/**
 * Walks existing path prefixes from `start` down to `target`, ensuring no symlink escapes `root`.
 * For missing trailing segments (`allowMissing: true`), validates that the deepest existing ancestor
 * resolves inside `root` and that no remaining segment contains `..` or escapes.
 */
export function resolveScopedPath(scope, rawPath = "", { allowMissing = false, forbidRoot = false } = {}) {
  assertNoNullByte(rawPath, "Path");
  const trimmed = rawPath.trim();

  if (scope.wholeComputer) {
    if (!trimmed) throw new Error("Provide an absolute path for whole-computer file access.");
    const expanded = expandHome(trimmed);
    if (!isAbsolute(expanded)) {
      throw new Error("Whole-computer file operations require an absolute path.");
    }
    const normalized = resolve(expanded);
    if (forbidRoot && dirname(normalized) === normalized) {
      throw new Error("Refusing to modify or delete the filesystem root.");
    }
    if (existsSync(normalized)) {
      const real = realpathSync(normalized);
      if (forbidRoot && dirname(real) === real) {
        throw new Error("Refusing to modify or delete the filesystem root.");
      }
      return { absPath: real, displayPath: real, exists: true };
    }
    if (!allowMissing) throw new Error("Path does not exist on this node.");
    // Resolve deepest existing ancestor to canonicalize any symlinks in parent chain.
    const trailing = [];
    let cursor = normalized;
    while (!existsSync(cursor)) {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      trailing.unshift(basename(cursor));
      cursor = parent;
    }
    const realAncestor = existsSync(cursor) ? realpathSync(cursor) : cursor;
    const finalPath = resolve(realAncestor, ...trailing);
    if (forbidRoot && dirname(finalPath) === finalPath) {
      throw new Error("Refusing to modify or delete the filesystem root.");
    }
    return { absPath: finalPath, displayPath: finalPath, exists: false };
  }

  // Shared-folder scope: strictly inside `scope.root`.
  const root = scope.root;
  if (trimmed && isAbsolute(trimmed)) {
    // Allow absolute paths only if they already fall strictly inside `root`.
    const candidate = resolve(trimmed);
    if (!isInside(root, candidate)) {
      throw new Error("That path is outside the shared folder.");
    }
    return validateInsideRoot(root, candidate, { allowMissing, forbidRoot });
  }
  const rel = trimmed.replace(/^[/\\]+/, "");
  const candidate = resolve(root, rel);
  if (!isInside(root, candidate)) {
    throw new Error("That path is outside the shared folder.");
  }
  return validateInsideRoot(root, candidate, { allowMissing, forbidRoot });
}

function validateInsideRoot(root, candidate, { allowMissing, forbidRoot }) {
  // Check whether `candidate` itself exists (including broken symlinks via lstatSync).
  let lstat = null;
  try {
    lstat = lstatSync(candidate);
  } catch {
    lstat = null;
  }

  if (lstat) {
    if (lstat.isSymbolicLink()) {
      let targetReal;
      try {
        targetReal = realpathSync(candidate);
      } catch {
        throw new Error("Refusing to follow a broken symlink.");
      }
      if (!isInside(root, targetReal)) {
        throw new Error("That symlink points outside the shared folder.");
      }
      if (forbidRoot && targetReal === root) {
        throw new Error("Refusing to delete or move the shared folder root.");
      }
      return {
        absPath: targetReal,
        linkPath: candidate,
        displayPath: relative(root, candidate) || ".",
        exists: true,
        isSymlink: true,
      };
    }
    const real = realpathSync(candidate);
    if (!isInside(root, real)) {
      throw new Error("That path resolves outside the shared folder.");
    }
    if (forbidRoot && real === root) {
      throw new Error("Refusing to delete or move the shared folder root.");
    }
    return {
      absPath: real,
      displayPath: relative(root, real) || ".",
      exists: true,
      isSymlink: false,
    };
  }

  if (!allowMissing) {
    throw new Error("Path does not exist in the shared folder.");
  }

  // Walk upward to deepest existing ancestor and verify its realpath is inside `root`.
  const trailing = [];
  let cursor = candidate;
  while (cursor !== root) {
    let curStat = null;
    try {
      curStat = lstatSync(cursor);
    } catch {
      curStat = null;
    }
    if (curStat) break;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    trailing.unshift(basename(cursor));
    cursor = parent;
  }

  const realAncestor = realpathSync(cursor);
  if (!isInside(root, realAncestor)) {
    throw new Error("Parent directory resolves outside the shared folder.");
  }
  const finalPath = resolve(realAncestor, ...trailing);
  if (!isInside(root, finalPath)) {
    throw new Error("That path is outside the shared folder.");
  }
  if (forbidRoot && finalPath === root) {
    throw new Error("Refusing to delete or move the shared folder root.");
  }
  return {
    absPath: finalPath,
    displayPath: relative(root, finalPath) || ".",
    exists: false,
    isSymlink: false,
  };
}

/** Checks whether a write or move target already exists (so callers can gate overwrites separately). */
export function inspectWriteTarget(scope, rawPath) {
  const target = resolveScopedPath(scope, rawPath, { allowMissing: true });
  return { ...target, isOverwrite: target.exists };
}

export function nodeReadFile(scope, payload = {}) {
  const encoding = payload.encoding === "base64" ? "base64" : "utf8";
  const maxBytes =
    typeof payload.maxBytes === "number" && Number.isFinite(payload.maxBytes) && payload.maxBytes > 0
      ? Math.min(Math.floor(payload.maxBytes), MAX_FILE_READ_BYTES)
      : MAX_FILE_READ_BYTES;
  const offset =
    typeof payload.offset === "number" && Number.isFinite(payload.offset) && payload.offset >= 0
      ? Math.floor(payload.offset)
      : 0;
  const target = resolveScopedPath(scope, String(payload.path ?? ""), { allowMissing: false });
  const stat = statSync(target.absPath);
  if (!stat.isFile()) throw new Error("Target path is not a regular file.");
  if (offset === 0 && stat.size > maxBytes && payload.truncate !== true) {
    throw new Error(`File is ${stat.size} bytes, exceeding the ${maxBytes}-byte limit (pass offset/maxBytes or truncate: true to read a slice).`);
  }
  const raw = readFileSync(target.absPath);
  const slice = raw.subarray(offset, offset + maxBytes);
  return {
    path: target.displayPath,
    size: stat.size,
    offset,
    bytesRead: slice.length,
    truncated: offset + slice.length < raw.length,
    encoding,
    content: encoding === "base64" ? slice.toString("base64") : slice.toString("utf8"),
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

export function nodeWriteFile(scope, payload = {}) {
  const encoding = payload.encoding === "base64" ? "base64" : "utf8";
  if (typeof payload.content !== "string") {
    throw new Error("File content must be a string.");
  }
  const buffer = Buffer.from(payload.content, encoding);
  if (buffer.length > MAX_FILE_WRITE_BYTES) {
    throw new Error(`Write size ${buffer.length} bytes exceeds the ${MAX_FILE_WRITE_BYTES}-byte limit.`);
  }
  const target = resolveScopedPath(scope, String(payload.path ?? ""), { allowMissing: true, forbidRoot: true });
  if (target.exists) {
    if (payload.overwrite !== true) {
      throw new Error("File already exists. Pass overwrite: true to replace it.");
    }
    const stat = statSync(target.absPath);
    if (stat.isDirectory()) throw new Error("Cannot overwrite a directory with a file.");
  }
  const parent = dirname(target.absPath);
  if (!existsSync(parent)) {
    if (payload.createParents === true) {
      // Re-verify parent inside scope before creating.
      resolveScopedPath(scope, scope.wholeComputer ? parent : relative(scope.root, parent), { allowMissing: true });
      mkdirSync(parent, { recursive: true });
    } else {
      throw new Error("Parent directory does not exist (pass createParents: true to create it).");
    }
  }
  writeFileSync(target.absPath, buffer);
  return {
    path: target.displayPath,
    bytesWritten: buffer.length,
    created: !target.exists,
    overwritten: target.exists,
  };
}

export function nodeMkdir(scope, payload = {}) {
  const target = resolveScopedPath(scope, String(payload.path ?? ""), { allowMissing: true, forbidRoot: true });
  if (target.exists) {
    const stat = statSync(target.absPath);
    if (!stat.isDirectory()) throw new Error("A non-directory already exists at that path.");
    return { path: target.displayPath, created: false };
  }
  mkdirSync(target.absPath, { recursive: payload.recursive !== false });
  return { path: target.displayPath, created: true };
}

export function nodeMove(scope, payload = {}) {
  const from = resolveScopedPath(scope, String(payload.from ?? ""), { allowMissing: false, forbidRoot: true });
  const to = resolveScopedPath(scope, String(payload.to ?? ""), { allowMissing: true, forbidRoot: true });
  if (to.exists && payload.overwrite !== true) {
    throw new Error("Destination already exists. Pass overwrite: true to replace it.");
  }
  const toParent = dirname(to.absPath);
  if (!existsSync(toParent)) {
    throw new Error("Destination parent directory does not exist.");
  }
  try {
    renameSync(from.absPath, to.absPath);
  } catch (error) {
    if (error?.code === "EXDEV") {
      const stat = statSync(from.absPath);
      if (!stat.isFile()) throw new Error("Cannot move directories across filesystems.");
      copyFileSync(from.absPath, to.absPath);
      rmSync(from.absPath);
    } else {
      throw error;
    }
  }
  return {
    from: from.displayPath,
    to: to.displayPath,
    overwritten: to.exists,
  };
}

export function nodeDelete(scope, payload = {}) {
  const target = resolveScopedPath(scope, String(payload.path ?? ""), { allowMissing: false, forbidRoot: true });
  const stat = lstatSync(target.linkPath ?? target.absPath);
  const kind = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "file";
  if (kind === "dir" && payload.recursive !== true) {
    const children = readdirSync(target.absPath);
    if (children.length > 0) {
      throw new Error("Directory is not empty. Pass recursive: true to delete it.");
    }
  }
  rmSync(target.linkPath ?? target.absPath, {
    recursive: kind === "dir" ? payload.recursive === true : false,
    force: false,
  });
  return { path: target.displayPath, deleted: true, kind };
}

export function nodeStat(scope, payload = {}) {
  const raw = String(payload.path ?? "");
  let target;
  try {
    target = resolveScopedPath(scope, raw, { allowMissing: true });
  } catch (error) {
    throw error;
  }
  if (!target.exists) {
    return { path: target.displayPath, exists: false };
  }
  const stat = statSync(target.absPath);
  const type = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other";
  return {
    path: target.displayPath,
    exists: true,
    type,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    mode: stat.mode & 0o777,
    isSymlink: Boolean(target.isSymlink),
  };
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function nodeSearch(scope, payload = {}) {
  const start = resolveScopedPath(scope, String(payload.path ?? (scope.wholeComputer ? homedir() : "")), {
    allowMissing: false,
  });
  const startStat = statSync(start.absPath);
  if (!startStat.isDirectory()) throw new Error("Search root must be a directory.");
  const namePattern = typeof payload.pattern === "string" && payload.pattern.trim() ? payload.pattern.trim() : null;
  const contentQuery = typeof payload.query === "string" && payload.query.length > 0 ? payload.query : null;
  if (!namePattern && !contentQuery) {
    throw new Error("Provide a filename pattern or text query to search.");
  }
  const maxResults =
    typeof payload.limit === "number" && Number.isFinite(payload.limit) && payload.limit > 0
      ? Math.min(Math.floor(payload.limit), MAX_SEARCH_RESULTS)
      : MAX_SEARCH_RESULTS;
  const maxDepth =
    typeof payload.maxDepth === "number" && Number.isFinite(payload.maxDepth) && payload.maxDepth >= 0
      ? Math.min(Math.floor(payload.maxDepth), MAX_SEARCH_DEPTH)
      : MAX_SEARCH_DEPTH;
  const regex = namePattern ? globToRegExp(namePattern) : null;
  const needle = contentQuery ? contentQuery.toLowerCase() : null;
  const matches = [];
  let truncated = false;
  const visitedDirs = new Set();

  const walk = (dir, depth) => {
    if (truncated || depth > maxDepth) return;
    let realDir;
    try {
      realDir = realpathSync(dir);
    } catch {
      return;
    }
    if (!scope.wholeComputer && !isInside(scope.root, realDir)) return;
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries;
    try {
      entries = readdirSync(realDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(realDir, entry.name);
      let realEntry = full;
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          realEntry = realpathSync(full);
          if (!scope.wholeComputer && !isInside(scope.root, realEntry)) continue;
          const st = statSync(realEntry);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }

      const display = scope.wholeComputer ? realEntry : relative(scope.root, realEntry) || entry.name;
      const nameMatches = !regex || regex.test(entry.name) || regex.test(display);

      if (isFile && nameMatches) {
        if (needle) {
          try {
            const st = statSync(realEntry);
            if (st.size <= MAX_SEARCH_SCAN_BYTES) {
              const text = readFileSync(realEntry, "utf8");
              if (!text.includes("\0")) {
                const lines = text.split(/\r?\n/);
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].toLowerCase().includes(needle)) {
                    matches.push({
                      path: display,
                      type: "file",
                      line: i + 1,
                      snippet: lines[i].slice(0, 200),
                    });
                    if (matches.length >= maxResults) {
                      truncated = true;
                      return;
                    }
                    break;
                  }
                }
              }
            }
          } catch {
            // Skip unreadable files.
          }
        } else {
          matches.push({ path: display, type: "file" });
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
      } else if (isDir) {
        if (!needle && regex && nameMatches) {
          matches.push({ path: display, type: "dir" });
          if (matches.length >= maxResults) {
            truncated = true;
            return;
          }
        }
        walk(realEntry, depth + 1);
      }
    }
  };

  walk(start.absPath, 0);
  return {
    path: start.displayPath,
    matches,
    truncated,
  };
}
