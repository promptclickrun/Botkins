// Preview the manifest and pin every companion file by its immutable Git blob ID.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { checkPath, importFiles, MAX_ENTRIES, MAX_UNPACKED } from "./link/skill-import.mjs";
import { parseSkill, slug } from "./link/skill-format.mjs";
import { FEATURED_SKILLS, featuredSkill } from "./skills-featured.mjs";

const WORD = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const SEARCH_TTL = 120_000;
const PREVIEW_TTL = 10 * 60_000;
function cache(map, key, value, ttl) {
  if (map.size >= 64) map.delete(map.keys().next().value);
  map.set(key, { value, expires: Date.now() + ttl });
}
function cached(map, key) {
  const hit = map.get(key);
  return hit?.expires > Date.now() ? hit.value : undefined;
}
/** One file of a skill, pinned by its blob, at `path` inside the skill. */
function fileEntry(path, item) {
  checkPath(path);
  if (!/^100(644|755)$/.test(item.mode) || !/^[a-f0-9]{40}$/.test(item.sha) || !Number.isSafeInteger(item.size) || item.size < 0)
    throw new Error("This skill contains an unsupported file.");
  return { path, sha: item.sha, size: item.size, executable: item.mode === "100755" };
}
/** Every file below `prefix` in a Git tree, within the import's limits. */
function filesUnder(tree, prefix) {
  const entries = [];
  let total = 0;
  for (const item of tree) {
    if (!item.path.startsWith(prefix) || item.type === "tree") continue;
    const entry = fileEntry(item.path.slice(prefix.length), item);
    total += entry.size;
    if (total > MAX_UNPACKED || entries.length >= MAX_ENTRIES) throw new Error("This catalog skill is too large.");
    entries.push(entry);
  }
  return entries;
}
/** A file's Git blob id: what a folder catalog's files are pinned by, as a repository's are. */
export const blobId = (bytes) => createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
/**
 * A skill folder in a catalog folder on this computer, as a Git tree lists one: every regular
 * file with its mode, size and blob id. A link anywhere below the catalog's folder is refused.
 */
export function localTree(root, path) {
  const realRoot = realpathSync(root);
  let folder = realRoot;
  for (const part of path.split("/")) {
    checkPath(part);
    folder = join(folder, part);
    const info = lstatSync(folder, { throwIfNoEntry: false });
    if (!info) throw new Error("The skill's folder is not in the catalog.");
    if (info.isSymbolicLink()) throw new Error("This catalog skill contains a symbolic link, so it isn't installed.");
  }
  const tree = [];
  const blobs = new Map();
  let total = 0;
  const visit = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git") continue;
      const full = join(dir, name);
      const rel = prefix + "/" + name;
      const info = lstatSync(full);
      if (info.isSymbolicLink()) throw new Error("This catalog skill contains a symbolic link, so it isn't installed.");
      if (info.isDirectory()) {
        visit(full, rel);
        continue;
      }
      if (!info.isFile()) throw new Error("This skill contains an unsupported file.");
      total += info.size;
      if (total > MAX_UNPACKED || tree.length >= MAX_ENTRIES) throw new Error("This catalog skill is too large.");
      const bytes = readFileSync(full);
      const sha = blobId(bytes);
      blobs.set(sha, bytes);
      tree.push({ path: rel, type: "blob", mode: info.mode & 0o111 ? "100755" : "100644", size: bytes.length, sha });
    }
  };
  visit(folder, path);
  return { tree, blobs };
}
/** Where a featured skill comes from, as a listing and a preview show it. */
const sourceOf = (item) => ({ author: item.author, license: item.license, repo: item.repo, commit: item.commit, path: item.path, url: item.url, ...(item.pack && { pack: item.pack }) });
export function skillsCatalog(getIntegrations, request = fetch) {
  const queries = new Map();
  const previews = new Map();
  async function fetchBytes(url, max, signal, raw = false) {
    const response = await request(url, { signal, headers: { Accept: raw ? "application/vnd.github.raw+json" : "application/json" } });
    if (!response.ok) throw new Error("The skills catalog request failed (HTTP " + response.status + ").");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) throw new Error("The catalog response is too large.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const json = async (url, limit, signal) => JSON.parse((await fetchBytes(url, limit, signal)).toString());
  /** A SKILL.md's bytes, by its blob. */
  function readBlob(base, entry, signal) {
    if (!/^100(644|755)$/.test(entry.mode) || !/^[a-f0-9]{40}$/.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 256000)
      throw new Error("Cannot preview this SKILL.md.");
    return fetchBytes(base + "blobs/" + entry.sha, entry.size, signal, true);
  }
  const installed = (id) => getIntegrations().skillState.catalog?.[id];
  /** A featured skill (desktop/skills-featured.mjs): its folder at the pinned commit, and its license file with it. */
  async function featuredPreview(item) {
    const [owner, repo] = item.repo.split("/");
    const base = "https://api.github.com/repos/" + owner + "/" + repo + "/git/";
    const signal = AbortSignal.timeout(20000);
    const tree = await json(base + "trees/" + item.commit + "?recursive=1", 16 * 1024 * 1024, signal);
    if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("The repository file list is incomplete.");
    const prefix = item.path + "/";
    const manifest = tree.tree.find((f) => f.path === prefix + "SKILL.md");
    if (!manifest) throw new Error(item.name + " is no longer at " + item.repo + "@" + item.commit.slice(0, 7) + ".");
    const entries = filesUnder(tree.tree, prefix);
    // A license that sits beside the pack rather than in the skill's folder goes with the skill as LICENSE.
    if (item.licensePath && !item.licensePath.startsWith(prefix)) {
      const license = tree.tree.find((f) => f.path === item.licensePath && f.type === "blob");
      if (!license) throw new Error("The license of " + item.name + " is missing at that commit, so it isn't installed.");
      if (entries.some((e) => e.path === "LICENSE")) throw new Error("This skill already has a LICENSE file.");
      entries.push(fileEntry("LICENSE", license));
    } else if (item.licensePath && !entries.some((e) => prefix + e.path === item.licensePath)) throw new Error("The license of " + item.name + " is missing at that commit, so it isn't installed.");
    const bytes = await readBlob(base, manifest, signal);
    const text = bytes.toString("utf8");
    const { name, description } = parseSkill(text, item.name);
    const token = randomUUID();
    cache(previews, token, { id: item.id, base, entries, bytes, skillId: item.name }, PREVIEW_TTL);
    return { name, description, text, token, installed: installed(item.id), source: sourceOf(item), files: entries.map((e) => e.path) };
  }
  /**
   * A marketplace's own skill listing (desktop/catalog-v2.mjs): its folder at the catalog's commit,
   * from the catalog's GitHub repository or its folder on this computer. Every file is pinned by its
   * blob id; `pins` ({ path: blob }) is what an update is compared with.
   */
  async function listingPreview(item) {
    const signal = AbortSignal.timeout(20000);
    let tree;
    let base;
    let local;
    if (item.source.type === "github") {
      const [owner, repo] = item.source.repo.split("/");
      base = "https://api.github.com/repos/" + owner + "/" + repo + "/git/";
      const answer = await json(base + "trees/" + item.commit + "?recursive=1", 16 * 1024 * 1024, signal);
      if (answer.truncated || !Array.isArray(answer.tree)) throw new Error("The repository file list is incomplete.");
      tree = answer.tree;
    } else {
      local = localTree(item.source.root, item.path);
      tree = local.tree;
    }
    const prefix = item.path + "/";
    // A link anywhere in the skill's folder refuses the whole skill: nothing is installed from it.
    if (tree.some((f) => f.path.startsWith(prefix) && (f.type === "symlink" || f.mode === "120000" || f.type === "commit")))
      throw new Error("This catalog skill contains a symbolic link or a submodule, so it isn't installed.");
    const manifest = tree.find((f) => f.path === prefix + "SKILL.md");
    if (!manifest) throw new Error(item.name + " is not at " + item.catalogName + "@" + item.commit.slice(0, 7) + ".");
    const entries = filesUnder(tree, prefix);
    const bytes = local ? local.blobs.get(manifest.sha) : await readBlob(base, manifest, signal);
    if (blobId(bytes) !== manifest.sha) throw new Error("A file of this skill isn't the one the catalog lists.");
    const text = bytes.toString("utf8");
    const { name, description } = parseSkill(text, item.name);
    if (slug(name) !== item.name) throw new Error("This skill's SKILL.md names " + name + ", not " + item.name + ".");
    const token = randomUUID();
    cache(previews, token, { id: item.id, listing: item, base, local: item.source.type === "local" ? item.source.root : undefined, entries, bytes, skillId: item.name }, PREVIEW_TTL);
    const executable = entries.filter((e) => e.executable).map((e) => e.path);
    return {
      name, description, text, token,
      source: { author: item.author ?? item.catalogName, license: item.license, repo: item.source.repo ?? item.catalogName, commit: item.commit, path: item.path, catalog: item.catalog, version: item.version, ...(item.source.repo && { url: "https://github.com/" + item.source.repo + "/tree/" + item.commit + "/" + item.path }) },
      files: entries.map((e) => e.path),
      executable,
      size: entries.reduce((n, e) => n + e.size, 0),
      pins: Object.fromEntries(entries.map((e) => [e.path, e.sha])),
    };
  }
  /** The bytes of every pinned file of a preview, each checked against its blob id. */
  async function pinnedFiles(preview, signal) {
    const files = new Map();
    const local = preview.local ? localTree(preview.local, preview.listing.path) : undefined;
    for (const { path, sha, size } of preview.entries) {
      const bytes = path === "SKILL.md" ? preview.bytes : local ? local.blobs.get(sha) : await fetchBytes(preview.base + "blobs/" + sha, size, signal, true);
      // A folder catalog can change after its review: a file that isn't the reviewed one refuses the install.
      if (!bytes || (preview.listing && blobId(bytes) !== sha)) throw new Error("A file of this skill changed after the review. Open it again.");
      files.set(path, bytes);
    }
    return files;
  }
  return {
    listingPreview,
    /** The featured shelf: pinned upstream skills, readable with no search. */
    featured() {
      return FEATURED_SKILLS.map((item) => ({ id: item.id, name: item.name, summary: item.summary, group: item.group, ...sourceOf(item), installed: installed(item.id) }));
    },
    async search(query) {
      if (typeof query !== "string" || query.trim().length < 2 || query.length > 200) throw new Error("Enter 2 to 200 characters.");
      const q = query.trim();
      let rows = cached(queries, q);
      if (!rows) {
        const result = await json("https://skills.sh/api/search?" + new URLSearchParams({ q, limit: "40" }), 256000, AbortSignal.timeout(12000));
        if (!Array.isArray(result.skills)) throw new Error("The skills catalog returned an invalid answer.");
        rows = result.skills
          .slice(0, 40)
          .map(({ id, source, skillId, name, installs }) => {
            if (
              typeof source !== "string" ||
              !source.split("/").every((part) => WORD.test(part)) ||
              typeof skillId !== "string" ||
              !WORD.test(skillId) ||
              id !== source + "/" + skillId ||
              typeof name !== "string" ||
              !Number.isSafeInteger(installs) ||
              installs < 0
            )
              throw new Error("Invalid skill in catalog answer.");
            return { id, source, skillId, name, installs, available: source.split("/").length === 2 };
          })
          .sort((a, b) => b.installs - a.installs);
        cache(queries, q, rows, SEARCH_TTL);
      }
      return rows.map((row) => ({ ...row, installed: installed(row.id) }));
    },
    async preview(id) {
      if (typeof id !== "string") throw new Error("Choose a catalog skill.");
      const item = featuredSkill(id);
      if (item) return featuredPreview(item);
      const parts = id.split("/");
      if (parts.length !== 3 || !parts.every((part) => WORD.test(part))) throw new Error("Open this skill on skills.sh.");
      const [owner, repo, skillId] = parts;
      const base = "https://api.github.com/repos/" + owner + "/" + repo + "/git/";
      const signal = AbortSignal.timeout(20000);
      const tree = await json(base + "trees/HEAD?recursive=1", 8 * 1024 * 1024, signal);
      if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("The repository file list is incomplete.");
      const manifests = tree.tree.filter((f) => basename(f.path) === "SKILL.md");
      const matches = manifests.filter((f) => basename(dirname(f.path)) === skillId);
      let manifest = matches.length === 1 ? matches[0] : undefined;
      let bytes;
      const readManifest = (entry) => readBlob(base, entry, signal);
      // The catalog uses the declared name, which can differ from the repository folder.
      if (!manifest && manifests.length <= 32) {
        for (const candidate of manifests) {
          const content = await readManifest(candidate);
          if (slug(parseSkill(content.toString("utf8"), basename(dirname(candidate.path))).name) !== slug(skillId)) continue;
          if (manifest) throw new Error("Several folders declare this skill. Open it on skills.sh.");
          manifest = candidate;
          bytes = content;
        }
      }
      if (!manifest) throw new Error("Could not identify this skill's folder. Open it on skills.sh.");
      const prefix = manifest.path.slice(0, -8);
      const entries = filesUnder(tree.tree, prefix);
      bytes ??= await readManifest(manifest);
      const text = bytes.toString("utf8");
      const { name, description } = parseSkill(text, skillId);
      const token = randomUUID();
      cache(previews, token, { id, base, entries, bytes, skillId }, PREVIEW_TTL);
      return { name, description, text, token, installed: installed(id) };
    },
    /**
     * Installs a previewed skill. A marketplace listing can go to chosen bots only
     * (`{ bots: [ids] }`), into each bot's own skills; otherwise it joins the shared skills.
     */
    async install(token, replace = [], { bots = "all" } = {}) {
      const preview = cached(previews, token);
      if (!preview) throw new Error("Open the preview again before installing.");
      const signal = AbortSignal.timeout(40000);
      const files = await pinnedFiles(preview, signal);
      const integrations = getIntegrations();
      const executable = new Set(preview.entries.filter((f) => f.executable).map((f) => f.path));
      if (preview.listing) {
        const meta = { catalog: preview.listing.catalog, name: preview.listing.name, version: preview.listing.version, commit: preview.listing.commit, files: Object.fromEntries(preview.entries.map((e) => [e.path, e.sha])) };
        if (bots !== "all") {
          for (const id of bots) integrations.installBotCatalogSkill(integrations.ws.bot(id), files, executable, meta);
          return { added: [meta.name], conflicts: [], bots };
        }
        // The same listing installed again is its update: it replaces its own folder without asking.
        const own = integrations.skillState.listings?.[meta.name];
        const again = own?.catalog === meta.catalog ? [meta.name] : [];
        const result = importFiles(integrations, files, preview.skillId, [...new Set([...replace, ...again])], executable);
        if (result.added.length) {
          (integrations.skillState.listings ??= {})[result.added[0]] = meta;
          integrations.changed();
        }
        return result;
      }
      const result = importFiles(
        integrations,
        files,
        preview.skillId,
        replace,
        new Set(preview.entries.filter((f) => f.executable).map((f) => f.path)),
      );
      if (result.added.length) {
        (integrations.skillState.catalog ??= {})[preview.id] = result.added[0];
        integrations.changed();
      }
      return result;
    },
  };
}
