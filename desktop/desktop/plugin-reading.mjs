// What a plugin starts on this computer: read here, once, for the two that need it.
//
//  - The description (desktop/plugin-catalog.mjs) reads a plugin's files before it is installed,
//    and shows the person what it will start: each command, with its words, its folder and the
//    names of its environment values.
//  - The runtime (desktop/plugin-runtime.mjs) reads the installed copy when a session opens, and
//    starts those things.
//
// The two must say the same, or a plugin is shown as one thing and runs as another. So neither
// reads a plugin's manifest, tool files or hook files by itself: both call `pluginStarts` with a
// way to read a file, and take what it answers. A rule about which file counts, which key is the
// command or which name may be set is written in this file and nowhere else.
//
// `read(path)` gives the text of the regular file at exactly that path below the plugin's folder
// (parts joined with "/"), or null. Two readers are here: one over files held in memory, and one
// over a folder on disk. Both take a name to the letter, so that "HOOKS.JSON" is not "hooks.json"
// on a disk that would say it is.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where a plugin's manifest is looked for. The first file that exists is the manifest; a later one is never read. */
export const MANIFESTS = [".plugin/plugin.json", "plugin.json", ".github/plugin.json", ".github/plugin/plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"];
/** The tool files that are read when the manifest names none. All that exist are read. */
export const MCP_FILES = [".mcp.json", "mcp.json", ".claude-plugin/.mcp.json", ".claude-plugin/mcp.json"];
/** The hook files that are tried when the manifest names none. The first that has a `hooks` object is used. */
export const HOOK_FILES = ["hooks.json", "hooks/hooks.json", ".claude-plugin/hooks.json", ".claude-plugin/hooks/hooks.json"];
/** The events a hook can be for, and the runtime's name for each. A hook for another event never runs. */
export const EVENTS = {
  sessionStart: "onSessionStart",
  userPromptSubmitted: "onUserPromptSubmitted",
  preToolUse: "onPreToolUse",
  postToolUse: "onPostToolUse",
  postToolUseFailure: "onPostToolUseFailure",
  agentStop: "onAgentStop",
  subagentStart: "onSubagentStart",
  subagentStop: "onSubagentStop",
  sessionEnd: "onSessionEnd",
  errorOccurred: "onErrorOccurred",
};
/** What is shown is shown whole. Longer than this is not started, and a plugin with such a thing is not installed. */
export const LIMITS = { hookCommand: 4_000, command: 2_000, arg: 4_000, args: 200, cwd: 2_000, name: 200, url: 4_000, value: 8_000, file: 1_000_000 };
/** The values Botkins itself puts in place of ${NAME}. Every other ${NAME} is a setting of the plugin. */
export const BUILT_IN_VALUES = ["PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "BOTKINS_DIR", "BOTKINS_CHAT_ID", "BOTKINS_BOT_ID"];
export const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Names Botkins sets itself, or that the system needs as they are. A plugin sets none of them. */
export const RESERVED = new Set(["HOME", "PATH", "NODE_PATH", "PWD", "OLDPWD", "PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "SYSTEMDRIVE", "PROGRAMFILES", "PROGRAMW6432", "PROGRAMDATA", "ELECTRON_RUN_AS_NODE", "PYTHONDONTWRITEBYTECODE"]);
/**
 * Names that make a program load or run something more than its command says: a shell's start
 * file, a runtime's options and search paths, the loader's libraries. With one of these, a hook
 * shown as `node -v` could run a file of the plugin. A plugin sets none of them, for a hook or
 * for a tool.
 */
const LOADERS = new Set(["NODE_OPTIONS", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PROMPT_COMMAND", "PS4", "IFS", "CDPATH", "GLOBIGNORE", "ZDOTDIR", "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PYTHONINSPECT", "PERL5OPT", "PERL5LIB", "PERLLIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "LUA_INIT", "LUA_PATH", "LUA_CPATH"]);
const LOADER_STARTS = ["LD_", "DYLD_", "BASH_FUNC_"];
/** The names a plugin may not set, for the guide and for the people who write plugins. */
export const NAMES_NOT_SET = { reserved: [...RESERVED], loaders: [...LOADERS], loaderStarts: LOADER_STARTS };
/** True for an environment name a plugin may set. */
export function envName(key) {
  if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) return false;
  const upper = key.toUpperCase();
  return !RESERVED.has(upper) && !LOADERS.has(upper) && !LOADER_STARTS.some((start) => upper.startsWith(start));
}

const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
const text = (value, max) => (typeof value === "string" && value.length <= max && !value.includes("\0") ? value : null);
const parse = (source) => {
  if (typeof source !== "string" || source.length > LIMITS.file) return null;
  try {
    return object(JSON.parse(source));
  } catch {
    return null;
  }
};

/**
 * A path a plugin's manifest names, in its one form, or null. A path that is absolute, that has
 * "..", a backslash or a drive, is no path of the plugin.
 */
export function declaredPath(value) {
  if (typeof value !== "string" || !value || value.length > 1_000 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const parts = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

/** A reader over files held in memory: a Map of path → { bytes }. */
export const filesReader = (files) => (path) => {
  const entry = files.get(path);
  return entry ? Buffer.from(entry.bytes).toString("utf8") : null;
};
/**
 * A reader over a folder on disk. Each part of the path must be in its folder under exactly that
 * name, a folder must be a real folder and the file a regular file: a link is not followed, and
 * a disk that takes "A" for "a" does not make them the same here.
 */
export function folderReader(folder) {
  const lists = new Map();
  const list = (dir) => {
    if (!lists.has(dir)) {
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {}
      lists.set(dir, new Map(entries.map((entry) => [entry.name, entry])));
    }
    return lists.get(dir);
  };
  return (path) => {
    const parts = path.split("/");
    let at = folder;
    for (let index = 0; index < parts.length; index++) {
      const entry = list(at).get(parts[index]);
      if (!entry || !(index === parts.length - 1 ? entry.isFile() : entry.isDirectory())) return null;
      at = join(at, parts[index]);
    }
    try {
      return readFileSync(at, "utf8");
    } catch {
      return null;
    }
  };
}

/** The plugin's manifest: { path, manifest }. `manifest` is null when the file is not a JSON object; `path` is null when there is no file. */
export function firstManifest(read) {
  for (const path of MANIFESTS) {
    const source = read(path);
    if (source !== null) return { path, manifest: parse(source) };
  }
  return { path: null, manifest: null };
}

/** Each tool a plugin names, in the order read: [{ name, config }]. A later one with the same name takes the place of an earlier one. */
function serverEntries(read, manifest) {
  const out = [];
  const add = (value) => {
    const source = object(value?.mcpServers ?? value?.servers ?? value);
    if (!source) return;
    for (const [name, config] of Object.entries(source)) if (object(config)) out.push({ name, config });
  };
  const declared = manifest.mcpServers;
  if (typeof declared === "string") {
    const path = declaredPath(declared);
    const data = path ? parse(read(path)) : null;
    if (data) add(data);
  } else if (!object(declared)) {
    for (const file of MCP_FILES) {
      const data = parse(read(file));
      if (data) add(data);
    }
  }
  if (object(declared)) add(declared);
  return out;
}

/** The names of an object's string values that a plugin may set, with each value as written. */
const named = (value, allowed) => Object.fromEntries(Object.entries(object(value) ?? {}).filter(([key, item]) => allowed(key) && typeof item === "string" && item.length <= LIMITS.value && !item.includes("\0")));

/**
 * What one tool of a plugin is: a program to start, an address to reach, or nothing (null).
 * `{ refused }` says why it is too long to show whole.
 */
function serverPlan(config) {
  const type = config.type === "local" ? "stdio" : config.type === "streamable-http" ? "http" : (config.type ?? (config.url || config.serverUrl ? "http" : "stdio"));
  if (type === "stdio") {
    if (typeof config.command !== "string" || !config.command) return null;
    const command = text(config.command, LIMITS.command);
    if (!command) return { refused: "a tool's command is longer than " + LIMITS.command + " characters" };
    // Every word of a list is taken or the tool is not started: a line with a word left out is another line.
    const args = Array.isArray(config.args) ? config.args : [];
    if (args.length > LIMITS.args || args.some((arg) => text(arg, LIMITS.arg) === null)) return { refused: "a tool's arguments are not at most " + LIMITS.args + " words of at most " + LIMITS.arg + " characters each" };
    const folder = typeof config.cwd === "string" ? config.cwd : typeof config.workingDirectory === "string" ? config.workingDirectory : null;
    if (folder !== null && !text(folder, LIMITS.cwd)) return { refused: "a tool's folder is longer than " + LIMITS.cwd + " characters" };
    return { kind: "local", command, args: [...args], env: named(config.env, envName), cwd: folder || null };
  }
  if (type !== "http" && type !== "sse") return null;
  const url = text(String(config.url ?? config.serverUrl ?? ""), LIMITS.url);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  // Sign-in through a browser: a mark, an object with a client's id, or the same below `authentication`.
  const declared = config.oauth || config.authentication?.oauth;
  const oauth = declared === true ? {} : object(declared) ? declared : config.oauthClientId ? { clientId: config.oauthClientId } : null;
  const clientId = oauth ? text(oauth.clientId ?? config.oauthClientId, 1_000) : null;
  return { kind: "remote", type, url, headers: named(config.headers, (key) => key.length <= LIMITS.name && !key.includes("\0")), oauth: oauth ? { ...(clientId && { clientId }) } : null };
}

/** The object of a plugin's hooks, event → entries, or {}. */
function hookSource(read, manifest) {
  const declared = manifest.hooks;
  if (object(declared)) return object(declared.hooks) ?? declared;
  if (typeof declared === "string") {
    const path = declaredPath(declared);
    return (path ? object(parse(read(path))?.hooks) : null) ?? {};
  }
  for (const file of HOOK_FILES) {
    const hooks = object(parse(read(file))?.hooks);
    if (hooks) return hooks;
  }
  return {};
}
const canonicalEvent = (name) => {
  const value = String(name ?? "").replace(/[-_ ]/g, "").toLowerCase();
  return Object.keys(EVENTS).find((event) => event.toLowerCase() === value) ?? null;
};
/** The entries below one event, with lists opened. An entry with a matcher is left out: Botkins cannot hold to a matcher, so it does not run the hook at all. */
const flatten = (value, depth = 0) => {
  if (depth > 20) return [];
  if (Array.isArray(value)) return value.flatMap((item) => flatten(item, depth + 1));
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "matcher") || Object.hasOwn(value, "match")) return [];
    if (Array.isArray(value.hooks)) return flatten(value.hooks, depth + 1);
    if (Array.isArray(value.commands)) return flatten(value.commands, depth + 1);
  }
  return value ? [value] : [];
};
/** The one command of a hook entry: the entry itself when it is text, else the first of these keys that has text. An entry's `type` is not read. */
const COMMAND_KEYS = ["command", "bash", "cmd", "shell", "powershell", "windows", "darwin", "macos", "linux"];
const commandFor = (entry, depth = 0) => {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object" || depth > 20) return null;
  if (entry.hooks) return commandFor(entry.hooks, depth + 1);
  if (entry.commands) return commandFor(entry.commands, depth + 1);
  return COMMAND_KEYS.map((key) => entry[key]).find((value) => typeof value === "string" && value.trim()) ?? null;
};

/**
 * Everything a plugin starts, from its files:
 *   manifestPath, manifest   the manifest that counts (manifest is null when it cannot be read)
 *   servers   [{ name, kind: "local", command, args, env, cwd } | { name, kind: "remote", type, url, headers, oauth }]
 *             `env` and `headers` are name → the value as written (it can hold ${SETTING}); `cwd` is null for the plugin's own folder
 *   hooks     [{ event, command, env, timeoutMs }], in the order they run
 *   refused   why the plugin cannot be shown whole (a command too long): such a thing is in neither list
 * The runtime starts what is in `servers` and `hooks` and nothing more of a plugin.
 */
export function pluginStarts(read) {
  const { path: manifestPath, manifest } = firstManifest(read);
  const refused = [];
  if (!manifest) return { manifestPath, manifest: null, servers: [], hooks: [], refused };
  const byName = new Map();
  for (const { name, config } of serverEntries(read, manifest)) {
    const plan = serverPlan(config);
    if (!plan) continue;
    if (plan.refused || text(name, LIMITS.name) === null) {
      // Nothing runs under a name whose last word cannot be shown.
      byName.delete(name);
      refused.push(plan.refused ?? "a tool's name is longer than " + LIMITS.name + " characters");
    } else byName.set(name, { name, ...plan });
  }
  const byEvent = new Map();
  for (const [rawEvent, rawEntries] of Object.entries(hookSource(read, manifest))) {
    const event = canonicalEvent(rawEvent);
    if (!event) continue;
    const entries = [];
    for (const entry of flatten(rawEntries)) {
      const command = commandFor(entry);
      if (typeof command !== "string" || !command.trim()) continue;
      if (!text(command, LIMITS.hookCommand)) {
        refused.push("a hook's command is longer than " + LIMITS.hookCommand + " characters");
        continue;
      }
      const seconds = Number(object(entry)?.timeoutSec || 10);
      entries.push({ event, command, env: named(object(entry)?.env, envName), timeoutMs: Math.max(250, Math.min(30_000, (Number.isFinite(seconds) ? seconds : 10) * 1_000)) });
    }
    // The same event under two spellings: the later one is the one that runs.
    if (entries.length) byEvent.set(event, entries);
  }
  return { manifestPath, manifest, servers: [...byName.values()], hooks: [...byEvent.values()].flat(), refused };
}

const settingsIn = (value) => [...String(value).matchAll(PLACEHOLDER)].map((match) => match[1]).filter((key) => !BUILT_IN_VALUES.includes(key));

/**
 * The same, as a person is shown it (`contents.mcpServers` and `contents.hooks` of plugins-v1),
 * with no value: a command's words, its folder, and the names that get a value.
 *   sentTo   setting → where its value goes: [{ tool, env } | { tool, header, url } | { hook, env }]
 */
export function describeStarts(starts) {
  const sentTo = new Map();
  const goes = (value, where) => {
    for (const key of settingsIn(value)) sentTo.set(key, [...(sentTo.get(key) ?? []), where]);
  };
  const mcpServers = starts.servers.map((server) => {
    if (server.kind === "local") {
      for (const [name, value] of Object.entries(server.env)) goes(value, { tool: server.name, env: name });
      return { name: server.name, kind: "local", command: server.command, args: [...server.args], env: Object.keys(server.env), ...(server.cwd && { cwd: server.cwd }) };
    }
    for (const [name, value] of Object.entries(server.headers)) goes(value, { tool: server.name, header: name, url: server.url });
    return { name: server.name, kind: "remote", url: server.url, headers: Object.keys(server.headers), ...(server.oauth && { oauth: true }) };
  });
  const hooks = starts.hooks.map((hook) => {
    for (const [name, value] of Object.entries(hook.env)) goes(value, { hook: hook.event, env: name });
    return { event: hook.event, command: hook.command, env: Object.keys(hook.env), timeoutSec: hook.timeoutMs / 1_000 };
  });
  return { mcpServers, hooks, sentTo };
}

const START_WARNINGS = { hooks: "Runs a command on your computer through plugin hooks.", local: "Runs a local MCP server on your computer.", remote: "Connects to a remote MCP server." };
/** A description's warnings, with the sentences about what the plugin starts made again from its lists. */
export function startWarnings(mcpServers, hooks, others = []) {
  return [
    ...others.filter((line) => !Object.values(START_WARNINGS).includes(line)),
    ...(hooks.length ? [START_WARNINGS.hooks] : []),
    ...(mcpServers.some((server) => server.kind === "local") ? [START_WARNINGS.local] : []),
    ...(mcpServers.some((server) => server.kind === "remote") ? [START_WARNINGS.remote] : []),
  ];
}
