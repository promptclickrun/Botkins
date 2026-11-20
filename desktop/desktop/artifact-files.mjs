// Host-side checks shared by the artifact index and user-initiated file actions.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

import mimeTypes from "mime";

const sourceText = new Set("log ts tsx jsx go rs swift kt toml ini patch diff jsonl".split(" "));
const chunkLimit = 512 * 1024;
export function absoluteFilePath(raw) {
  if (typeof raw !== "string" || raw.length > 4096 || /[\0\r\n]/.test(raw) || /^(?:\\\\|\/\/)/.test(raw) || raw.split(/[\\/]/).includes("..")) return null;
  if (raw.startsWith("~/")) raw = join(homedir(), raw.slice(2));
  if (!isAbsolute(raw)) return null;
  if (process.platform === "win32" && (!/^[a-z]:[\\/]/i.test(raw) || raw.slice(2).includes(":") || raw.split(/[\\/]/).some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) return null;
  return resolve(raw);
}

export function fileDetails(raw) {
  const absolute = absoluteFilePath(raw);
  if (!absolute) return null;
  try {
    const stat = lstatSync(absolute, { bigint: true });
    if (!stat.isFile() && !stat.isDirectory()) return null;
    const path = realpathSync(absolute);
    const extension = extname(path).slice(1).toLowerCase();
    const mime = stat.isDirectory() ? "inode/directory" : sourceText.has(extension) ? "text/plain" : mimeTypes.getType(path) || "application/octet-stream";
    const group = mime.split("/")[0];
    const kind = stat.isDirectory() ? "folder" : ["image", "audio", "video"].includes(group) ? group : "file";
    return { path, name: basename(path) || path, kind, mime, size: stat.isDirectory() ? null : Number(stat.size),
      identity: stat.dev + ":" + stat.ino, links: Number(stat.nlink), mode: Number(stat.mode) };
  } catch { return null; }
}

export function publicFile({ identity, links, mode, ...fields }) { return fields; }

function withFile(info, fn) {
  const fd = openSync(info.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.dev + ":" + stat.ino !== info.identity || realpathSync(info.path) !== info.path) throw new Error("The file changed. Open it again.");
    return fn(fd, Number(stat.size));
  } finally { closeSync(fd); }
}

export function chunk(info, artifact, { offset = 0, length = chunkLimit } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 1 || length > chunkLimit) throw new Error("Invalid file range.");
  if (info.kind === "folder") return { artifact, data: "", encoding: "base64", offset: 0, nextOffset: null };
  return withFile(info, (fd, size) => {
    if (offset > size) throw new Error("That position is past the end of the file.");
    const buffer = Buffer.alloc(Math.min(length, size - offset));
    const count = buffer.length ? readSync(fd, buffer, 0, buffer.length, offset) : 0;
    return { artifact: { ...artifact, size }, encoding: "base64", data: buffer.subarray(0, count).toString("base64"), offset, nextOffset: count && offset + count < size ? offset + count : null };
  });
}

// Opening an arbitrary extension with the OS can execute a program, shortcut or
// installer. Unknown formats still have a useful action in Finder or Explorer.
const documents = new Set("txt log md csv tsv json jsonl xml css yaml yml toml ini h c cpp hpp rs go ts tsx jsx java swift kt sql diff patch rtf pdf docx pptx xlsx odt ods odp jpg jpeg png gif webp bmp avif heic tiff mp4 mov webm mkv m4v avi mp3 m4a aac ogg flac wav opus zip".split(" "));
const appBundle = /\.(app|workflow|action|plugin|bundle|prefPane|service|saver|scptd|wdgt)$/i;
export async function openChatPath(shell, path, action = "open") {
  if (!["open", "reveal"].includes(action)) throw new Error("Unknown file action.");
  const info = fileDetails(path);
  if (!info) throw new Error("This file or folder is unavailable.");
  let reveal = action === "reveal";
  if (info.kind === "folder") reveal ||= appBundle.test(info.path) || (process.platform === "darwin" && !!fileDetails(join(info.path, "Contents", "Info.plist")));
  else {
    reveal ||= !documents.has(extname(info.path).slice(1).toLowerCase()) || (process.platform !== "win32" && (info.mode & 0o111) !== 0);
    if (!reveal) reveal = withFile(info, (fd) => {
      const bytes = Buffer.alloc(4);
      readSync(fd, bytes, 0, 4, 0);
      return /^(2321|4d5a|7f454c46|feedface|feedfacf|cefaedfe|cffaedfe|cafebabe|bebafeca|cafebabf|bfbafeca)/.test(bytes.toString("hex"));
    });
  }
  if (reveal) { shell.showItemInFolder(info.path); return; }
  const error = await shell.openPath(info.path);
  if (error) throw new Error(error);
}

export async function thumbnail(info, size, nativeImage) {
  if (!Number.isInteger(size) || size < 16 || size > 512) throw new Error("Invalid thumbnail size.");
  if (!["image", "video"].includes(info.kind) && info.mime !== "application/pdf") return null;
  // A host with nothing to draw pictures with (desktop/host/headless.mjs) has no thumbnails.
  if (!nativeImage) return null;
  try {
    let image;
    if (process.platform !== "linux") image = await nativeImage.createThumbnailFromPath(info.path, { width: size, height: size });
    else if (info.kind === "image" && info.size <= 8 * 1024 * 1024 && ["image/jpeg", "image/png"].includes(info.mime)) {
      image = withFile(info, (fd, len) => {
        if (len > 8 * 1024 * 1024) return null;
        const bytes = Buffer.alloc(len);
        const used = readSync(fd, bytes, 0, len, 0);
        return nativeImage.createFromBuffer(bytes.subarray(0, used));
      });
    }
    if (!image || image.isEmpty() || fileDetails(info.path)?.identity !== info.identity) return null;
    const { width, height } = image.getSize();
    if (Math.max(width, height) > size) image = image.resize(width > height ? { width: size } : { height: size });
    return { data: image.toJPEG(78).toString("base64"), mime: "image/jpeg" };
  } catch { return null; }
}
