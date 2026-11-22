// Marketplace › Pi. Pi publishes its catalog as HTML. Read only its package cards
// and detail fields. Neither markup nor a command supplied by a page reaches Pi.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";

const CATALOG = "https://pi.dev/packages";
const validName = (s) => typeof s === "string" && s.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(s);
const validVersion = (s) => typeof s === "string" && /^[0-9][0-9A-Za-z.+-]*$/.test(s) && !!semver.valid(s);
const folderId = (name) => createHash("sha256").update(name).digest("hex");
const recordFile = "botkins-package.json";
const decode = (value) =>
  value.replace(
    /&(amp|lt|gt|quot|apos|#39|#x27);/g,
    (_, key) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'" })[key],
  );

function requireName(name) {
  if (!validName(name)) throw new Error("Choose an npm package from the Pi catalog.");
}
function requireVersion(version) {
  if (!validVersion(version)) throw new Error("Review the exact Pi package version first.");
}
function readRecord(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, recordFile), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function writeRecord(dir, record) {
  const temp = join(dir, randomUUID() + ".tmp");
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  renameSync(temp, join(dir, recordFile));
}

export class PiPackages {
  constructor({ dataDir, fetch: fetchPage = globalThis.fetch, install }) {
    this.dir = join(dataDir, "packages");
    this.fetch = fetchPage;
    this.runInstall = install;
    this.installing = new Map();
  }
  async html(url) {
    const response = await this.fetch(url, { signal: AbortSignal.timeout(12000), redirect: "error" });
    if (!response.ok) throw new Error("Pi's catalog could not be read (HTTP " + response.status + ").");
    return response.text();
  }
  async browse({ query = "", page = 1 } = {}) {
    if (typeof query !== "string" || query.length > 200 || !Number.isSafeInteger(page) || page < 1 || page > 10000)
      throw new Error("Choose a valid search and page.");
    const url = new URL(CATALOG);
    if (query.trim()) url.searchParams.set("name", query.trim());
    if (page > 1) url.searchParams.set("page", String(page));
    const html = await this.html(url);
    const packages = [];
    for (const [, attrs, body] of html.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/g)) {
      if (!attrs.includes('data-package-card="true"')) continue;
      const name = /data-package-name="([^"]+)"/.exec(attrs)?.[1];
      if (!validName(name)) continue;
      const description = decode(/<p class="packages-desc">([^<]*)<\/p>/.exec(body)?.[1] ?? "");
      const types = (/data-package-types="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/[,\s]+/).filter(Boolean);
      packages.push({ name, description, types });
    }
    if (!packages.length && !html.includes('class="packages-empty"')) throw new Error("Pi's catalog format could not be read.");
    const more = /<a\b[^>]*class="pagination-link"[^>]*>Next\s/.test(html);
    return { packages, ...(more && { nextPage: page + 1 }) };
  }
  async preview(name) {
    requireName(name);
    const html = await this.html(CATALOG + "/" + name);
    const id = /<dt>Package<\/dt><dd><code>([^<]+)<\/code>/.exec(html)?.[1];
    const version = /<dt>Version<\/dt><dd><code>([^<]+)<\/code>/.exec(html)?.[1];
    if (id !== name || !validVersion(version)) throw new Error("Pi's catalog did not confirm this package and version.");
    return { name, version };
  }
  list() {
    let dirs;
    try {
      dirs = readdirSync(this.dir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    return dirs
      .filter((id) => /^[a-f0-9]{64}$/.test(id))
      .map((id) => {
        const record = readRecord(join(this.dir, id));
        if (
          !record ||
          !validName(record.name) ||
          folderId(record.name) !== id ||
          !validVersion(record.version) ||
          typeof record.enabled !== "boolean"
        )
          throw new Error("A Botkins Pi package record could not be read.");
        return record;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  activePaths() {
    return this.list()
      .filter((item) => item.enabled)
      .map(({ name }) => join(this.dir, folderId(name), "npm", "node_modules", name));
  }
  async install(name, version) {
    requireName(name);
    requireVersion(version);
    const ongoing = this.installing.get(name);
    if (ongoing) {
      if (ongoing.version !== version) throw new Error("Another version is being installed.");
      return ongoing.work;
    }
    const work = this.installOne(name, version);
    this.installing.set(name, { version, work });
    try {
      return await work;
    } finally {
      this.installing.delete(name);
    }
  }
  async installOne(name, version) {
    const dir = join(this.dir, folderId(name));
    const existing = readRecord(dir);
    if (existing) {
      if (existing.version !== version) throw new Error("Another version is already installed.");
      if (!existing.enabled)
        throw new Error("This Pi package is already installed and switched off. Turn it on under Installed in Pi.");
      return existing;
    }
    if ((await this.preview(name)).version !== version)
      throw new Error("This package changed. Review its new version before installing.");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const stage = mkdtempSync(join(this.dir, ".install-"));
    try {
      await this.runInstall("npm:" + name + "@" + version, stage);
      const manifest = JSON.parse(readFileSync(join(stage, "npm", "node_modules", name, "package.json"), "utf8"));
      if (manifest.name !== name || manifest.version !== version) throw new Error("Pi installed a different package or version.");
      const record = { name, version, enabled: true };
      writeRecord(stage, record);
      renameSync(stage, dir);
      return record;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  setEnabled(name, version, enabled) {
    requireName(name);
    requireVersion(version);
    if (typeof enabled !== "boolean") throw new Error("Choose on or off.");
    const dir = join(this.dir, folderId(name));
    const record = readRecord(dir);
    if (!record || record.version !== version) throw new Error("That package version is no longer installed.");
    const next = { ...record, enabled };
    writeRecord(dir, next);
    return next;
  }
}
