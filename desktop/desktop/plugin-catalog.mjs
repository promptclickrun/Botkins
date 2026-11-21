/*
 * Marketplace and plugin materialization for the desktop host.
 *
 * This module is deliberately a file reader.  It never imports a plugin,
 * starts a command, or evaluates a manifest.  A reviewed plugin is an
 * immutable set of bytes identified by its SHA-256 revision; callers can
 * hand that revision to materialize() after the user has approved it.
 */
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export const PLUGIN_CATALOG_VERSION = "plugins-v1";
export const MARKETPLACE_CACHE_TTL = 60 * 60 * 1000;
export const MAX_PLUGIN_FILES = 1000;
export const MAX_PLUGIN_BYTES = 50 * 1024 * 1024;

const BUILT_INS = [
  {
    id: "botkins",
    name: "Botkins",
    source: "promptclickrun/botkins-marketplace",
    builtIn: true,
  },
  {
    id: "awesome-copilot",
    name: "GitHub",
    source: "github/awesome-copilot",
    builtIn: true,
  },
  {
    id: "copilot-plugins",
    name: "Copilot plugins",
    source: "github/copilot-plugins",
    builtIn: true,
  },
];

const MANIFEST_PATHS = [
  ".plugin/plugin.json",
  "plugin.json",
  ".github/plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];
const MARKETPLACE_PATHS = [
  ".github/plugin/marketplace.json",
  ".plugin/marketplace.json",
  ".claude-plugin/marketplace.json",
  "marketplace.json",
];
const MCP_PATHS = [".mcp.json", "mcp.json", ".claude-plugin/.mcp.json", ".claude-plugin/mcp.json"];
const HOOK_PATHS = ["hooks.json", "hooks/hooks.json", ".claude-plugin/hooks.json", ".claude-plugin/hooks/hooks.json"];
const BUILT_IN_PLACEHOLDERS = new Set([
  "PLUGIN_ROOT",
  "PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "HOME",
  "PATH",
]);
const SUPPORTED_EXTENSIONS = new Set(["com.github.awesome-copilot"]);

function fail(message) {
  throw new Error(message);
}

function assertString(value, what, max = 300) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max)
    fail(`${what} must be a non-empty string of at most ${max} characters.`);
  return value.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashFiles(files) {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    const entry = files.get(name);
    const nameBytes = Buffer.from(name, "utf8");
    const nameLength = Buffer.allocUnsafe(4);
    nameLength.writeUInt32BE(nameBytes.length);
    hash.update(nameLength);
    hash.update(nameBytes);
    const mode = Buffer.allocUnsafe(4);
    mode.writeUInt32BE((entry.mode || 0) & 0o111 ? 1 : 0);
    hash.update(mode);
    const byteLength = Buffer.allocUnsafe(8);
    byteLength.writeBigUInt64BE(BigInt(entry.bytes.length));
    hash.update(byteLength);
    hash.update(entry.bytes);
  }
  return hash.digest("hex");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function json(bytes, name) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    fail(`Invalid JSON in ${name}: ${error.message}`);
  }
}

function safeRelativePath(input, what = "path") {
  if (typeof input !== "string" || !input || input.includes("\0") || input.includes("\\"))
    fail(`${what} is not a safe relative path.`);
  const value = input.replace(/^\.\//, "");
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) fail(`${what} must be relative.`);
  const parts = value.split("/");
  if (parts.some((part) => part === "..")) fail(`${what} may not escape its source folder.`);
  const normalized = normalize(value).replaceAll(sep, "/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../"))
    fail(`${what} is not a safe relative path.`);
  return normalized;
}

function safeId(input) {
  return String(input).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "plugin";
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isGithubRepo(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function githubRawUrl(repo, ref, path) {
  const [owner, name] = repo.split("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

function githubApiTreeUrl(repo, ref) {
  const [owner, name] = repo.split("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
}

function githubApiCommitUrl(repo, ref) {
  const [owner, name] = repo.split("/");
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${encodeURIComponent(ref)}`;
}

function githubRefFromUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") fail("GitHub sources must use HTTPS.");
  if (parsed.hostname === "raw.githubusercontent.com") {
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4) fail("The GitHub raw URL is incomplete.");
    return {
      repo: `${parts[0]}/${parts[1]}`,
      ref: parts[2],
      path: parts.slice(3).join("/"),
    };
  }
  if (parsed.hostname !== "github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) fail("The GitHub URL is incomplete.");
  const repo = `${parts[0]}/${parts[1]}`;
  if (parts[2] === "blob" || parts[2] === "tree") {
    if (!parts[3]) fail("The GitHub URL has no ref.");
    return { repo, ref: parts[3], path: parts.slice(4).join("/") };
  }
  return { repo, ref: "HEAD", path: "" };
}



function readLocalFiles(root) {
  const realRoot = realpathSync(root);
  const files = new Map();
  let total = 0;
  const visit = (current, prefix = "") => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = join(current, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) fail(`Plugin source contains a symlink: ${join(prefix, entry.name)}`);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (info.isDirectory()) visit(path, name);
      else if (info.isFile()) {
        if (files.size >= MAX_PLUGIN_FILES) fail(`Plugin has more than ${MAX_PLUGIN_FILES} files.`);
        total += info.size;
        if (total > MAX_PLUGIN_BYTES) fail(`Plugin is larger than ${MAX_PLUGIN_BYTES} bytes.`);
        files.set(name, { bytes: readFileSync(path), mode: info.mode & 0o777 });
      }
    }
  };
  visit(realRoot);
  return { root: realRoot, files };
}

function readLocalFile(root, name) {
  const realRoot = realpathSync(root);
  if (realRoot !== root) fail("Marketplace source contains a symlink.");
  const safe = safeRelativePath(name, "marketplace path");
  let current = realRoot;
  for (const part of safe.split("/")) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink()) fail(`Marketplace source contains a symlink: ${safe}`);
    if (part !== safe.split("/").at(-1) && !info.isDirectory()) fail(`Marketplace path is not a file: ${safe}`);
    if (part === safe.split("/").at(-1)) {
      if (!info.isFile()) fail(`Marketplace path is not a regular file: ${safe}`);
      if (info.size > MAX_PLUGIN_BYTES) fail(`Marketplace file is larger than ${MAX_PLUGIN_BYTES} bytes.`);
    }
  }
  return { name: safe, bytes: readFileSync(current) };
}

function assertNoSymlinkPath(path, stopAt = undefined) {
  let current = resolve(path);
  const boundary = stopAt ? resolve(stopAt) : undefined;
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail(`Host-owned plugin path contains a symlink: ${current}`);
    if (boundary && current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function locateFile(files, candidates) {
  for (const candidate of candidates) {
    if (files.has(candidate)) return { name: candidate, bytes: files.get(candidate).bytes };
  }
  return null;
}

function collectFiles(files, directory) {
  const prefix = `${directory}/`;
  return [...files.keys()].filter((name) => name.startsWith(prefix)).sort();
}

function readableKey(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function looksSecret(key) {
  return /(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)/i.test(key);
}

function fieldsFromManifest(userConfig) {
  const result = new Map();
  if (!userConfig) return result;
  const values = Array.isArray(userConfig)
    ? userConfig.map((entry) => [entry?.key ?? entry?.name, entry])
    : Object.entries(userConfig).map(([key, value]) => [key, value]);
  for (const [key, raw] of values) {
    if (typeof key !== "string" || !key) continue;
    const value = raw && typeof raw === "object" ? raw : {};
    const secret = Boolean(value.sensitive ?? value.secret) || looksSecret(key);
    result.set(key, {
      key,
      label: String(value.title ?? value.label ?? readableKey(key)),
      ...(value.description ? { description: String(value.description) } : {}),
      secret,
      required: Boolean(value.required),
      ...(!secret && value.default !== undefined ? { default: String(value.default) } : {}),
    });
  }
  return result;
}

function placeholders(value, output) {
  if (typeof value !== "string") return;
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    const key = match[1];
    if (!BUILT_IN_PLACEHOLDERS.has(key)) output.add(key);
  }
}

function walkValues(value, output) {
  if (typeof value === "string") placeholders(value, output);
  else if (Array.isArray(value)) for (const item of value) walkValues(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value)) walkValues(item, output);
}

function mcpEntries(value) {
  if (!value) return [];
  if (typeof value === "string") return [];
  if (value.mcpServers && typeof value.mcpServers === "object") return Object.entries(value.mcpServers);
  if (typeof value === "object" && !Array.isArray(value)) return Object.entries(value);
  return [];
}

function parseMcp(value) {
  return mcpEntries(value).flatMap(([name, server]) => {
    if (!server || typeof server !== "object") return [];
    const kind = server.url || server.serverUrl || server.type === "http" || server.type === "sse" || server.type === "streamable-http" ? "remote" : "local";
    const command = typeof server.command === "string" ? server.command : undefined;
    const url = typeof (server.url ?? server.serverUrl) === "string" ? (server.url ?? server.serverUrl) : undefined;
    const oauth = Boolean(server.oauth || server.oauthClientId || server.authentication?.oauth);
    return [{
      name: String(name),
      kind,
      ...(command ? { command } : {}),
      ...(url ? { url } : {}),
      ...(oauth ? { oauth: true } : {}),
    }];
  });
}

function parseHooks(value) {
  if (!value || typeof value !== "object") return [];
  const source = value.hooks && typeof value.hooks === "object" ? value.hooks : value;
  const result = [];
  const commandKeys = ["bash", "command", "cmd", "shell", "powershell", "windows", "darwin", "macos", "linux"];
  const add = (event, definition) => {
    if (Array.isArray(definition)) {
      for (const item of definition) add(event, item);
      return;
    }
    if (typeof definition === "string") {
      if (definition.trim()) result.push({ event, command: definition.slice(0, 300) });
      return;
    }
    if (!definition || typeof definition !== "object") return;
    // Claude-style hooks put the actual command under a nested hooks array;
    // platform-specific forms put the command under command/bash/windows/etc.
    if (definition.hooks) add(event, definition.hooks);
    if (definition.commands) add(event, definition.commands);
    if (definition.type && definition.type !== "command" && !definition.command && !definition.bash && !definition.cmd) return;
    for (const key of commandKeys) {
      const command = definition[key];
      if (typeof command === "string" && command.trim()) result.push({ event, command: command.slice(0, 300) });
      else if (command && typeof command === "object") add(event, command);
    }
  };
  for (const [event, definitions] of Object.entries(source)) {
    add(event, definitions);
  }
  return result;
}

function normalizeAuthor(author) {
  if (typeof author === "string") return author;
  if (author && typeof author === "object") return author.name || author.login || undefined;
  return undefined;
}

function normalizeMetadata(entry) {
  const metadata = {};
  for (const key of ["description", "version", "license"]) if (entry[key] !== undefined) metadata[key] = String(entry[key]);
  const author = normalizeAuthor(entry.author);
  if (author) metadata.author = author;
  for (const key of ["homepage", "repository"]) if (isHttpsUrl(entry[key])) metadata[key] = entry[key];
  if (Array.isArray(entry.keywords)) metadata.keywords = entry.keywords.map(String).slice(0, 100);
  return metadata;
}

function listingFromEntry(entry, marketplace) {
  if (!entry || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name || name.length > 200 || !entry.source) return null;
  return {
    id: `${name}@${marketplace.id}`,
    name,
    marketplace: marketplace.id,
    ...normalizeMetadata(entry),
  };
}

function catalogEntries(value) {
  if (Array.isArray(value?.plugins)) return value.plugins;
  if (Array.isArray(value?.entries)) return value.entries;
  if (Array.isArray(value)) return value;
  return [];
}

function extensionPaths(manifest) {
  const requested = [];
  const unsupported = [];
  if (!manifest?.extensions || typeof manifest.extensions !== "object") return { requested, unsupported };
  for (const [extension, value] of Object.entries(manifest.extensions)) {
    if (!SUPPORTED_EXTENSIONS.has(extension)) {
      unsupported.push(extension);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    for (const [component, entries] of Object.entries(value)) {
      if (!["skills", "agents", "commands", "hooks", "lspServers"].includes(component)) continue;
      const values = Array.isArray(entries) ? entries : [entries];
      for (const item of values) if (typeof item === "string") requested.push(item);
    }
  }
  return { requested: [...new Set(requested)], unsupported: [...new Set(unsupported)] };
}

function parsePluginFiles(files, folder = undefined) {
  const manifestFile = locateFile(files, MANIFEST_PATHS);
  if (!manifestFile) fail("Plugin has no supported plugin.json manifest.");
  const manifest = json(manifestFile.bytes, manifestFile.name);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail("Plugin manifest must be a JSON object.");
  const name = typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : undefined;
  if (!name) fail("Plugin manifest is missing a name.");

  const mcpFile = typeof manifest.mcpServers === "string"
    ? { name: manifest.mcpServers, bytes: files.get(safeRelativePath(manifest.mcpServers, "mcpServers"))?.bytes }
    : locateFile(files, MCP_PATHS);
  const mcpValue = manifest.mcpServers && typeof manifest.mcpServers === "object"
    ? manifest.mcpServers
    : (mcpFile?.bytes ? json(mcpFile.bytes, mcpFile.name) : undefined);
  const hooksFile = typeof manifest.hooks === "string"
    ? { name: manifest.hooks, bytes: files.get(safeRelativePath(manifest.hooks, "hooks"))?.bytes }
    : locateFile(files, HOOK_PATHS);
  const hooksValue = manifest.hooks && typeof manifest.hooks === "object"
    ? manifest.hooks
    : (hooksFile?.bytes ? json(hooksFile.bytes, hooksFile.name) : undefined);
  const mcpServers = parseMcp(mcpValue);
  const hooks = parseHooks(hooksValue);
  const config = fieldsFromManifest(manifest.userConfig ?? manifest.settings);
  const names = new Set();
  walkValues(mcpValue, names);
  walkValues(hooksValue, names);
  for (const key of names) {
    if (!config.has(key)) config.set(key, { key, label: readableKey(key), secret: looksSecret(key), required: true });
  }
  const lspFile = locateFile(files, ["lsp.json", ".lsp.json", ".claude-plugin/lsp.json"]);
  let lspServers = [];
  if (lspFile) {
    const lsp = json(lspFile.bytes, lspFile.name);
    if (lsp && typeof lsp === "object") lspServers = Object.keys(lsp.lspServers ?? lsp).sort();
  }
  const contents = {
    skills: collectFiles(files, "skills"),
    agents: collectFiles(files, "agents"),
    commands: collectFiles(files, "commands"),
    mcpServers: clone(mcpServers),
    hooks: clone(hooks),
    ...(lspServers.length ? { lspServers } : {}),
  };
  const extensionInfo = extensionPaths(manifest);
  const warnings = [];
  if (extensionInfo.unsupported.length) warnings.push(`Uses unsupported plugin extensions: ${extensionInfo.unsupported.join(", ")}.`);
  if (hooks.length) warnings.push("Runs a command on your computer through plugin hooks.");
  if (mcpServers.some((server) => server.kind === "local")) warnings.push("Runs a local MCP server on your computer.");
  if (mcpServers.some((server) => server.kind === "remote")) warnings.push("Connects to a remote MCP server.");
  const postInstallMessage = manifest.postInstallMessage ?? manifest.postInstall;
  return {
    ...(folder ? { folder } : {}),
    manifest,
    manifestPath: manifestFile.name,
    name,
    contents,
    config: [...config.values()],
    hooks: clone(hooks),
    mcpServers: clone(mcpServers),
    ...(lspServers.length ? { lspServers } : {}),
    ...(extensionInfo.unsupported.length ? { unsupportedExtensions: extensionInfo.unsupported } : {}),
    ...(typeof postInstallMessage === "string" && postInstallMessage ? { postInstallMessage } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

function publicPreview(parsed, listing, revision) {
  const preview = {
    ...listing,
    name: listing.name || parsed.name,
    contents: clone(parsed.contents),
    config: clone(parsed.config),
    ...(parsed.postInstallMessage ? { postInstallMessage: parsed.postInstallMessage } : {}),
    ...(parsed.warnings?.length ? { warnings: [...parsed.warnings] } : {}),
    revision,
  };
  return preview;
}

function sourceKey(source) {
  return typeof source === "string" ? source : JSON.stringify(source);
}

function normalizeGithubSource(source, catalogSource) {
  if (source && typeof source === "object") {
    if (source.source !== "github" || !isGithubRepo(source.repo)) fail("Plugin GitHub source must name a public owner/repo.");
    const ref = source.sha || source.ref || "HEAD";
    if (!/^[A-Za-z0-9._\/-]+$/.test(ref) || ref.includes("..")) fail("Plugin GitHub ref is invalid.");
    return { type: "github", repo: source.repo, ref, path: source.path ? safeRelativePath(source.path, "plugin source") : "" };
  }
  if (typeof source !== "string") fail("Plugin source must be a path, URL, or GitHub source.");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source) && !isHttpsUrl(source)) fail("Plugin sources must use HTTPS.");
  if (isHttpsUrl(source)) {
    const github = githubRefFromUrl(source);
    if (github) return { type: "github", ...github, path: github.path ? safeRelativePath(github.path, "plugin source") : "" };
    return { type: "url", url: source };
  }
  // Marketplace entries normally use a path in the catalog repository.  A
  // shorthand GitHub ref is unambiguous only when it includes #ref; treating
  // every owner/repo-shaped path as a repository would misread common paths
  // such as `plugins/memory`.
  if (source.includes("#")) {
    const [repo, ref] = source.split("#", 2);
    if (isGithubRepo(repo)) return { type: "github", repo, ref: ref || "HEAD", path: "" };
  }
  const path = safeRelativePath(source, "plugin source");
  if (catalogSource.type === "github") return { type: "github", repo: catalogSource.repo, ref: catalogSource.ref, path };
  if (catalogSource.type === "local") return { type: "local", path: resolve(catalogSource.root, path) };
  const base = new URL(catalogSource.url);
  base.pathname = `${base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1)}${path}`;
  return { type: "url", url: base.toString() };
}

async function fetchBytes(url, options = {}) {
  if (!isHttpsUrl(url)) fail("Only HTTPS plugin sources are allowed.");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Accept: options.json ? "application/vnd.github+json, application/json" : "application/octet-stream",
      "User-Agent": "Botkins-plugin-catalog/1.0",
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Could not read ${url} (HTTP ${response.status}).`), { status: response.status });
  }
  const limit = options.limit ?? MAX_PLUGIN_BYTES;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    fail("Remote plugin content exceeds the download limit.");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    total += chunk.length;
    if (total > limit) fail("Remote plugin content exceeds the download limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchJson(url) {
  return json(await fetchBytes(url, { json: true }), url);
}

async function githubPinned(source) {
  if (/^[a-f0-9]{40}$/i.test(source.ref)) return source;
  const commit = await fetchJson(githubApiCommitUrl(source.repo, source.ref));
  if (!/^[a-f0-9]{40}$/i.test(commit?.sha)) fail("GitHub did not return a commit for this ref.");
  return { ...source, ref: commit.sha };
}

function githubExtensionMatches(path, candidate, prefix) {
  const names = [candidate.path];
  // The current awesome-copilot tree uses .agent.md while older manifests
  // declare the same file as .md.  Accept that published spelling without
  // inventing or renaming any bytes.
  if (candidate.path.startsWith("agents/") && candidate.path.endsWith(".md")) names.push(candidate.path.slice(0, -3) + ".agent.md");
  return names.some((name) => path === name
    || (candidate.trailing && path.startsWith(`${name}/`))
    || (prefix && (path === `${prefix.slice(0, -1)}/${name}` || (candidate.trailing && path.startsWith(`${prefix}${name}/`)))));
}

async function githubTree(source, extraPaths = [], treeOverride = undefined, includeBase = true) {
  const pinned = await githubPinned(source);
  const value = treeOverride || await fetchJson(githubApiTreeUrl(pinned.repo, pinned.ref));
  if (!Array.isArray(value?.tree) || value.truncated) fail("The GitHub plugin tree is unavailable or too large.");
  const prefix = pinned.path ? `${safeRelativePath(pinned.path, "plugin source")}/` : "";
  const extras = extraPaths.map((raw) => {
    const trailing = raw.endsWith("/");
    const path = safeRelativePath(raw.replace(/^\.\//, ""), "plugin extension path").replace(/\/$/, "");
    return { path, trailing };
  });
  const rows = [];
  for (const item of value.tree) {
    if (item.type !== "blob" && item.type !== "commit" && item.type !== "tree" && item.type !== "symlink") continue;
    const path = String(item.path || "");
    if (!path) continue;
    let relativePath;
    if (includeBase && (!prefix || path.startsWith(prefix))) relativePath = prefix ? path.slice(prefix.length) : path;
    else {
      const extra = extras.find((candidate) => githubExtensionMatches(path, candidate, prefix));
      if (!extra) continue;
      relativePath = prefix && path.startsWith(`${prefix.slice(0, -1)}/`) ? path.slice(prefix.length) : path;
    }
    if (item.type === "symlink" || item.mode === "120000") fail(`Plugin source contains a symlink: ${path}`);
    if (item.type !== "blob") continue;
    if (!relativePath || relativePath.includes("..")) fail("GitHub plugin tree contains an unsafe path.");
    rows.push({ path: relativePath, mode: Number.parseInt(item.mode || "100644", 8), url: githubRawUrl(pinned.repo, pinned.ref, path) });
  }
  if (!rows.length) fail("The GitHub plugin source folder is empty.");
  if (rows.length > MAX_PLUGIN_FILES) fail(`Plugin has more than ${MAX_PLUGIN_FILES} files.`);
  const files = new Map();
  let total = 0;
  // Fetch in small batches, which avoids opening hundreds of sockets at once.
  for (let index = 0; index < rows.length; index += 8) {
    const batch = rows.slice(index, index + 8);
    const fetched = await Promise.all(batch.map(async (row) => ({ ...row, bytes: await fetchBytes(row.url) })));
    for (const row of fetched) {
      total += row.bytes.length;
      if (total > MAX_PLUGIN_BYTES) fail(`Plugin is larger than ${MAX_PLUGIN_BYTES} bytes.`);
      files.set(row.path, { bytes: row.bytes, mode: row.mode & 0o777 });
    }
  }
  return { root: undefined, files, source: pinned, tree: value };
}

async function remoteSource(source, extraPaths = [], treeOverride = undefined, includeBase = true) {
  if (source.type === "local") {
    // The stored root is canonical. Recheck it on every preview and install, since a
    // folder or any ancestor may have been replaced by a link since selection.
    if (realpathSync(source.path) !== source.path) fail("Plugin source contains a symlink.");
    return readLocalFiles(source.path);
  }
  if (source.type === "github") return githubTree(source, extraPaths, treeOverride, includeBase);
  // A generic HTTPS source is useful for a manifest-only URL, but it cannot
  // safely provide a directory listing.  Support a manifest at the URL and
  // fail with a useful message if it does not include all component files.
  const bytes = await fetchBytes(source.url);
  const path = source.url.split("?")[0].split("#")[0];
  const name = path.endsWith("/") ? "plugin.json" : path.split("/").pop();
  return { root: undefined, files: new Map([[name || "plugin.json", { bytes, mode: 0o644 }]]) };
}

async function readPluginSource(source) {
  const loaded = await remoteSource(source);
  let parsed = parsePluginFiles(loaded.files, loaded.root);
  if (source.type === "github" && loaded.source) {
    const extensions = extensionPaths(parsed.manifest);
    if (extensions.requested.length) {
      const extra = await remoteSource(loaded.source, extensions.requested, loaded.tree, false);
      for (const [name, entry] of extra.files) loaded.files.set(name, entry);
      if (loaded.files.size > MAX_PLUGIN_FILES) fail(`Plugin has more than ${MAX_PLUGIN_FILES} files.`);
      let total = 0;
      for (const entry of loaded.files.values()) total += entry.bytes.length;
      if (total > MAX_PLUGIN_BYTES) fail(`Plugin is larger than ${MAX_PLUGIN_BYTES} bytes.`);
      parsed = parsePluginFiles(loaded.files, loaded.root);
    }
  }
  return { ...loaded, parsed };
}

function listingDetails(listing, entry) {
  return {
    ...listing,
    ...(entry ? normalizeMetadata(entry) : {}),
  };
}

function localPathIsWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (rel && !rel.startsWith(`..${sep}`) && rel !== "..");
}

export function inspectPlugin(folder) {
  assertString(folder, "Plugin folder", 2000);
  if (!isAbsolute(folder)) fail("Plugin folders must use an absolute path.");
  const info = lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("Plugin folder must be a real directory.");
  const local = readLocalFiles(folder);
  const parsed = parsePluginFiles(local.files, local.root);
  return {
    ...parsed,
    contents: clone(parsed.contents),
    config: clone(parsed.config),
    hooks: clone(parsed.hooks),
    mcpServers: clone(parsed.mcpServers),
  };
}

export class PluginCatalog {
  constructor(dir) {
    assertString(dir, "Plugin catalog folder", 2000);
    this.dir = resolve(dir);
    this.marketplaceDir = join(this.dir, "marketplaces");
    this.pluginDir = join(this.dir, "plugins");
    this.statePath = join(this.dir, "catalog.json");
    this.activeSnapshots = new Set();
    this.marketplacesById = new Map(BUILT_INS.map((item) => [item.id, { ...item }]));
    this.folderPlugins = new Map();
    this.loaded = false;
    this.loadingMarketplaces = new Map();
  }

  async _init() {
    if (this.loaded) return;
    mkdirSync(this.dir, { recursive: true });
    const root = realpathSync(this.dir);
    if (root !== this.dir) this.dir = root;
    this.marketplaceDir = join(this.dir, "marketplaces");
    this.pluginDir = join(this.dir, "plugins");
    this.statePath = join(this.dir, "catalog.json");
    mkdirSync(this.marketplaceDir, { recursive: true });
    mkdirSync(this.pluginDir, { recursive: true });
    for (const owned of [this.marketplaceDir, this.pluginDir]) {
      if (lstatSync(owned).isSymbolicLink()) fail(`Host-owned plugin path contains a symlink: ${owned}`);
    }
    if (existsSync(this.statePath)) {
      try {
        const saved = JSON.parse(readFileSync(this.statePath, "utf8"));
        for (const item of Array.isArray(saved.marketplaces) ? saved.marketplaces : []) {
          if (!item || typeof item.id !== "string") continue;
          if (item.builtIn && this.marketplacesById.has(item.id)) this.marketplacesById.set(item.id, { ...this.marketplacesById.get(item.id), ...item, builtIn: true, _entries: item.entries });
          else if (!item.builtIn) this.marketplacesById.set(item.id, { ...item, _entries: item.entries });
        }
        for (const item of Array.isArray(saved.folders) ? saved.folders : []) {
          if (item && typeof item.id === "string" && typeof item.path === "string") this.folderPlugins.set(item.id, item);
        }
      } catch {
        // A corrupt cache should not prevent the user from seeing built-ins.
      }
    }
    this.loaded = true;
  }

  async _save() {
    const state = {
      version: 1,
      marketplaces: [...this.marketplacesById.values()].map((item) => ({
        id: item.id,
        name: item.name,
        source: item.source,
        builtIn: Boolean(item.builtIn),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        ...(item.count !== undefined ? { count: item.count } : {}),
        ...(item.error ? { error: item.error } : {}),
        ...(item._entries ? { entries: item._entries } : {}),
      })),
      folders: [...this.folderPlugins.values()],
    };
    const temp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.statePath);
  }

  async _marketplaceSource(source) {
    assertString(source, "Marketplace source");
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source) && !isHttpsUrl(source)) fail("Marketplace sources must use HTTPS.");
    if (isHttpsUrl(source)) {
      const github = githubRefFromUrl(source);
      if (github && github.path) {
        return { type: "github", repo: github.repo, ref: github.ref, path: github.path, url: source };
      }
      if (github) return { type: "github", repo: github.repo, ref: github.ref };
      return { type: "url", url: source };
    }
    const [repo, ref] = source.split("#", 2);
    if (isGithubRepo(repo)) {
      const selectedRef = ref || "HEAD";
      if (!/^[A-Za-z0-9._\/-]+$/.test(selectedRef) || selectedRef.includes("..")) fail("Marketplace GitHub ref is invalid.");
      return { type: "github", repo, ref: selectedRef };
    }
    if (!isAbsolute(source)) fail("Marketplace folders must use an absolute path.");
    const input = resolve(source);
    const info = lstatSync(input);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("Marketplace folder must be a real directory.");
    const real = realpathSync(input);
    let found;
    for (const candidate of MARKETPLACE_PATHS) {
      try {
        found = readLocalFile(real, candidate);
        break;
      } catch (error) {
        if (!/ENOENT|not found|doesn't exist/i.test(error.message)) throw error;
      }
    }
    if (!found) fail("Marketplace folder has no marketplace.json.");
    return { type: "local", root: real, path: found.name };
  }

  async _readMarketplace(record, sourceInfo) {
    let value;
    if (sourceInfo.type === "local") {
      const file = readLocalFile(sourceInfo.root, sourceInfo.path);
      value = json(file.bytes, sourceInfo.path);
    } else if (sourceInfo.type === "github") {
      for (const path of sourceInfo.path ? [sourceInfo.path] : MARKETPLACE_PATHS) {
        try {
          value = await fetchJson(githubRawUrl(sourceInfo.repo, sourceInfo.ref, path));
          break;
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      if (!value) fail("This repository has no marketplace.json.");
    } else value = await fetchJson(sourceInfo.url);
    const entries = catalogEntries(value);
    const marketplace = {
      id: typeof value?.name === "string" && value.name.trim() ? value.name.trim() : record.id,
      name: record.builtIn
        ? record.name
        : (typeof value?.displayName === "string" ? value.displayName : (typeof value?.name === "string" ? value.name : record.name)),
      source: record.source,
      builtIn: Boolean(record.builtIn),
      count: entries.length,
      updatedAt: Date.now(),
      _entries: entries,
      _sourceInfo: sourceInfo,
    };
    return marketplace;
  }

  async _ensureMarketplace(record, force = false) {
    await this._init();
    const now = Date.now();
    if (!force && record._entries && record.updatedAt && now - record.updatedAt < MARKETPLACE_CACHE_TTL) return record;
    if (this.loadingMarketplaces.has(record.id)) return this.loadingMarketplaces.get(record.id);
    const loading = (async () => {
      try {
        const sourceInfo = record._sourceInfo || await this._marketplaceSource(record.source);
        const refreshed = await this._readMarketplace(record, sourceInfo);
        const { id: _catalogId, ...metadata } = refreshed;
        Object.assign(record, metadata);
        delete record.error;
        await this._save();
      } catch (error) {
        record.error = error.message;
        record.updatedAt = now;
        if (!record._entries) record._entries = [];
        await this._save();
      } finally {
        this.loadingMarketplaces.delete(record.id);
      }
      return record;
    })();
    this.loadingMarketplaces.set(record.id, loading);
    return loading;
  }

  async marketplaces() {
    await this._init();
    const result = [];
    for (const record of this.marketplacesById.values()) {
      const item = await this._ensureMarketplace(record);
      result.push({
        id: item.id,
        name: item.name,
        source: item.source,
        builtIn: Boolean(item.builtIn),
        ...(item.count !== undefined ? { count: item.count } : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        ...(item.error ? { error: item.error } : {}),
      });
    }
    return result;
  }

  async addMarketplace(source) {
    await this._init();
    const sourceInfo = await this._marketplaceSource(source);
    const temporary = { id: sha256(source).slice(0, 16), name: source, source, builtIn: false };
    const loaded = await this._readMarketplace(temporary, sourceInfo);
    const id = loaded.id;
    const existing = this.marketplacesById.get(id);
    if (existing && (existing.builtIn || existing.source !== source)) fail(`Marketplace id ${id} is already registered from another source.`);
    const record = {
      ...(existing || {}),
      id,
      name: loaded.name,
      source,
      builtIn: Boolean(existing?.builtIn),
      count: loaded.count,
      updatedAt: loaded.updatedAt,
      _entries: loaded._entries,
      _sourceInfo: sourceInfo,
    };
    this.marketplacesById.set(id, record);
    await this._save();
    return {
      id: record.id,
      name: record.name,
      source: record.source,
      builtIn: record.builtIn,
      count: record.count,
      updatedAt: record.updatedAt,
    };
  }

  async removeMarketplace(id) {
    await this._init();
    assertString(id, "Marketplace id");
    const record = this.marketplacesById.get(id);
    if (!record) return;
    if (record.builtIn) fail("Built-in marketplaces cannot be removed.");
    this.marketplacesById.delete(id);
    await this._save();
  }

  _folderListing(record) {
    return {
      id: record.id,
      name: record.name,
      marketplace: "folder",
      ...(record.description ? { description: record.description } : {}),
      ...(record.version ? { version: record.version } : {}),
      ...(record.author ? { author: record.author } : {}),
      ...(record.homepage ? { homepage: record.homepage } : {}),
      ...(record.repository ? { repository: record.repository } : {}),
      ...(record.license ? { license: record.license } : {}),
      ...(record.keywords ? { keywords: record.keywords } : {}),
      installed: true,
    };
  }

  async browse(query = {}) {
    await this._init();
    const options = typeof query === "string" ? { query } : (query || {});
    const text = options.query === undefined ? "" : (() => {
      if (typeof options.query !== "string" || options.query.includes("\0") || options.query.length > 200)
        fail("Plugin query must be at most 200 characters.");
      return options.query;
    })();
    const marketplaceFilter = options.marketplace ? assertString(options.marketplace, "Marketplace id") : undefined;
    const cursor = options.cursor ? Number.parseInt(String(options.cursor), 10) : 0;
    const offset = Number.isFinite(cursor) && cursor >= 0 ? cursor : 0;
    const records = [];
    for (const marketplace of this.marketplacesById.values()) {
      if (marketplaceFilter && marketplace.id !== marketplaceFilter) continue;
      const loaded = await this._ensureMarketplace(marketplace);
      for (const entry of loaded._entries || []) {
        const listing = listingFromEntry(entry, loaded);
        if (!listing) continue;
        const haystack = [listing.name, listing.description, ...(listing.keywords || [])].filter(Boolean).join(" ").toLowerCase();
        if (text && !haystack.includes(text.toLowerCase())) continue;
        records.push(listing);
      }
    }
    for (const folder of this.folderPlugins.values()) {
      const listing = this._folderListing(folder);
      const haystack = [listing.name, listing.description, ...(listing.keywords || [])].filter(Boolean).join(" ").toLowerCase();
      if ((!text || haystack.includes(text.toLowerCase())) && (!marketplaceFilter || marketplaceFilter === "folder")) records.push(listing);
    }
    records.sort((a, b) => a.name.localeCompare(b.name) || a.marketplace.localeCompare(b.marketplace));
    const page = records.slice(offset, offset + 50);
    return {
      plugins: page,
      ...(offset + page.length < records.length ? { cursor: String(offset + page.length) } : {}),
    };
  }

  async _resolveListing(id) {
    assertString(id, "Plugin id");
    const folder = this.folderPlugins.get(id);
    if (folder) return { listing: this._folderListing(folder), entry: folder.entry, source: { type: "local", path: folder.path }, folder };
    const at = id.lastIndexOf("@");
    if (at <= 0) fail("Plugin id must be name@marketplace.");
    const marketplaceId = id.slice(at + 1);
    const marketplace = this.marketplacesById.get(marketplaceId);
    if (!marketplace) fail(`Unknown marketplace: ${marketplaceId}`);
    await this._ensureMarketplace(marketplace);
    const entry = (marketplace._entries || []).find((candidate) => candidate?.name === id.slice(0, at));
    if (!entry) fail(`Unknown plugin: ${id}`);
    const listing = listingFromEntry(entry, marketplace);
    const source = normalizeGithubSource(entry.source, marketplace._sourceInfo || await this._marketplaceSource(marketplace.source));
    return { listing, entry, source, marketplace };
  }

  async _review(id) {
    const resolved = await this._resolveListing(id);
    const local = await readPluginSource(resolved.source);
    const parsed = local.parsed;
    const revision = hashFiles(local.files);
    const listing = {
      ...listingDetails(resolved.listing, resolved.entry),
      name: parsed.name,
      ...normalizeMetadata(parsed.manifest),
    };
    const preview = publicPreview(parsed, listing, revision);
    const review = { id, revision, files: local.files, parsed, preview, source: local.source || resolved.source };
    return review;
  }

  async preview(id) {
    await this._init();
    const review = await this._review(id);
    return clone(review.preview);
  }

  async _writeSnapshot(id, revision, files) {
    const destination = join(this.pluginDir, safeId(id), revision);
    assertNoSymlinkPath(destination, this.dir);
    if (existsSync(destination)) {
      const existing = readLocalFiles(destination);
      if (hashFiles(existing.files) !== revision) fail("An immutable plugin snapshot was modified.");
      return destination;
    }
    const parent = dirname(destination);
    mkdirSync(parent, { recursive: true });
    const temp = join(parent, `.${revision}.${process.pid}.${randomUUID()}`);
    mkdirSync(temp, { recursive: true });
    try {
      for (const [name, entry] of files) {
        const output = join(temp, ...name.split("/"));
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, entry.bytes, { mode: (entry.mode || 0o644) & 0o777 });
        // Keep snapshots read-only after writing.  The containing directory is
        // still writable by the host for later, distinct revisions.
        chmodSync(output, (entry.mode || 0) & 0o111 ? 0o555 : 0o444);
      }
      const directories = new Set([temp]);
      for (const name of files.keys()) {
        let current = dirname(join(temp, ...name.split("/")));
        while (current.startsWith(`${temp}${sep}`)) {
          directories.add(current);
          current = dirname(current);
        }
      }
      // Keep directories owner-writable so normal host cleanup works.  File
      // bytes remain read-only and every reuse verifies the content digest.
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) chmodSync(directory, 0o700);
      renameSync(temp, destination);
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      throw error;
    }
    return destination;
  }

  async materialize(id, revision = undefined) {
    await this._init();
    if (revision !== undefined && (typeof revision !== "string" || !/^[a-f0-9]{64}$/.test(revision)))
      fail("Plugin revision must be a SHA-256 hash.");
    // Hash and install the same in-memory bytes. A preview does not need to retain
    // a second copy of every file or hold an entire plugin in memory indefinitely.
    const review = await this._review(id);
    if (revision !== undefined && review.revision !== revision)
      fail(`Plugin ${id} changed after revision ${revision} was reviewed; preview it again.`);
    const folder = await this._writeSnapshot(id, review.revision, review.files);
    this.activeSnapshots.add(folder);
    return { folder, preview: clone(review.preview), revision: review.revision };
  }

  async addFolder(folder) {
    await this._init();
    assertString(folder, "Plugin folder", 2000);
    if (!isAbsolute(folder)) fail("Plugin folders must use an absolute path.");
    const source = resolve(folder);
    const info = lstatSync(source);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("Plugin folder must be a real directory.");
    const real = realpathSync(source);
    if (localPathIsWithin(real, this.dir)) fail("A plugin folder must be outside the catalog's host-owned folder.");
    const local = readLocalFiles(real);
    const parsed = parsePluginFiles(local.files, real);
    const pathId = sha256(real).slice(0, 12);
    const listing = listingDetails({ id: `${parsed.name}@folder-${pathId}`, name: parsed.name, marketplace: "folder" }, parsed.manifest);
    const id = listing.id;
    const revision = hashFiles(local.files);
    const preview = publicPreview(parsed, listing, revision);
    const materialized = await this._writeSnapshot(id, revision, local.files);
    this.activeSnapshots.add(materialized);
    this.folderPlugins.set(id, {
      id,
      path: real,
      entry: { name: parsed.name, source: "." },
      name: parsed.name,
      ...normalizeMetadata(parsed.manifest),
      installedAt: Date.now(),
    });
    await this._save();
    return { folder: materialized, preview: clone(preview), revision };
  }

  /** Forget a folder plugin's listing after the host has uninstalled it.
   * Reviewed and materialized bytes remain available to already-running
   * sessions; a later addFolder() creates the listing again with the same ID.
   */
  async forgetFolder(id) {
    await this._init();
    assertString(id, "Plugin id");
    if (!this.folderPlugins.delete(id)) return;
    await this._save();
  }

  /** Remove unreferenced immutable snapshots under this catalog's own root.
   * Callers should pass snapshots still used by running sessions.  Reviews and
   * snapshots materialized by this instance are also retained, so an in-flight
   * confirmation cannot lose its bytes; a fresh catalog instance can prune on
   * startup once it has restored its active session folders.
   */
  async pruneSnapshots(currentFolders = []) {
    await this._init();
    if (!Array.isArray(currentFolders)) fail("Current snapshot folders must be an array.");
    const keep = new Set(this.activeSnapshots);
    for (const folder of currentFolders) {
      assertString(folder, "Snapshot folder", 2000);
      const real = resolve(folder);
      if (!localPathIsWithin(real, this.pluginDir)) fail("Snapshot cleanup may only use folders in the catalog's host-owned folder.");
      assertNoSymlinkPath(real, this.dir);
      keep.add(real);
    }
    const removed = [];
    for (const pluginEntry of readdirSync(this.pluginDir, { withFileTypes: true })) {
      if (pluginEntry.isSymbolicLink()) fail(`Host-owned plugin path contains a symlink: ${pluginEntry.name}`);
      if (!pluginEntry.isDirectory()) continue;
      const pluginFolder = join(this.pluginDir, pluginEntry.name);
      for (const revisionEntry of readdirSync(pluginFolder, { withFileTypes: true })) {
        if (revisionEntry.isSymbolicLink()) fail(`Host-owned plugin path contains a symlink: ${revisionEntry.name}`);
        if (!revisionEntry.isDirectory()) continue;
        const snapshot = join(pluginFolder, revisionEntry.name);
        if (keep.has(snapshot)) continue;
        rmSync(snapshot, { recursive: true, force: true });
        removed.push(snapshot);
      }
    }
    return removed;
  }
}

export default PluginCatalog;
