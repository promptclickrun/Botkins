// Files a phone sends to the computer, to attach to a message. They are kept per phone:
//   <dir>/uploads/<deviceId>/<id>-<name>
// A small file is one call. A larger one goes in parts with the same id. Files are private to the
// phone that sent them: a message may attach only a file from its own phone's folder (ownFile).
import { mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { b64u, random } from "./crypto.mjs";
import { Failure } from "./tools.mjs";

export const MAX_CALL = 4 * 1024 * 1024;
const MB = 1024 * 1024;
const NAME_MAX = 120;

/** A name as a file name on any system: no folders, no control characters, nothing hidden, not too long. */
export function safeName(value) {
  let name = String(value ?? "").normalize("NFC").replace(/\\/g, "/").split("/").pop();
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[<>:"|?*]/g, "_").trim().replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = "_" + name;
  if (name.length > NAME_MAX) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 20 ? name.slice(dot) : "";
    name = Array.from(name.slice(0, NAME_MAX - extension.length)).join("") + extension;
  }
  return name || "file";
}

function decode(data) {
  if (typeof data !== "string") throw new Failure("That file can't be sent.");
  if (data.length > Math.ceil(MAX_CALL / 3) * 4 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) throw new Failure("Send up to 4 MB at a time.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_CALL) throw new Failure("Send up to 4 MB at a time.");
  return bytes;
}

const cleanDevice = (id) => {
  if (typeof id !== "string" || !/^[\w-]{1,60}$/.test(id)) throw new Failure("This phone isn't paired.");
  return id;
};

export class Uploads {
  /** `limits` is for tests: { file, device, age, idle } in bytes and milliseconds, and { files } in files. */
  constructor({ dir, limits = {}, now = Date.now, log = () => {} }) {
    this.root = join(dir, "uploads");
    this.limits = { file: 25 * MB, device: 200 * MB, files: 200, open: 8, age: 7 * 24 * 60 * 60_000, idle: 10 * 60_000, ...limits };
    this.now = now;
    this.open = new Map(); // "<device>/<id>" → { path, name, size, used }
    this.gone = new Set(); // phones that were removed
    this.chain = Promise.resolve();
    this.sweep();
    // Cleaning up goes on while the app runs, not only when it starts.
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        log("uploads: " + (error?.message ?? error));
      }
    }, 10 * 60_000);
    this.timer.unref?.();
  }
  dispose() {
    clearInterval(this.timer);
  }
  folder(device) {
    return join(this.root, cleanDevice(device));
  }
  /** A file that was started and then left alone for 10 minutes is dropped: the file and its entry. */
  expire() {
    for (const [key, entry] of this.open) {
      if (this.now() - entry.used <= this.limits.idle) continue;
      this.open.delete(key);
      rmSync(entry.path, { force: true });
    }
  }
  /** Removes abandoned uploads, and finished files older than a week. Done when the host starts and every 10 minutes. */
  sweep() {
    this.expire();
    let devices = [];
    try {
      devices = readdirSync(this.root);
    } catch {
      return;
    }
    for (const device of devices) {
      const folder = join(this.root, device);
      try {
        for (const file of readdirSync(folder)) if (this.now() - statSync(join(folder, file)).mtimeMs > this.limits.age) rmSync(join(folder, file), { recursive: true, force: true });
        if (!readdirSync(folder).length) rmdirSync(folder);
      } catch {}
    }
  }
  /** Files in a phone's folder: { path, size, mtimeMs }. */
  files(device) {
    const folder = this.folder(device);
    try {
      return readdirSync(folder).flatMap((file) => {
        try {
          const info = statSync(join(folder, file));
          return info.isFile() ? [{ path: join(folder, file), size: info.size, mtimeMs: info.mtimeMs }] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
  /** Receives one call: a whole small file, or one part of a larger one. Calls are handled one at a time. */
  put(device, input) {
    const run = this.chain.then(() => this.write(device, input));
    this.chain = run.catch(() => {});
    return run;
  }
  async write(deviceId, input) {
    const device = cleanDevice(deviceId);
    if (!input || typeof input !== "object") throw new Failure("That file can't be sent.");
    this.expire();
    const bytes = decode(input.data);
    let entry;
    let id;
    if (input.id == null) {
      // An empty part may end a file, but nothing starts with one.
      if (!bytes.length) throw new Failure("That file is empty.");
      // A phone sends a few files at a time; unfinished ones are counted, so they can't pile up.
      let unfinished = 0;
      for (const key of this.open.keys()) if (key.startsWith(device + "/")) unfinished++;
      if (input.last === false && unfinished >= this.limits.open) throw new Failure("Too many files are being sent at once.");
      id = b64u(random(9));
      const name = safeName(input.name);
      entry = { path: join(this.folder(device), id + "-" + name), name, size: 0, fresh: true, used: this.now() };
    } else {
      id = typeof input.id === "string" ? input.id : "";
      entry = this.open.get(device + "/" + id);
      if (!entry) throw new Failure("That upload isn't open any more. Send the file again.");
    }
    if (entry.size + bytes.length > this.limits.file) {
      this.drop(device, id, entry);
      throw new Failure("Files up to " + Math.round(this.limits.file / MB) + " MB can be sent.");
    }
    this.makeRoom(device, bytes.length, entry.path, entry.fresh);
    try {
      mkdirSync(this.folder(device), { recursive: true, mode: 0o700 });
      await appendFile(entry.path, bytes, { mode: 0o600, flag: entry.fresh ? "wx" : "a" });
    } catch {
      // A write that failed leaves no half file behind.
      this.drop(device, id, entry);
      throw new Failure("That file couldn't be saved on your computer.");
    }
    if (this.gone.has(device)) {
      // The phone was removed while this part was being written: nothing of it stays.
      this.forget(device);
      throw new Failure("This phone isn't paired.");
    }
    entry.size += bytes.length;
    entry.fresh = false;
    entry.used = this.now();
    // A call with no id and no "last: false" is the whole file. A part that has an id ends it with "last: true".
    const finished = input.last === true || (input.id == null && input.last !== false);
    if (finished) this.open.delete(device + "/" + id);
    else this.open.set(device + "/" + id, entry);
    return { id, name: entry.name, path: entry.path, size: entry.size };
  }
  /** Stops a file that went over its limit and removes what was received. */
  drop(device, id, entry) {
    this.open.delete(device + "/" + id);
    try {
      rmSync(entry.path, { force: true });
    } catch {}
  }
  /**
   * Makes room for `more` bytes in a phone's folder by removing its oldest finished files, and for a
   * new file by keeping the finished ones under their count.
   */
  makeRoom(device, more, keep, starting) {
    const all = this.files(device);
    const busy = new Set([...this.open.values()].map((entry) => entry.path));
    const finished = all.filter((f) => f.path !== keep && !busy.has(f.path)).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = all.reduce((sum, file) => sum + file.size, 0) + more;
    let count = finished.length;
    for (const file of finished) {
      if (total <= this.limits.device && !(starting && count >= this.limits.files)) break;
      rmSync(file.path, { force: true });
      total -= file.size;
      count--;
    }
    if (total > this.limits.device) throw new Failure("Too many files are waiting on your computer. Send fewer, or try again later.");
  }
  /** A phone was removed: its files go with it. */
  forget(device) {
    // Remembered, so a part still being written when the phone was removed is thrown away too.
    this.gone.add(device);
    if (this.gone.size > 256) this.gone.delete(this.gone.values().next().value);
    for (const key of [...this.open.keys()]) if (key.startsWith(device + "/")) this.open.delete(key);
    try {
      rmSync(this.folder(device), { recursive: true, force: true });
    } catch {}
  }
  /**
   * The real path of `path` when it is a file inside this phone's own folder, else null. A link or a
   * ".." that leads out of the folder doesn't count.
   */
  ownFile(device, path) {
    try {
      if (typeof path !== "string" || !isAbsolute(path)) return null;
      const root = realpathSync(this.folder(device));
      const real = realpathSync(resolve(path));
      return real.startsWith(root + sep) && statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }
}
