import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import { PINS, VERSION } from "./proton-pins.mjs";
import { Failure } from "./tools.mjs";

export const PROTON_DOWNLOADS = "https://proton.me/download/pass-cli";
export const PROTON_GUIDE = "https://protonpass.github.io/pass-cli/get-started/installation/";
const MAX_FILE = 80 * 1024 * 1024;
const WINDOWS_FILES = new Set(["pass-cli.exe", "libcrypto-3-x64.dll"]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unverified = () => new Failure("Botkins couldn't verify the Proton Pass download.");

/** Only regular files with the two exact expected names, never arbitrary ZIP paths. */
export function unzipPassCli(zip, hashes) {
  const files = new Map();
  try {
    let end = zip.length - 22;
    while (end >= Math.max(0, zip.length - 65557) &&
      (zip.readUInt32LE(end) !== 0x06054b50 || end + 22 + zip.readUInt16LE(end + 20) !== zip.length)) end--;
    if (end < Math.max(0, zip.length - 65557) || zip.readUInt32LE(end + 4) !== 0 ||
        zip.readUInt16LE(end + 8) !== WINDOWS_FILES.size || zip.readUInt16LE(end + 10) !== WINDOWS_FILES.size) throw unverified();
    const start = zip.readUInt32LE(end + 16);
    if (start + zip.readUInt32LE(end + 12) !== end) throw unverified();
    let central = start;
    const ranges = [];
    for (let i = 0; i < WINDOWS_FILES.size; i++) {
      if (central + 46 > end || zip.readUInt32LE(central) !== 0x02014b50) throw unverified();
      const flags = zip.readUInt16LE(central + 8);
      const method = zip.readUInt16LE(central + 10);
      const compressed = zip.readUInt32LE(central + 20);
      const size = zip.readUInt32LE(central + 24);
      const length = zip.readUInt16LE(central + 28);
      const local = zip.readUInt32LE(central + 42);
      const kind = (zip.readUInt32LE(central + 38) >>> 28);
      const name = zip.toString("utf8", central + 46, central + 46 + length);
      if ((flags & 1) || (kind && kind !== 8) || zip.readUInt16LE(central + 34) ||
          !WINDOWS_FILES.has(name) || files.has(name) || size < 1 || size > MAX_FILE ||
          local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50 ||
          zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method ||
          zip.readUInt16LE(local + 26) !== length || zip.toString("utf8", local + 30, local + 30 + length) !== name) throw unverified();
      const data = local + 30 + length + zip.readUInt16LE(local + 28);
      const last = data + compressed;
      if (last > start || ranges.some(([a, b]) => local < b && last > a)) throw unverified();
      ranges.push([local, last]);
      const raw = zip.subarray(data, last);
      const bytes = method === 0 ? raw : method === 8 ? inflateRawSync(raw, { maxOutputLength: size }) : null;
      if (!bytes || bytes.length !== size || (hashes && digest(bytes) !== hashes[name])) throw unverified();
      files.set(name, bytes);
      central += 46 + length + zip.readUInt16LE(central + 30) + zip.readUInt16LE(central + 32);
    }
    if (central !== end) throw unverified();
  } catch {
    throw unverified();
  }
  return files;
}

export function unsupportedProton(platform, arch, glibc) {
  if (platform === "linux" && !glibc) return "Proton Pass setup isn't supported on Alpine or other Linux systems without glibc.";
  if (platform === "win32" && arch === "arm64") return "Proton Pass setup isn't supported on Windows on Arm.";
  if (!PINS[platform + "-" + arch]) return "Proton Pass setup isn't supported on this computer.";
  return null;
}

export class ProtonInstaller {
  constructor({ dir, platform = process.platform, arch = process.arch,
    glibc = platform !== process.platform || platform !== "linux" || !!process.report?.getReport().header.glibcVersionRuntime,
    pin, fetcher = fetch }) {
    if (platform === "win32" && process.platform === "win32" &&
        [process.env.PROCESSOR_ARCHITEW6432, process.env.PROCESSOR_ARCHITECTURE].some((cpu) => cpu?.toLowerCase() === "arm64")) arch = "arm64";
    this.unsupported = unsupportedProton(platform, arch, glibc);
    this.pin = pin ?? PINS[platform + "-" + arch];
    this.dir = dir;
    this.destination = join(dir, VERSION);
    this.fetcher = fetcher;
    this.verified = new Map();
    this.tampered = false;
  }

  plan() {
    if (this.unsupported) throw new Failure(this.unsupported);
    const { asset, sizeBytes, sha256 } = this.pin;
    return { version: VERSION, url: `${PROTON_DOWNLOADS}/${VERSION}/${asset}`, sha256, destination: this.destination, sizeBytes };
  }

  installed() {
    return this.verifying ??= this.verify().finally(() => { this.verifying = undefined; });
  }

  async verify() {
    if (this.unsupported) return null;
    let folderExists = false;
    const start = this.pin.files ? "pass-cli.exe" : "pass-cli";
    try {
      const folder = await lstat(this.destination);
      folderExists = true;
      if (!folder.isDirectory()) throw unverified();
      const expected = Object.entries(this.pin.files ?? { [start]: this.pin.sha256 });
      const actual = await readdir(this.destination);
      if (actual.length !== expected.length || expected.some(([name]) => !actual.includes(name))) throw unverified();
      for (const [name, hash] of expected) {
        const file = join(this.destination, name);
        const stat = await lstat(file, { bigint: true });
        if (!stat.isFile() || stat.size > MAX_FILE || (name === start && !this.pin.files && !(stat.mode & 0o100n))) throw unverified();
        const stamp = [stat.dev, stat.ino, stat.ctimeNs, stat.mtimeNs, stat.size].join(":");
        if (this.verified.get(file) !== stamp) {
          const sha = createHash("sha256");
          for await (const bytes of createReadStream(file)) sha.update(bytes);
          if (sha.digest("hex") !== hash) throw unverified();
          this.verified.set(file, stamp);
        }
      }
      this.tampered = false;
      return join(this.destination, start);
    } catch (error) {
      this.tampered = folderExists || error.code !== "ENOENT";
      this.verified.clear();
      return null;
    }
  }

  async install(sha256, signal) {
    const plan = this.plan();
    if (sha256 !== plan.sha256) throw new Failure("Review the install plan before installing Proton Pass.");
    signal = AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(signal ? [signal] : [])]);
    signal.throwIfAborted();
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const stage = await mkdtemp(join(this.dir, ".install-"));
    try {
      const exe = join(stage, "pass-cli");
      const download = this.pin.files ? join(stage, "download.zip") : exe;
      const response = await this.fetcher(plan.url, { signal, redirect: "error" });
      if (!response.ok || !response.body) throw new Failure("Botkins couldn't download Proton Pass.");
      let length = 0;
      const sha = createHash("sha256");
      await pipeline(Readable.fromWeb(response.body), new Transform({
        transform(bytes, _encoding, next) {
          length += bytes.length;
          if (length > plan.sizeBytes) return next(unverified());
          sha.update(bytes);
          next(null, bytes);
        },
      }), createWriteStream(download, { flags: "wx", mode: 0o600 }), { signal });
      if (length !== plan.sizeBytes || sha.digest("hex") !== plan.sha256) throw unverified();
      if (this.pin.files) {
        for (const [name, bytes] of unzipPassCli(await readFile(download), this.pin.files)) {
          await writeFile(join(stage, name), bytes, { flag: "wx", mode: 0o700 });
        }
        await rm(download);
      } else await chmod(exe, 0o700);
      signal.throwIfAborted();
      if (!(await this.installed())) {
        await rm(this.destination, { recursive: true, force: true });
        await rename(stage, this.destination);
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
