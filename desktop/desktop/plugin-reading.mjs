// What a plugin starts on this computer: read here, once, for the two that need it.
//
//  - The description (desktop/plugin-catalog.mjs) reads a plugin's files before it is installed,
//    and shows the person what it will start: each command, with its words, its folder and each
//    environment name with its value as the plugin wrote it.
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
/** The language-server files. Nothing is started from them: Botkins skips a plugin's language servers, and only their names are shown. The first that exists is read. */
export const LSP_FILES = ["lsp.json", ".lsp.json", ".claude-plugin/lsp.json"];
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
export const LIMITS = { hookCommand: 4_000, command: 2_000, arg: 4_000, args: 200, cwd: 2_000, name: 200, url: 4_000, value: 4_000, file: 1_000_000 };
/** The values Botkins itself puts in place of ${NAME}. Every other ${NAME} is a setting of the plugin. */
export const BUILT_IN_VALUES = ["PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "BOTKINS_DIR", "BOTKINS_CHAT_ID", "BOTKINS_BOT_ID"];
export const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Names Botkins sets itself, or that the system needs as they are. A plugin sets none of them. */
export const RESERVED = new Set(["HOME", "PATH", "NODE_PATH", "PWD", "OLDPWD", "PLUGIN_ROOT", "PLUGIN_DATA", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "SYSTEMDRIVE", "PROGRAMFILES", "PROGRAMW6432", "PROGRAMDATA", "ELECTRON_RUN_AS_NODE", "PYTHONDONTWRITEBYTECODE"]);
/**
 * Names that make a program load or run something more than its command says. A list of single
 * names is never complete, so whole families are refused by how a name starts: a language's
 * options and search paths (PYTHON, RUBY, GEM_, NODE_, PERL, PHP_, JAVA_, LUA_ ...), git, the
 * loader's libraries, a shell's start file, a pager. With one of these, a hook shown as
 * `node -v` could run a file of the plugin. A plugin sets none of them, for a hook or for a
 * tool, unless the name is in `ALLOWED_NAMES`. They are a second defense: the description also
 * names each environment name that is not set, with the reason (`envNotSet`).
 * A family is only as wide as it must be: `PHP` alone would catch PHPSESSID, which is nobody's
 * loader, so PHP has the family `PHP_` and the one name `PHPRC`; make has three single names.
 */
const NAME_STARTS = ["PYTHON", "RUBY", "GEM_", "NODE_", "NPM_", "GIT_", "PHP_", "PERL", "JAVA_", "_JAVA", "JDK_", "DOTNET_", "OPENSSL_", "LD_", "DYLD_", "BASH", "XDG_", "GIO_", "LESS", "LUA_"];
/** Single names that no family above covers. Most make a program start another program, or read a file of the plugin as its own settings. */
const REFUSED_NAMES = new Set(["ENV", "SHELLOPTS", "PROMPT_COMMAND", "PS4", "IFS", "CDPATH", "GLOBIGNORE", "ZDOTDIR", "PAGER", "EDITOR", "VISUAL", "CLASSPATH", "BUNDLE_GEMFILE", "GCONV_PATH", "SHELL", "BROWSER", "PHPRC", "MAKEFLAGS", "MAKEFILES", "MAKELEVEL", "AWS_CONFIG_FILE", "KUBECONFIG", "GOFLAGS", "RUSTC_WRAPPER", "PUPPETEER_EXECUTABLE_PATH"]);
/** Names that are harmless although a family covers them. Exact names only: they win over a family. */
const ALLOWED_NAMES = new Set(["NODE_ENV", "PYTHONUNBUFFERED", "PYTHONIOENCODING", "PYTHONUTF8", "NO_COLOR", "FORCE_COLOR"]);
/** The names a plugin may not set, for the guide and for the people who write plugins. */
export const NAMES_NOT_SET = { reserved: [...RESERVED], names: [...REFUSED_NAMES], starts: [...NAME_STARTS], allowed: [...ALLOWED_NAMES] };
const LOADS_MORE = "can make a program load or start more than its command says.";
/**
 * The sentence that says why Botkins does not set an environment name, or null when it sets it.
 * `value` is read only when it is given: a value that is not text is not set either.
 */
export function whyNotSet(key, value) {
  if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) return "This is not a name that can be set.";
  const upper = key.toUpperCase();
  if (RESERVED.has(upper)) return "Botkins or the system sets this name.";
  if (REFUSED_NAMES.has(upper)) return "Botkins does not set this name. It " + LOADS_MORE;
  const family = ALLOWED_NAMES.has(upper) ? null : NAME_STARTS.find((start) => upper.startsWith(start));
  if (family) return "Botkins sets no name that starts with " + family + ". Such a name " + LOADS_MORE;
  if (value !== undefined && typeof value !== "string") return "Its value is not text.";
  return null;
}
/** True for an environment name a plugin may set. */
export const envName = (key) => whyNotSet(key) === null;

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

/**
 * A header's values as written, name → text. A header that is not text is left out; one too long
 * to show whole is refused, as for the environment.
 */
function headersOf(value) {
  const entries = [];
  for (const [key, item] of Object.entries(object(value) ?? {})) {
    if (key.length > LIMITS.name || key.includes("\0")) return { refused: "a header name is longer than " + LIMITS.name + " characters" };
    if (typeof item !== "string") continue;
    if (item.length > LIMITS.value || item.includes("\0")) return { refused: "a header value is longer than " + LIMITS.value + " characters" };
    entries.push([key, item]);
  }
  return { headers: Object.fromEntries(entries) };
}

/**
 * What an `env` object sets, as written: `env` is name → value, `envNotSet` is every key that
 * Botkins does not set (a name it sets itself or that loads code, a bad name, a value that is not
 * text), each as { name, why }. A name or a value too long to show whole refuses the thing it is for.
 */
function environmentOf(value) {
  const entries = [];
  const envNotSet = [];
  for (const [key, item] of Object.entries(object(value) ?? {})) {
    if (key.length > LIMITS.name) return { refused: "an environment name is longer than " + LIMITS.name + " characters" };
    const why = whyNotSet(key, item);
    if (why) {
      envNotSet.push({ name: key, why });
      continue;
    }
    if (item.length > LIMITS.value) return { refused: "an environment value is longer than " + LIMITS.value + " characters" };
    if (item.includes("\0")) return { refused: "an environment value has a NUL character" };
    entries.push([key, item]);
  }
  return { env: Object.fromEntries(entries), envNotSet };
}

/** One word of a tool's line as text: text as it is, a finite number or true/false as it is written, or `{ refused }`. */
function wordOf(arg) {
  if (typeof arg === "number" && Number.isFinite(arg)) return String(arg);
  if (typeof arg === "boolean") return String(arg);
  if (typeof arg !== "string" || arg.includes("\0")) return { refused: "a tool's argument is not text, a number or true/false" };
  if (arg.length > LIMITS.arg) return { refused: "a tool's argument is longer than " + LIMITS.arg + " characters" };
  return arg;
}

/**
 * The folder a tool starts in: null for the plugin's own folder, an absolute path as written, or a
 * path below the plugin's own folder in its one form (for example `server/bin`). `{ refused }`
 * when it is too long, or when a relative path leaves the plugin's folder.
 */
function folderOf(value) {
  if (typeof value !== "string" || value === "") return { cwd: null };
  if (value.length > LIMITS.cwd) return { refused: "a tool's folder is longer than " + LIMITS.cwd + " characters" };
  if (value.includes("\0")) return { refused: "a tool's folder has a NUL character" };
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return { cwd: value };
  if (value.split("/").every((part) => part === "" || part === ".")) return { cwd: null };
  const inside = declaredPath(value);
  return inside ? { cwd: inside } : { refused: "a tool's folder leaves the plugin's own folder" };
}

/** Why a tool is not run, one fixed sentence each. */
const NO_TOOL = { type: "Botkins has no tool of this type.", command: "This tool has no command.", address: "This tool's address is not an http or https address." };
/**
 * What one tool of a plugin is: a program to start, an address to reach, `{ notRun }` with the
 * sentence that says why it is neither, or `{ refused }` with why it is too long to show whole.
 */
function serverPlan(config) {
  const type = config.type === "local" ? "stdio" : config.type === "streamable-http" ? "http" : (config.type ?? (config.url || config.serverUrl ? "http" : "stdio"));
  if (type === "stdio") {
    if (typeof config.command !== "string" || !config.command) return { notRun: NO_TOOL.command };
    const command = text(config.command, LIMITS.command);
    if (!command) return { refused: "a tool's command is longer than " + LIMITS.command + " characters" };
    // Every word of a list is taken or the tool is not started: a line with a word left out is another line.
    const given = Array.isArray(config.args) ? config.args : [];
    if (given.length > LIMITS.args) return { refused: "a tool has more than " + LIMITS.args + " arguments" };
    const args = [];
    for (const arg of given) {
      const word = wordOf(arg);
      if (typeof word !== "string") return word;
      args.push(word);
    }
    const { cwd, refused: folderRefused } = folderOf(typeof config.cwd === "string" ? config.cwd : config.workingDirectory);
    if (folderRefused) return { refused: folderRefused };
    const { env, envNotSet, refused } = environmentOf(config.env);
    if (refused) return { refused };
    return { kind: "local", command, args, env, envNotSet, cwd };
  }
  if (type !== "http" && type !== "sse") return { notRun: NO_TOOL.type };
  const written = String(config.url ?? config.serverUrl ?? "");
  if (written.length > LIMITS.url) return { refused: "a tool's address is longer than " + LIMITS.url + " characters" };
  const url = text(written, LIMITS.url);
  if (!url || !/^https?:\/\//i.test(url)) return { notRun: NO_TOOL.address };
  // Sign-in through a browser: a mark, an object with a client's id, or the same below `authentication`.
  const declared = config.oauth || config.authentication?.oauth;
  const oauth = declared === true ? {} : object(declared) ? declared : config.oauthClientId ? { clientId: config.oauthClientId } : null;
  const clientId = oauth ? text(oauth.clientId ?? config.oauthClientId, 1_000) : null;
  const { headers, refused } = headersOf(config.headers);
  if (refused) return { refused };
  return { kind: "remote", type, url, headers, oauth: oauth ? { ...(clientId && { clientId }) } : null };
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
/** Names that Claude-format plugins use for an event that only differs from one of ours in spelling. Written as `canonicalEvent` compares: lower case, no "-", "_" or space. */
const EVENT_ALIASES = { userpromptsubmit: "userPromptSubmitted", stop: "agentStop" };
const plain = (name) => String(name ?? "").replace(/[-_ ]/g, "").toLowerCase();
const canonicalEvent = (name) => {
  const value = plain(name);
  return Object.keys(EVENTS).find((event) => event.toLowerCase() === value) ?? EVENT_ALIASES[value] ?? null;
};
/** An event that an earlier Botkins did not run: it knew only its own spellings. */
const isAlias = (name) => Object.hasOwn(EVENT_ALIASES, plain(name)) && !Object.keys(EVENTS).some((event) => event.toLowerCase() === plain(name));
/** A matcher of "*" or "" means all: it is no matcher. Any other makes the hook one Botkins cannot hold to, so it does not run it. */
const hasMatcher = (entry) => ["matcher", "match"].some((key) => Object.hasOwn(entry, key) && !["", "*"].includes(String(entry[key]).trim()));
/** A matcher of "*" or "" on the entry itself. An earlier Botkins took any matcher to mean "do not run", so such a hook runs now and did not before. */
const allMatcher = (entry) => ["matcher", "match"].some((key) => Object.hasOwn(entry, key) && ["", "*"].includes(String(entry[key]).trim()));
/** The same, on the entry or a step down from it. */
const matchesAll = (entry, depth = 0) => {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || depth > 20) return false;
  return allMatcher(entry) || matchesAll(entry.hooks, depth + 1) || matchesAll(entry.commands, depth + 1);
};
/**
 * The entries below one event, with lists opened, each as { entry, all }: `all` is true when the
 * entry, or a step above or below it, has a matcher of "*" or "". An entry with another matcher
 * is left out and counted in `seen.matched`.
 */
const flatten = (value, seen, depth = 0, all = false) => {
  if (depth > 20) return [];
  if (Array.isArray(value)) return value.flatMap((item) => flatten(item, seen, depth + 1, all));
  if (value && typeof value === "object") {
    if (hasMatcher(value)) {
      seen.matched++;
      return [];
    }
    const here = all || allMatcher(value);
    if (Array.isArray(value.hooks)) return flatten(value.hooks, seen, depth + 1, here);
    if (Array.isArray(value.commands)) return flatten(value.commands, seen, depth + 1, here);
  }
  return value ? [{ entry: value, all: all || matchesAll(value) }] : [];
};
/**
 * The one command of a hook entry: the entry itself when it is text, else the first of these keys
 * that has text. An entry's `type` is not read. `{ matcher: true }` when a step down has a
 * matcher: the hook never runs, however its commands are wrapped.
 */
const COMMAND_KEYS = ["command", "bash", "cmd", "shell", "powershell", "windows", "darwin", "macos", "linux"];
const commandFor = (entry, depth = 0) => {
  if (typeof entry === "string") return { command: entry };
  if (!entry || typeof entry !== "object" || depth > 20) return { command: null };
  if (hasMatcher(entry)) return { matcher: true };
  if (entry.hooks) return commandFor(entry.hooks, depth + 1);
  if (entry.commands) return commandFor(entry.commands, depth + 1);
  return { command: COMMAND_KEYS.map((key) => entry[key]).find((value) => typeof value === "string" && value.trim()) ?? null };
};

/** Why a thing is not run, one fixed sentence each: the person is told, not left to wonder. */
const WHY = {
  matcher: "Botkins runs no hook with a matcher.",
  event: "Botkins has no event with this name.",
  command: "This hook has no command.",
  spelling: "Another spelling of this event comes later in the file, and only that one runs.",
};
/** The plan keeps this many rows of what is not run, and counts the rest: a hooks file of a megabyte cannot make a plan of megabytes. */
export const PLAN_NOT_RUN_ROWS = 2_000;
/** The description shows this many rows of what is not run, and says how many there are. */
export const SHOWN_NOT_RUN_ROWS = 40;
/** A reason as one sentence: a capital letter first, a full stop last. */
const sentence = (reason) => reason.charAt(0).toUpperCase() + reason.slice(1) + ".";
const shortName = (name) => String(name).slice(0, LIMITS.name);

/**
 * Everything a plugin starts, from its files:
 *   manifestPath, manifest   the manifest that counts (manifest is null when it cannot be read)
 *   servers   [{ name, kind: "local", command, args, env, envNotSet, cwd } | { name, kind: "remote", type, url, headers, oauth }]
 *             `env` and `headers` are name → the value as written (it can hold ${SETTING}); `args` are all text;
 *             `envNotSet` lists each key of the plugin's `env` that Botkins does not set;
 *             `cwd` is null for the plugin's own folder, an absolute path as written, or a path below the plugin's own folder ("server/bin")
 *   hooks     [{ event, command, env, envNotSet, timeoutMs, newlyRun? }], in the order they run
 *             `newlyRun: true` marks a hook that an earlier Botkins did not run: a matcher of "*" or "", or the event spelled UserPromptSubmit or Stop
 *   notRun    [{ what: "hook" | "tool", name, why }] what the plugin has and Botkins does not run: a hook with a matcher, a hook for an event Botkins does not have,
 *             a hook with no command, the earlier of two spellings of one event, a tool with no command, a tool of a type or with an address that Botkins has not.
 *             `name` is the event or the tool as the plugin wrote it. A thing here is in neither list above.
 *             Only the first 2,000 rows are kept; `notRunCount` is how many there are.
 *   notRunCount   the number of things that are not run (at least `notRun.length`)
 *   refused   [{ what, name, why }] what cannot be shown whole (a command or value too long, a folder that leaves the plugin): such a thing is in neither list above.
 *             `why` is a sentence.
 * The runtime starts what is in `servers` and `hooks` and nothing more of a plugin.
 */
export function pluginStarts(read) {
  const { path: manifestPath, manifest } = firstManifest(read);
  const refused = [];
  const notRun = [];
  let notRunCount = 0;
  const addNotRun = (row) => {
    notRunCount++;
    if (notRun.length < PLAN_NOT_RUN_ROWS) notRun.push(row);
  };
  if (!manifest) return { manifestPath, manifest: null, servers: [], hooks: [], notRun, notRunCount, refused };
  const byName = new Map();
  for (const { name, config } of serverEntries(read, manifest)) {
    const plan = serverPlan(config);
    if (plan.notRun) {
      // What was started under this name before stays as it is: only this tool is not run.
      addNotRun({ what: "tool", name: shortName(name), why: plan.notRun });
      continue;
    }
    if (plan.refused || text(name, LIMITS.name) === null) {
      // Nothing runs under a name whose last word cannot be shown.
      byName.delete(name);
      refused.push({ what: "tool", name: shortName(name), why: sentence(plan.refused ?? "a tool's name is longer than " + LIMITS.name + " characters") });
    } else byName.set(name, { name, ...plan });
  }
  const byEvent = new Map();
  for (const [rawEvent, rawEntries] of Object.entries(hookSource(read, manifest))) {
    const event = canonicalEvent(rawEvent);
    const name = shortName(rawEvent);
    const seen = { matched: 0 };
    const entries = [];
    let found = false;
    let noCommand = false;
    for (const { entry, all } of flatten(rawEntries, seen)) {
      const { command, matcher } = commandFor(entry);
      if (matcher) {
        seen.matched++;
        continue;
      }
      if (typeof command !== "string" || !command.trim()) {
        noCommand = true;
        continue;
      }
      found = true;
      if (!event) continue;
      if (!text(command, LIMITS.hookCommand)) {
        refused.push({ what: "hook", name, why: sentence("a hook's command is longer than " + LIMITS.hookCommand + " characters") });
        continue;
      }
      const { env, envNotSet, refused: envRefused } = environmentOf(object(entry)?.env);
      if (envRefused) {
        refused.push({ what: "hook", name, why: sentence(envRefused) });
        continue;
      }
      const seconds = Number(object(entry)?.timeoutSec || 10);
      entries.push({ event, command, env, envNotSet, timeoutMs: Math.max(250, Math.min(30_000, (Number.isFinite(seconds) ? seconds : 10) * 1_000)), ...((all || isAlias(rawEvent)) && { newlyRun: true }) });
    }
    // One line for an event, not one for each of its entries.
    if (!event && (found || seen.matched)) addNotRun({ what: "hook", name, why: WHY.event });
    else if (event && seen.matched) addNotRun({ what: "hook", name, why: WHY.matcher });
    if (event && noCommand) addNotRun({ what: "hook", name, why: WHY.command });
    // The same event under two spellings: the later one is the one that runs, and the earlier is said not to.
    if (entries.length) {
      const earlier = byEvent.get(event);
      if (earlier) addNotRun({ what: "hook", name: earlier.name, why: WHY.spelling });
      byEvent.set(event, { name, entries });
    }
  }
  return { manifestPath, manifest, servers: [...byName.values()], hooks: [...byEvent.values()].flatMap((one) => one.entries), notRun, notRunCount, refused };
}

/** The names of a plugin's language servers, sorted. Nothing is started from them: Botkins skips a plugin's language servers, and the description only lists them. A file that is not JSON gives none. */
export function lspNames(read) {
  for (const file of LSP_FILES) {
    const source = read(file);
    if (source === null) continue;
    const data = parse(source);
    const servers = data && Object.hasOwn(data, "lspServers") ? object(data.lspServers) : data;
    return Object.keys(servers ?? {}).filter((name) => name.length <= LIMITS.name).sort().slice(0, 100);
  }
  return [];
}

const settingsIn = (value) => [...String(value).matchAll(PLACEHOLDER)].map((match) => match[1]).filter((key) => !BUILT_IN_VALUES.includes(key));

/** The words of a local tool's line, as the plan and the description have it: the command, then each argument. */
export const lineOf = (server) => [server.command, ...server.args];

const shownEnv = (env) => Object.entries(env).map(([name, value]) => ({ name, value }));

/**
 * The same, as a person is shown it (`contents.mcpServers` and `contents.hooks` of plugins-v1),
 * a command's words, its folder, and each environment name with its value as the plugin wrote it
 * (it can hold ${SETTING}; a secret is never there, it comes only from the settings). A tool on the web
 * is shown with its type, its address, each header with its written value, and its sign-in client's id.
 *   envNotSet   (only when not empty) the names the plugin asks for that Botkins does not set: [{ name, why }]
 *   newlyRun   true when a hook of the plan is one that an earlier Botkins did not run
 *   sentTo   setting → where its value goes: [{ tool, env } | { tool, header, url } | { hook, env }]
 *   notRun   (only when something is not run) { count, items }: `count` is how many things the plugin has that Botkins does not run (the plan's, then its `refused`),
 *            `items` the first 40 of them, each { what, name, why }
 */
export function describeStarts(starts) {
  const sentTo = new Map();
  const goes = (value, where) => {
    for (const key of settingsIn(value)) sentTo.set(key, [...(sentTo.get(key) ?? []), where]);
  };
  const mcpServers = starts.servers.map((server) => {
    if (server.kind === "local") {
      for (const [name, value] of Object.entries(server.env)) goes(value, { tool: server.name, env: name });
      return { name: server.name, kind: "local", command: server.command, args: [...server.args], env: shownEnv(server.env), ...(server.envNotSet?.length && { envNotSet: server.envNotSet.map(({ name, why }) => ({ name, why })) }), ...(server.cwd && { cwd: server.cwd }) };
    }
    for (const [name, value] of Object.entries(server.headers)) goes(value, { tool: server.name, header: name, url: server.url });
    return { name: server.name, kind: "remote", type: server.type, url: server.url, headers: shownEnv(server.headers), ...(server.oauth && { oauth: true }), ...(server.oauth?.clientId && { oauthClientId: server.oauth.clientId }) };
  });
  const hooks = starts.hooks.map((hook) => {
    for (const [name, value] of Object.entries(hook.env)) goes(value, { hook: hook.event, env: name });
    return { event: hook.event, command: hook.command, env: shownEnv(hook.env), ...(hook.envNotSet?.length && { envNotSet: hook.envNotSet.map(({ name, why }) => ({ name, why })) }), timeoutSec: hook.timeoutMs / 1_000 };
  });
  const rows = [...(starts.notRun ?? []), ...(starts.refused ?? [])];
  const count = Math.max(starts.notRunCount ?? 0, starts.notRun?.length ?? 0) + (starts.refused?.length ?? 0);
  const items = rows.slice(0, SHOWN_NOT_RUN_ROWS).map((item) => ({ what: item.what, name: item.name, why: item.why }));
  return { mcpServers, hooks, sentTo, newlyRun: starts.hooks.some((hook) => hook.newlyRun), ...(count > 0 && { notRun: { count, items } }) };
}

const START_WARNINGS = {
  hooks: "Runs a command on your computer through plugin hooks.",
  local: "Runs a local MCP server on your computer.",
  files: "A command runs with the plugin's own files. Botkins shows each command it starts, and cannot show all that those files make it do. Install a plugin only from a source you trust.",
  remote: "Connects to a remote MCP server.",
  envNotSet: "Botkins does not set some environment names that this plugin asks for. Its tools or hooks may not work.",
  notRun: "Botkins does not run some hooks or tools of this plugin.",
};
/** A description's warnings, with the sentences about what the plugin starts made again from its lists. `notRun` is the description's `{ count, items }` of what is not run, or a list of rows. */
export function startWarnings(mcpServers, hooks, others = [], notRun = []) {
  const somethingNotRun = Array.isArray(notRun) ? notRun.length > 0 : Number(notRun?.count) > 0 || Boolean(notRun?.items?.length);
  const local = mcpServers.some((server) => server.kind === "local");
  return [
    ...others.filter((line) => !Object.values(START_WARNINGS).includes(line)),
    ...(hooks.length ? [START_WARNINGS.hooks] : []),
    ...(local ? [START_WARNINGS.local] : []),
    ...(hooks.length || local ? [START_WARNINGS.files] : []),
    ...(mcpServers.some((server) => server.kind === "remote") ? [START_WARNINGS.remote] : []),
    ...([...mcpServers, ...hooks].some((item) => item.envNotSet?.length) ? [START_WARNINGS.envNotSet] : []),
    ...(somethingNotRun ? [START_WARNINGS.notRun] : []),
  ];
}

/**
 * What of a plugin runs on this computer: each hook's command, and each tool that is a local
 * program, with every word of its line, its folder and each environment value as written. A
 * plugin with any of these is shown to the person before it is installed, updated or turned on
 * (mobile/AGENTS.md: "A plugin that runs commands on the computer asks first").
 * It is made from the plugin's description and from nothing else. The description is what the
 * app starts (desktop/plugin-reading.mjs), so this list is too.
 */
export const pluginRuns = (contents) => [
  ...(contents?.hooks ?? []).map((hook) => ({ what: "hook", when: hook.event, command: hook.command, env: hook.env ?? [], ...(hook.envNotSet?.length && { envNotSet: hook.envNotSet }), ...(hook.timeoutSec !== undefined && { timeoutSec: hook.timeoutSec }) })),
  ...(contents?.mcpServers ?? []).filter((server) => server.kind === "local").map((server) => ({ what: "tool", name: server.name, command: server.command, args: server.args ?? [], env: server.env ?? [], ...(server.envNotSet?.length && { envNotSet: server.envNotSet }), ...(server.cwd && { cwd: server.cwd }) })),
];
/**
 * The mark of a description that this reading made: every command that Botkins starts is in it,
 * whole. An older app cannot make it, so a description without it is not to be trusted to say
 * all that a plugin starts.
 */
export const STARTS = 1;

const CONFIG_NAMES = new Set([".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", "package.json", "package-lock.json", "bunfig.toml", "deno.json", "makefile", "gnumakefile", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pipfile", ".python-version", ".tool-versions", ".nvmrc", ".node-version", "gemfile", ".ruby-version", "go.mod", "cargo.toml", ".env", ".envrc", ".gitconfig", ".gitattributes", "tsconfig.json", ".babelrc", "composer.json", "php.ini", "uv.toml", ".pnp.cjs", "pyvenv.cfg", "conftest.py", "pytest.ini", "mise.toml", "deno.jsonc"]);
/** Folders that hold a program's dependencies or settings. Each is listed as one row, whatever is below it. `.cargo/config.toml` is marked by this list. */
const CONFIG_FOLDERS = new Set(["node_modules", ".venv", "venv", "vendor", ".bundle", ".mvn", ".cargo"]);
/**
 * True for a file that a tool reads by itself when a command runs in this folder (npm reads
 * `.npmrc`, make reads `Makefile`, python reads `pyproject.toml`, node reads `node_modules`). A
 * command shown as `npm test` does what such a file says, so the description marks these files.
 * `path` has "/" between its parts.
 */
export function configFile(path) {
  const parts = String(path).toLowerCase().split("/");
  return CONFIG_NAMES.has(parts.at(-1)) || parts.some((part) => CONFIG_FOLDERS.has(part));
}

/**
 * The path up to and including the top-most folder of dependencies or settings that a file is
 * below (`a/node_modules/`), or null. The file's own name is not a folder. `path` has "/" between
 * its parts. The description lists such a folder as one row, so that its files cannot crowd out
 * the other files.
 */
export function dependencyFolder(path) {
  const parts = String(path).split("/");
  const at = parts.slice(0, -1).findIndex((part) => CONFIG_FOLDERS.has(part.toLowerCase()));
  return at < 0 ? null : parts.slice(0, at + 1).join("/") + "/";
}

/**
 * Which of a plugin's files go on to the runtime, in the folder that Botkins writes for a
 * session (desktop/plugin-runtime.mjs, `project`). The description's lists of skills, agents and
 * commands are these files and no others, and the folder holds these files and no others.
 *   - only below `skills/`, `agents/` and `commands/`;
 *   - no part of the path starts with "." or is `node_modules`;
 *   - at most ten parts (the top folder, eight folders below it, the file);
 *   - at most 1,000,000 bytes;
 *   - below `agents/`, only a Markdown file (`.md`).
 * `path` is a path of the plugin with "/" between its parts; `bytes` is the file's size.
 */
export function handedOn(path, bytes) {
  const parts = String(path).split("/");
  if (parts.length < 2 || parts.length > 10 || !["skills", "agents", "commands"].includes(parts[0])) return false;
  if (parts.some((part) => !part || part.startsWith(".") || part === "node_modules")) return false;
  if (!(Number(bytes) <= 1_000_000)) return false;
  return parts[0] !== "agents" || /\.md$/i.test(parts.at(-1));
}
