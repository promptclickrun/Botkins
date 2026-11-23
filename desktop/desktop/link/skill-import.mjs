// The relay seals an already base64-encoded file. Three MiB fits after both encodings.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fromBufferPromise } from "yauzl";
import { parseSkill, slug } from "./skill-format.mjs";

export const MAX_UPLOAD = 3 * 1024 * 1024;
export const MAX_UNPACKED = 12 * 1024 * 1024;
export const MAX_ENTRIES = 512;
export const MAX_SKILLS = 24;

export function pickedSkill(path) {
  const info = statSync(path);
  if (!info.isFile() || info.size > MAX_UPLOAD) throw new Error("Choose a skill file of up to 3 MiB.");
  return { filename: basename(path), data: readFileSync(path).toString("base64") };
}

// Use the same portable paths on every host, including case-insensitive filesystems.
export function checkPath(path) {
  if (
    typeof path !== "string" ||
    path.length > 1000 ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[\\:<>"|?*\x00-\x1f]|[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
      )
  )
    throw new Error("Unsafe skill file path.");
}

async function unzip(bytes) {
  const archive = await fromBufferPromise(bytes, { lazyEntries: true, strictFileNames: true });
  const files = new Map();
  const executable = new Set();
  let total = 0;
  try {
    if (archive.entryCount > MAX_ENTRIES) throw new Error("Too many files in this zip (maximum 512).");
    for await (const entry of archive.eachEntry()) {
      const directory = entry.fileName.endsWith("/");
      const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
      checkPath(path);
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      const special = entry.externalFileAttributes & (0x08 | 0x40 | 0x400); // DOS volume, device or reparse point.
      if (special || (type && type !== (directory ? 0o040000 : 0o100000)))
        throw new Error("A skill zip may contain only regular files and directories.");
      if (directory) continue;
      if (files.has(path)) throw new Error("Duplicate file in skill zip.");
      total += entry.uncompressedSize;
      if (total > MAX_UNPACKED) throw new Error("The unpacked skills exceed 12 MiB.");
      // yauzl validates actual decompressed bytes against the entry's declared size while streaming.
      const chunks = [];
      for await (const chunk of await archive.openReadStreamPromise(entry)) chunks.push(chunk);
      if ((entry.externalFileAttributes >>> 16) & 0o111) executable.add(path);
      const bytes = Buffer.concat(chunks);
      if (crc32(bytes) !== entry.crc32) throw new Error("A file in the zip failed its checksum.");
      files.set(path, bytes);
    }
    return { files, executable };
  } finally {
    archive.close();
  }
}

export function importFiles(integrations, files, fallback, replace = [], executable = new Set()) {
  const manifests = [...files.keys()].filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"));
  if (manifests.length > MAX_SKILLS) throw new Error("A zip can contain up to 24 skills.");
  const roots = files.has("SKILL.md") ? [""] : manifests.map(dirname);
  if (!roots.length) throw new Error("No SKILL.md was found in this archive.");
  if (!Array.isArray(replace) || replace.length > MAX_SKILLS || !replace.every((s) => typeof s === "string"))
    throw new Error("Choose the skills to replace.");
  const stage = mkdtempSync(join(tmpdir(), "botkins-skills-"));
  let stagedSize = 0;
  let stagedFiles = 0;
  const standalone = new Set();
  try {
    const folders = roots.map((root, index) => {
      const name =
        slug(root ? basename(root) : fallback) || slug(parseSkill(files.get(root ? root + "/SKILL.md" : "SKILL.md").toString("utf8")).name);
      if (!name) throw new Error("This skill needs a file or folder name.");
      const folder = join(stage, String(index), name);
      for (const [path, data] of files) {
        checkPath(path);
        if (root && !path.startsWith(root + "/")) continue;
        if (++stagedFiles > MAX_ENTRIES) throw new Error("Too many files in the unpacked skill folders.");
        stagedSize += data.length;
        if (stagedSize > MAX_UNPACKED) throw new Error("The unpacked skill folders exceed 12 MiB.");
        const target = join(folder, path.slice(root ? root.length + 1 : 0));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data, { flag: "wx", mode: executable.has(path) ? 0o755 : 0o644 });
      }
      if (manifests.some((path) => path !== (root ? root + "/SKILL.md" : "SKILL.md") && (!root || path.startsWith(root + "/"))))
        standalone.add(folder);
      return folder;
    });
    return integrations.importSkillFolders(folders, replace, true, standalone);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export async function uploadSkill(integrations, { filename, data, replace } = {}) {
  checkPath(filename);
  if (filename.includes("/") || !/\.(md|zip)$/i.test(filename)) throw new Error("Choose a .md or .zip file.");
  if (typeof data !== "string" || data.length > (MAX_UPLOAD * 4) / 3) throw new Error("Choose a skill file of up to 3 MiB.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) throw new Error("Invalid skill file data.");
  const extension = extname(filename);
  const { files, executable } = extension.toLowerCase() === ".md" ? { files: new Map([["SKILL.md", bytes]]) } : await unzip(bytes);
  return importFiles(integrations, files, basename(filename, extension), replace, executable);
}
