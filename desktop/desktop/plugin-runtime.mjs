// The host side of plugins-v1. A plugin folder is untrusted input: its skills, agents and
// commands are projected into a manifest-free (except for a small safe manifest) directory while
// its MCP files and hooks are read by Botkins. This keeps the Copilot runtime from discovering and
// running the same file hook a second time.
//
// What a plugin starts is not read here. `pluginStarts` (desktop/plugin-reading.mjs) reads the
// plugin's files, and the description a person agreed to comes from the same call. This file
// gives each thing its values and starts it. A program or a hook that is not in that answer is
// never started from here.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_VALUES, EVENTS, folderReader, handedOn, PLACEHOLDER, pluginStarts, RESERVED } from "./plugin-reading.mjs";
import { shownText } from "./shown-text.mjs";

const MAX_HOOK_OUTPUT = 256_000;
const MAX_CONTEXT = 12_000;
const MAX_PROMPT = 100_000;
/** A secret shorter than this would match a word of a command by accident, so it is not looked for there. */
export const MIN_SECRET_LENGTH = 4;
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)/i;
/** The one rule for "this setting is secret": the catalog says so, or its name sounds like one. The runtime and the manager both ask here. */
export const secretField = (field) => field?.secret === true || field?.sensitive === true || SECRET_NAME.test(String(field?.key ?? ""));
const MCP_LAUNCHER = fileURLToPath(new URL("./plugin-mcp-launcher.mjs", import.meta.url));

const text = (value, max) => (typeof value === "string" && value.length <= max && !value.includes("\0") ? value : null);
const safeId = (value, fallback = "plugin") => {
  const id = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return !id || id === "." || id === ".." ? fallback : id;
};
const inside = (base, path) => path === base || path.startsWith(base + "/") || path.startsWith(base + "\\");

/** The stable SDK key for one plugin MCP server. */
export function pluginServerName(id, name) {
  const hash = createHash("sha256").update(String(id ?? "") + "\0" + String(name ?? "")).digest("hex").slice(0, 10);
  return "plugin_" + safeId(id, "plugin") + "__" + safeId(name, "server") + "_" + hash;
}

/** The tools of a plugin that sign in through a browser, for the manager. No values are read. */
export function pluginOAuthServers(plugin) {
  const folder = typeof plugin?.folder === "string" ? plugin.folder : "";
  if (!folder) return [];
  return pluginStarts(folderReader(folder))
    .servers.filter((server) => server.kind === "remote" && server.oauth)
    .map((server) => ({ name: pluginServerName(plugin.id, server.name), url: server.url, ...(server.oauth.clientId && { clientId: server.oauth.clientId }), manifestName: server.name }));
}

function configEntries(plugin, manifest) {
  const config = plugin?.config;
  const out = [];
  if (Array.isArray(config)) {
    for (const item of config) if (item && typeof item === "object") {
      const key = text(item.key ?? item.name, 200)?.trim();
      if (key) out.push({ ...item, key });
    }
  } else if (config && typeof config === "object") {
    for (const [key, item] of Object.entries(config)) out.push({ ...(item && typeof item === "object" ? item : {}), key });
  }
  const declared = manifest?.userConfig ?? manifest?.settings;
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    for (const [key, item] of Object.entries(declared)) {
      if (!out.some((field) => field.key === key)) out.push({ ...(item && typeof item === "object" ? item : {}), key });
    }
  }
  return out;
}

function approvedSettings(plugin, manifest) {
  const values = plugin?.values && typeof plugin.values === "object" && !Array.isArray(plugin.values) ? plugin.values : {};
  const settings = {};
  const secrets = [];
  const secretValues = [];
  for (const value of Object.values(values)) if (typeof value === "string" && value.length <= 8_000 && !value.includes("\0") && value) secrets.push(value);
  for (const field of configEntries(plugin, manifest)) {
    const key = field.key;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || RESERVED.has(key)) continue;
    if (field.set === false || field.approved === false || field.enabled === false || field.configured === false) continue;
    const secret = secretField(field);
    let value = values[key];
    if (typeof value !== "string" && !secret && typeof field.value === "string") value = field.value;
    if (typeof value !== "string" && !secret && typeof field.default === "string") value = field.default;
    if (typeof value !== "string" || value.length > 8_000 || value.includes("\0")) continue;
    settings[key] = value;
    // Supplied values can be saved credentials even when a catalog omitted sensitive metadata.
    // They are all redacted from hook output; only approved fields are made available to a hook.
    // A tool is held back only for a value of a secret field: a plain default such as 8080 or true is no reason.
    // (A secret shorter than 4 characters would match a word by accident, so it is not in that list.)
    if (secret && value.length >= MIN_SECRET_LENGTH) secretValues.push(value);
  }
  const longestFirst = (list) => [...new Set(list)].sort((a, b) => b.length - a.length);
  return { settings, secrets: longestFirst(secrets), secretValues: longestFirst(secretValues) };
}

const redactText = (value, secrets) => {
  let result = String(value);
  for (const secret of secrets) if (secret.length > 0) result = result.split(secret).join("[redacted]");
  return result;
};
function redactValue(value, secrets, depth = 0) {
  if (typeof value === "string") return redactText(value, secrets);
  if (depth > 6 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactValue(item, secrets, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key.slice(0, 200), redactValue(item, secrets, depth + 1)]));
}
const shorten = (value, max) => (typeof value === "string" ? value.slice(0, max) : value);

function valuesFor(plugin, manifest, context, projection, settings) {
  // Projection directories are rebuilt when a session opens. Durable plugin data must not live
  // underneath one of them or a refresh would silently delete a hook's state.
  // Installation identity, not the materialized revision path, owns durable plugin data. Updating
  // a plugin must preserve its memory and settings state.
  const digest = createHash("sha256").update(String(plugin.id ?? "")).digest("hex").slice(0, 16);
  const data = join(context.dir, ".botkins-plugin-data", safeId(plugin.id) + "-" + digest);
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const builtins = {
    PLUGIN_ROOT: plugin.folder,
    PLUGIN_DATA: data,
    CLAUDE_PLUGIN_ROOT: plugin.folder,
    CLAUDE_PLUGIN_DATA: data,
    BOTKINS_DIR: context.dir,
    BOTKINS_CHAT_ID: context.chatId,
    BOTKINS_BOT_ID: context.botId,
  };
  // (The names here are BUILT_IN_VALUES: the description tells a setting from one of these by that list.)
  for (const name of BUILT_IN_VALUES) if (!Object.hasOwn(builtins, name)) throw new Error("A built-in value has no value: " + name);
  const expand = (value) => String(value).replace(PLACEHOLDER, (_match, key) => builtins[key] ?? settings[key] ?? "${" + key + "}");
  return { builtins, expand };
}

const safePath = () => {
  const dirs = [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
};

/** A hook's environment: a short PATH, Botkins' own values, and the names the reading says this hook sets. */
function hookEnvironment(expand, builtins, declared) {
  // (A hook runs in the installed copy. Python would write its cache there, and the copy must stay the reviewed files.)
  const environment = { PATH: safePath(), PYTHONDONTWRITEBYTECODE: "1", ...builtins };
  for (const [key, value] of Object.entries(declared)) environment[key] = expand(value);
  return environment;
}

function parseHookOutput(raw, event, secrets) {
  if (typeof raw !== "string" || raw.length > MAX_HOOK_OUTPUT) return null;
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  let parsed;
  try {
    parsed = JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const safe = {};
  const addString = (key, max) => {
    if (typeof parsed[key] === "string") safe[key] = redactText(parsed[key].slice(0, max), secrets);
  };
  addString("additionalContext", MAX_CONTEXT);
  if (event === "userPromptSubmitted") {
    addString("modifiedPrompt", MAX_PROMPT);
    addString("reason", 2_000);
    if (parsed.decision === "block") safe.decision = "block";
  } else if (event === "preToolUse") {
    // An installed plugin may deny or ask, but never silently grant a permission Botkins did not grant.
    if (parsed.permissionDecision === "deny" || parsed.permissionDecision === "ask") safe.permissionDecision = parsed.permissionDecision;
    addString("permissionDecisionReason", 2_000);
    if (Object.hasOwn(parsed, "modifiedArgs")) safe.modifiedArgs = redactValue(parsed.modifiedArgs, secrets);
  } else if (event === "postToolUse") {
    if (Object.hasOwn(parsed, "modifiedResult")) safe.modifiedResult = redactValue(parsed.modifiedResult, secrets);
  } else if (event === "errorOccurred") {
    if (["retry", "skip", "abort"].includes(parsed.errorHandling)) safe.errorHandling = parsed.errorHandling;
    if (Number.isFinite(parsed.retryCount)) safe.retryCount = Math.max(0, Math.min(2, Math.floor(parsed.retryCount)));
    addString("userNotification", 2_000);
  } else if (event === "agentStop") {
    if (parsed.decision === "block") safe.decision = "block";
    addString("reason", 2_000);
  } else if (event === "subagentStop") addString("modifiedResponse", MAX_CONTEXT);
  else if (event === "sessionEnd") {
    addString("sessionSummary", MAX_CONTEXT);
    if (Array.isArray(parsed.cleanupActions)) safe.cleanupActions = parsed.cleanupActions.slice(0, 20).filter((item) => typeof item === "string").map((item) => redactText(item.slice(0, 500), secrets));
  }
  return safe;
}

function mergeHookOutput(event, current, output) {
  if (!output) return current;
  const next = { ...current };
  if (output.additionalContext) next.additionalContext = shorten([next.additionalContext, output.additionalContext].filter(Boolean).join("\n\n"), MAX_CONTEXT);
  for (const key of ["modifiedPrompt", "modifiedArgs", "modifiedResult", "permissionDecisionReason", "errorHandling", "retryCount", "userNotification", "sessionSummary", "cleanupActions"]) {
    if (Object.hasOwn(output, key)) next[key] = output[key];
  }
  if (output.permissionDecision === "deny" || (output.permissionDecision === "ask" && next.permissionDecision !== "deny")) next.permissionDecision = output.permissionDecision;
  if (output.decision === "block") next.decision = "block";
  if (output.reason) next.reason = output.reason;
  if (output.modifiedResponse) next.modifiedResponse = output.modifiedResponse;
  return next;
}

function runHook(command, input, options) {
  return new Promise((resolve) => {
    const { timeoutMs } = options;
    const child = spawn(command, { cwd: options.cwd, env: options.env, shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let done = false;
    const finish = (value = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      if (output.length < MAX_HOOK_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_HOOK_OUTPUT - output.length);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? output : null));
    // A hook need not read what it is sent. One that ends first closes its input, and the write then fails (EPIPE).
    // That is no fault of the hook: its answer still counts. With no listener here, that failure would stop the app.
    child.stdin.on("error", () => {});
    // What a hook writes to its error output is not kept, but it is read, so that a hook that writes much there is not held up.
    child.stderr.resume();
    try {
      child.stdin.end(JSON.stringify(input));
    } catch {
      finish(null);
    }
  });
}

/**
 * How many times in a row one plugin's hook may stop a turn from ending. A hook for the end of a
 * turn (`agentStop`) can answer "block", and the runtime then starts one more turn of the model,
 * and asks the hook again at the end of that one. The runtime itself did not end such a chain in
 * a run of six, and each turn is paid for by the person. A hook that checks the bot's work ("run
 * the tests before you stop") needs to send it back a few times. One that sent it back three
 * times and is still not content will not be content the fourth time. After this many, a block
 * from that plugin is not passed on, and the turn's activity says so.
 */
export const STOP_BLOCKS = 3;

/**
 * How many times in a row all plugins together may stop one turn from ending. Two plugins that
 * each use their three are six; more than that is a turn that does not end, at the person's
 * cost. It is counted for the whole turn: only the app's start of the next turn resets it
 * (`turnStarted` of the manager), not the runtime's word `stopHookActive`.
 */
export const TURN_STOP_BLOCKS = 6;

/** The count of blocks of one chat's turn. The caller keeps it, so a session that is opened again in the middle of a turn goes on with it. */
export const newStops = () => ({ plugins: new Map(), total: 0, toldTotal: false });

/** The handlers for a plugin's hooks. `hooks` is the reading's list: what is in it runs, in that order, and nothing else. */
function makeHandlers(plugin, context, hooks, { builtins, expand }, secrets, run) {
  const handlers = {};
  // The blocks of this plugin's hook in the chain that is open now, and whether the person was told. They are kept
  // in the object of the turn (`context.stops`), not here: this function runs again when the session is opened again.
  // (The count is looked up at each end of a turn: the app clears it when a new turn starts, and a warm session goes on.)
  const stops = context.stops;
  const own = () => {
    if (!stops.plugins.has(plugin.id)) stops.plugins.set(plugin.id, { blocks: 0, told: false });
    return stops.plugins.get(plugin.id);
  };
  const byEvent = new Map();
  for (const hook of hooks) byEvent.set(hook.event, [...(byEvent.get(hook.event) ?? []), hook]);
  for (const [event, entries] of byEvent) {
    handlers[EVENTS[event]] = async (input = {}) => {
      let combined = {};
      let currentInput = {
        ...(input && typeof input === "object" ? input : {}),
        ...(context.chatId && !Object.hasOwn(input, "chatId") && { chatId: context.chatId }),
        ...(context.botId && !Object.hasOwn(input, "botId") && { botId: context.botId }),
      };
      for (const hook of entries) {
        // The installed copy is looked at again before each hook: a hook starts minutes after the session opened.
        if (plugin.intact?.() === false) break;
        // Built-ins are present in the child environment. Leave their shell placeholders intact
        // so a reviewed command can quote them correctly when paths contain spaces or metacharacters.
        const output = await run(hook.command, currentInput, { cwd: plugin.folder, env: hookEnvironment(expand, builtins, hook.env), timeoutMs: hook.timeoutMs });
        const parsed = parseHookOutput(output, event, secrets);
        combined = mergeHookOutput(event, combined, parsed);
        if (parsed?.modifiedPrompt) currentInput = { ...currentInput, prompt: parsed.modifiedPrompt };
        if (parsed?.modifiedArgs) currentInput = { ...currentInput, toolArgs: parsed.modifiedArgs, arguments: parsed.modifiedArgs };
      }
      if (event === "agentStop") {
        const stop = own();
        // The runtime says whether this end of a turn follows a block (`stopHookActive`). A first end starts a new
        // count for this plugin. Without that word the count of the plugin goes on until the app starts the next turn.
        // (The count for the turn as a whole is never started again here.)
        if (input?.stopHookActive === false) Object.assign(stop, { blocks: 0, told: false });
        if (combined.decision === "block") {
          // The plugin's own limit is asked first: it names the plugin. The turn's limit stops a plugin that is still within its own.
          if (stop.blocks >= STOP_BLOCKS) {
            delete combined.decision;
            delete combined.reason;
            if (!stop.told) context.note?.("The plugin " + shownText(String(plugin.id)).slice(0, 80) + " kept this turn going " + STOP_BLOCKS + " times. Botkins did not let it do that again.");
            stop.told = true;
          } else if (stops.total >= TURN_STOP_BLOCKS) {
            delete combined.decision;
            delete combined.reason;
            if (!stops.toldTotal) context.note?.("Plugins kept this turn going " + TURN_STOP_BLOCKS + " times. Botkins did not let them do that again.");
            stops.toldTotal = true;
          } else {
            stop.blocks++;
            stops.total++;
          }
        }
      }
      return Object.keys(combined).length ? combined : undefined;
    };
  }
  return handlers;
}

/**
 * The header of an agent, a skill or a command file (its front matter) as Botkins hands it on.
 * The runtime reads that header by itself, and a header can carry more than anybody was shown:
 * `mcp-servers` and `hooks` start things, and `allowed-tools` can let a skill use the shell with
 * no question. So the header is written again from a short list of keys for each kind, and
 * nothing else gets through. The text below the header stays as it is.
 * The new header is the first thing in the file whatever the old one looked like. A header that
 * this code reads in another way than the runtime does can therefore not get through: the
 * runtime sees the new one.
 * A key that only holds a thing back is kept when it says `true` or `false`. Dropping it would
 * let the thing do more, so a value that cannot be read falls to the side that holds back.
 */
const HEADER_KEYS = {
  agent: ["name", "description", "model", "tools", "disable-model-invocation", "user-invocable", "infer"],
  skill: ["name", "description", "disable-model-invocation", "user-invocable"],
  command: ["name", "description", "argument-hint", "disable-model-invocation"],
};
/** The keys that hold a thing back, each with the value that holds it back most. */
const HOLDING_BACK = { "disable-model-invocation": true, "user-invocable": false, infer: false };
const HEADER_ORDER = ["name", "description", "model", "tools", "argument-hint", "disable-model-invocation", "user-invocable", "infer"];

export function plainHeaderFile(source, kind) {
  const allowed = HEADER_KEYS[kind];
  if (!allowed) throw new Error("Unknown file kind: " + kind);
  const whole = String(source).replace(/^\uFEFF/, "");
  // A header after blank space is still a header (the runtime may read it as one), so it is replaced too, not left as text below the new one.
  const bare = whole.trimStart();
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(bare);
  const lines = match ? match[1].split(/\r?\n/) : [];
  const body = match ? bare.slice(match[0].length) : whole;
  const scalar = (value) => {
    const word = value.trim();
    if (/^"[\s\S]*"$/.test(word)) {
      try {
        return String(JSON.parse(word));
      } catch {}
    }
    if (/^'[\s\S]*'$/.test(word)) return word.slice(1, -1).replaceAll("''", "'");
    return word.replace(/[ \t]+#.*$/, "");
  };
  const keyLine = new RegExp("^(" + allowed.join("|") + ")[ \\t]*:[ \\t]*(.*)$");
  const fields = {};
  for (let index = 0; index < lines.length; index++) {
    const found = keyLine.exec(lines[index]);
    if (!found || Object.hasOwn(fields, found[1])) continue;
    const [, key, rest] = found;
    const more = [];
    while (index + 1 < lines.length && /^(?:[ \t]|-[ \t]|[ \t]*$)/.test(lines[index + 1])) more.push(lines[++index].trim());
    const below = more.filter(Boolean);
    if (key === "tools") {
      const items = /^\[[\s\S]*\]$/.test(rest.trim()) ? rest.trim().slice(1, -1).split(",") : rest.trim() ? rest.split(",") : below.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
      fields.tools = items.map(scalar).filter((name) => /^[A-Za-z0-9_.\/*:@ -]{1,200}$/.test(name)).slice(0, 200);
    } else if (Object.hasOwn(HOLDING_BACK, key)) {
      const word = scalar(rest).toLowerCase();
      fields[key] = word === "true" ? true : word === "false" ? false : HOLDING_BACK[key];
    } else {
      const value = /^[>|][+-]?$/.test(rest.trim()) ? below.join(rest.trim().startsWith("|") ? "\n" : " ") : [scalar(rest), ...(rest.trim() ? below : [])].join(" ");
      fields[key] = value.replaceAll("\0", "").slice(0, key === "description" ? 2_000 : 200);
    }
  }
  const header = HEADER_ORDER.filter((key) => allowed.includes(key))
    // (`tools` holds an agent back too: when the key is there, it is written, also when no name in it could be read. An empty list is no tool.)
    .filter((key) => (key === "description" ? true : typeof fields[key] === "boolean" || Array.isArray(fields[key]) ? true : fields[key]))
    .map((key) => key + ": " + (typeof fields[key] === "boolean" ? String(fields[key]) : JSON.stringify(fields[key] ?? "")));
  return "---\n" + header.join("\n") + "\n---\n" + body;
}

/** An agent file as Botkins hands it on (see `plainHeaderFile`). */
export const plainAgentFile = (source) => plainHeaderFile(source, "agent");

/** Which kind of header a file below skills/, agents/ or commands/ has, or null when it is copied as it is. */
function headerKind(parts, text) {
  const name = parts.at(-1);
  if (parts[0] === "agents") return "agent";
  if (parts[0] === "skills") {
    // (A disk that does not tell "skill.md" from "SKILL.md" would give the runtime this file too.)
    if (/^skill\.md$/i.test(name)) return "skill";
    // Another Markdown file of a skill is a paper that the skill reads. It has no header, and is copied as it is.
    // One that starts with a header all the same gets the skill's rule: nobody knows that the runtime never reads it as a skill.
    // (The whole text is looked at: blank space of any length can come before the header.)
    return /\.md$/i.test(name) && text.replace(/^\uFEFF/, "").trimStart().startsWith("---") ? "skill" : null;
  }
  return /\.md$/i.test(name) ? "command" : null;
}

/**
 * Writes the session's folder: the files of the plugin that `handedOn` (desktop/plugin-reading.mjs)
 * says go on, and no others. A link is never followed or copied. Nothing is counted here: the
 * rule has its own limits, and the catalog refuses a plugin with too many files or too many bytes.
 */
function copyPlainTree(source, destination) {
  const walk = (parts) => {
    const from = join(source, ...parts);
    let entries;
    try {
      entries = readdirSync(from);
    } catch {
      return;
    }
    for (const name of entries) {
      const next = [...parts, name];
      const fromPath = join(from, name);
      let info;
      try {
        info = lstatSync(fromPath);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        // A folder is entered only when a file in it could go on (not a dot folder, not too deep).
        if (handedOn([...next, "x.md"].join("/"), 0)) walk(next);
      } else if (info.isFile() && handedOn(next.join("/"), info.size)) {
        try {
          const bytes = readFileSync(fromPath);
          // The size is checked again on the bytes that were read: a file can grow after the first look.
          if (!handedOn(next.join("/"), bytes.length)) continue;
          const whole = bytes.toString("utf8");
          const kind = headerKind(next, whole);
          const toPath = join(destination, ...next);
          mkdirSync(dirname(toPath), { recursive: true });
          // (A skill's script keeps the right to be run, as in the copy.)
          writeFileSync(toPath, kind ? plainHeaderFile(whole, kind) : bytes, { mode: info.mode & 0o111 ? 0o755 : 0o644 });
        } catch {
          // A file that changed or disappeared during projection is omitted.
        }
      }
    }
  };
  for (const name of ["skills", "agents", "commands"]) {
    // The folder itself must be a real folder too: a link there is not followed.
    let top;
    try {
      top = lstatSync(join(source, name));
    } catch {
      continue;
    }
    if (top.isDirectory()) walk([name]);
  }
}

function project(plugin, context, manifest) {
  const root = join(context.dir, ".botkins-plugin-runtime", safeId(context.chatId, "session"));
  const digest = createHash("sha256").update(String(plugin.id ?? "") + "\0" + plugin.folder).digest("hex").slice(0, 10);
  const destination = join(root, safeId(plugin.id) + "-" + digest);
  if (destination !== root && inside(root, destination)) rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  copyPlainTree(plugin.folder, destination);
  writeFileSync(
    join(destination, "plugin.json"),
    JSON.stringify({
      name: safeId(plugin.id),
      ...(typeof manifest.version === "string" && { version: manifest.version.slice(0, 100) }),
      ...(typeof manifest.description === "string" && { description: manifest.description.slice(0, 600) }),
    }),
    { mode: 0o600 },
  );
  return destination;
}

/**
 * Where a local tool runs: the plugin's own folder when the plan names none, a path as written
 * when it is absolute, else a path below the plugin's folder (the reading gives it with no "..").
 */
function workingFolder(plugin, cwd) {
  if (cwd === null || cwd === undefined || cwd === "") return plugin.folder;
  if (isAbsolute(cwd) || /^[A-Za-z]:[\\/]/.test(cwd)) return cwd;
  return join(plugin.folder, cwd);
}

/** One tool of the reading, with its values, as the SDK takes it. Null when a word of its line holds the value of a secret setting. */
function serverConfig(plugin, { builtins, expand }, secretValues, server) {
  if (server.kind === "local") {
    const { command, args } = server;
    // Settings never become command-line arguments, executable paths or working directories.
    // A local credential must never become part of the launcher argv, even encoded in its
    // reviewed command spec. Literal values that match a secret setting's value therefore fail closed.
    if ([command, ...args].some((part) => secretValues.some((secret) => part.includes(secret)))) return null;
    const env = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)]));
    // Every local tool gets its plugin's data folder, as a hook does. The plugin cannot set these
    // names (they are reserved), so what is put here after its own values is Botkins' value.
    env.PLUGIN_DATA = builtins.PLUGIN_DATA;
    env.CLAUDE_PLUGIN_DATA = builtins.CLAUDE_PLUGIN_DATA;
    const launcherSpec = Buffer.from(JSON.stringify({ command, args, envKeys: Object.keys(env) })).toString("base64url");
    const launcherEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
    return { type: "stdio", command: process.execPath, args: [MCP_LAUNCHER, launcherSpec], env: launcherEnv, workingDirectory: workingFolder(plugin, server.cwd), tools: ["*"] };
  }
  // A setting in a URL would become an accidental credential-bearing destination. URLs are
  // catalog metadata and stay literal; only headers receive approved values.
  return { type: server.type, url: server.url, headers: Object.fromEntries(Object.entries(server.headers).map(([key, value]) => [key, expand(value)])), tools: ["*"] };
}

function eligible(plugin, context) {
  if (!plugin || typeof plugin.folder !== "string" || !existsSync(plugin.folder)) return false;
  try {
    if (!lstatSync(plugin.folder).isDirectory()) return false;
  } catch {
    return false;
  }
  if (plugin.enabled === false || (plugin.status && plugin.status !== "ready")) return false;
  if (plugin.bots && plugin.bots !== "all" && (!Array.isArray(plugin.bots) || !plugin.bots.includes(context.botId))) return false;
  if (plugin.botIds && (!Array.isArray(plugin.botIds) || !plugin.botIds.includes(context.botId))) return false;
  return true;
}

/**
 * Builds one Copilot session's plugin inputs. `values` are intentionally consumed here only;
 * they are never returned as directories, hook input, or SDK system text.
 */
export function pluginSession(plugins, context = {}, { run = runHook } = {}) {
  const dir = typeof context.dir === "string" && context.dir ? context.dir : process.cwd();
  mkdirSync(dir, { recursive: true });
  const safeContext = {
    dir,
    chatId: text(String(context.chatId ?? ""), 200) ?? "",
    botId: text(String(context.botId ?? ""), 200) ?? "",
    // One line for the turn's activity, when Botkins itself stops something of a plugin.
    note: typeof context.note === "function" ? context.note : null,
    // The count of blocks of this chat's turn. The manager keeps one for each chat; with none, this session has its own.
    stops: context.stops?.plugins instanceof Map && Number.isFinite(context.stops.total) ? context.stops : newStops(),
  };
  const directories = [];
  const mcpServers = {};
  const handlerLists = {};
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    if (!eligible(plugin, safeContext)) continue;
    // One reading of the plugin's files says what it starts (desktop/plugin-reading.mjs).
    const starts = pluginStarts(folderReader(plugin.folder));
    const manifest = starts.manifest ?? {};
    const projection = project(plugin, safeContext, manifest);
    directories.push(projection);
    if (context.skillsOnly === true) continue;
    const { settings, secrets, secretValues } = approvedSettings(plugin, manifest);
    const values = valuesFor(plugin, manifest, safeContext, projection, settings);
    for (const planned of starts.servers) {
      const server = serverConfig(plugin, values, secretValues, planned);
      if (server) mcpServers[pluginServerName(plugin.id, planned.name)] = server;
    }
    const handlers = makeHandlers(plugin, safeContext, starts.hooks, values, secrets, run);
    for (const [name, handler] of Object.entries(handlers)) (handlerLists[name] ??= []).push(handler);
  }
  const handlers = {};
  for (const [name, list] of Object.entries(handlerLists)) {
    handlers[name] = async (input, invocation) => {
      let merged = {};
      for (const handler of list) merged = mergeHookOutput(name === "onUserPromptSubmitted" ? "userPromptSubmitted" : "", merged, await handler(input, invocation));
      return Object.keys(merged).length ? merged : undefined;
    };
  }
  return { directories, mcpServers, hooks: { handlers } };
}
