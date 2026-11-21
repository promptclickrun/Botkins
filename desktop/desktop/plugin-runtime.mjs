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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILT_IN_VALUES, EVENTS, folderReader, PLACEHOLDER, pluginStarts, RESERVED } from "./plugin-reading.mjs";

const MAX_HOOK_OUTPUT = 256_000;
const MAX_CONTEXT = 12_000;
const MAX_PROMPT = 100_000;
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_PLUGIN_BYTES = 8_000_000;
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)/i;
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
  for (const value of Object.values(values)) if (typeof value === "string" && value.length <= 8_000 && !value.includes("\0") && value) secrets.push(value);
  for (const field of configEntries(plugin, manifest)) {
    const key = field.key;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || RESERVED.has(key)) continue;
    if (field.set === false || field.approved === false || field.enabled === false || field.configured === false) continue;
    const secret = field.secret === true || field.sensitive === true || SECRET_NAME.test(key);
    let value = values[key];
    if (typeof value !== "string" && !secret && typeof field.value === "string") value = field.value;
    if (typeof value !== "string" && !secret && typeof field.default === "string") value = field.default;
    if (typeof value !== "string" || value.length > 8_000 || value.includes("\0")) continue;
    settings[key] = value;
    // Supplied values can be saved credentials even when a catalog omitted sensitive metadata.
    // They are all redacted from hook output; only approved fields are made available to a hook.
  }
  return { settings, secrets: [...new Set(secrets)].sort((a, b) => b.length - a.length) };
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
    try {
      child.stdin.end(JSON.stringify(input));
    } catch {
      finish(null);
    }
  });
}

/** The handlers for a plugin's hooks. `hooks` is the reading's list: what is in it runs, in that order, and nothing else. */
function makeHandlers(plugin, context, hooks, { builtins, expand }, secrets, run) {
  const handlers = {};
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
        // Built-ins are present in the child environment. Leave their shell placeholders intact
        // so a reviewed command can quote them correctly when paths contain spaces or metacharacters.
        const output = await run(hook.command, currentInput, { cwd: plugin.folder, env: hookEnvironment(expand, builtins, hook.env), timeoutMs: hook.timeoutMs });
        const parsed = parseHookOutput(output, event, secrets);
        combined = mergeHookOutput(event, combined, parsed);
        if (parsed?.modifiedPrompt) currentInput = { ...currentInput, prompt: parsed.modifiedPrompt };
        if (parsed?.modifiedArgs) currentInput = { ...currentInput, toolArgs: parsed.modifiedArgs, arguments: parsed.modifiedArgs };
      }
      return Object.keys(combined).length ? combined : undefined;
    };
  }
  return handlers;
}

/**
 * An agent file as Botkins hands it on. The runtime reads the header of an agent file (its front
 * matter), and a header can name tools to start (`mcp-servers`) and hooks of its own. Nobody was
 * shown those, so they do not get there: the header is written again, with the agent's name,
 * its description, its model and the names of the tools it may use, and nothing else. The text
 * below the header stays as it is.
 * The new header is the first thing in the file whatever the old one looked like. A header that
 * this code reads in another way than the runtime does can therefore not get through: the
 * runtime sees the new one.
 */
export function plainAgentFile(source) {
  const whole = String(source).replace(/^\uFEFF/, "");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(whole);
  const lines = match ? match[1].split(/\r?\n/) : [];
  const body = match ? whole.slice(match[0].length) : whole;
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
  const fields = {};
  for (let index = 0; index < lines.length; index++) {
    const found = /^(name|description|model|tools)[ \t]*:[ \t]*(.*)$/.exec(lines[index]);
    if (!found || Object.hasOwn(fields, found[1])) continue;
    const [, key, rest] = found;
    const more = [];
    while (index + 1 < lines.length && /^(?:[ \t]|-[ \t]|[ \t]*$)/.test(lines[index + 1])) more.push(lines[++index].trim());
    const below = more.filter(Boolean);
    if (key === "tools") {
      const items = /^\[[\s\S]*\]$/.test(rest.trim()) ? rest.trim().slice(1, -1).split(",") : rest.trim() ? rest.split(",") : below.filter((line) => line.startsWith("-")).map((line) => line.slice(1));
      fields.tools = items.map(scalar).filter((name) => /^[A-Za-z0-9_.\/*:@ -]{1,200}$/.test(name)).slice(0, 200);
    } else {
      const value = /^[>|][+-]?$/.test(rest.trim()) ? below.join(rest.trim().startsWith("|") ? "\n" : " ") : [scalar(rest), ...(rest.trim() ? below : [])].join(" ");
      fields[key] = value.replaceAll("\0", "").slice(0, key === "description" ? 2_000 : 200);
    }
  }
  const header = ["name", "description", "model", "tools"].filter((key) => (key === "description" ? true : Array.isArray(fields[key]) ? fields[key].length : fields[key])).map((key) => key + ": " + JSON.stringify(fields[key] ?? ""));
  return "---\n" + header.join("\n") + "\n---\n" + body;
}

function copyPlainTree(source, destination) {
  let files = 0;
  let bytes = 0;
  const walk = (from, to, depth, agents = false) => {
    if (depth > 8 || files >= MAX_FILES || bytes >= MAX_PLUGIN_BYTES) return;
    let entries;
    try {
      entries = readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= MAX_FILES || bytes >= MAX_PLUGIN_BYTES || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const fromPath = join(from, entry.name);
      const toPath = join(to, entry.name);
      let info;
      try {
        info = lstatSync(fromPath);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        mkdirSync(toPath, { recursive: true });
        walk(fromPath, toPath, depth + 1, agents);
      } else if (info.isFile() && info.size <= MAX_FILE_BYTES) {
        // Below `agents`, only agent files in Markdown go on, each with its header written again.
        if (agents && !/\.md$/i.test(entry.name)) continue;
        mkdirSync(to, { recursive: true });
        try {
          if (agents) writeFileSync(toPath, plainAgentFile(readFileSync(fromPath, "utf8")));
          else copyFileSync(fromPath, toPath);
          files++;
          bytes += info.size;
        } catch {
          // A file that changed or disappeared during projection is omitted.
        }
      }
    }
  };
  for (const name of ["skills", "agents", "commands"]) {
    const sourcePath = join(source, name);
    if (existsSync(sourcePath)) {
      mkdirSync(join(destination, name), { recursive: true });
      walk(sourcePath, join(destination, name), 0, name === "agents");
    }
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

/** One tool of the reading, with its values, as the SDK takes it. Null when a word of its line holds a value the person gave. */
function serverConfig(plugin, expand, secrets, server) {
  if (server.kind === "local") {
    const { command, args } = server;
    // Settings never become command-line arguments, executable paths or working directories.
    // A local credential must never become part of the launcher argv, even encoded in its
    // reviewed command spec. Literal values that match a supplied credential therefore fail closed.
    if ([command, ...args].some((part) => secrets.some((secret) => secret && part.includes(secret)))) return null;
    const env = Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, expand(value)]));
    const launcherSpec = Buffer.from(JSON.stringify({ command, args, envKeys: Object.keys(env) })).toString("base64url");
    const launcherEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
    return { type: "stdio", command: process.execPath, args: [MCP_LAUNCHER, launcherSpec], env: launcherEnv, workingDirectory: server.cwd ?? plugin.folder, tools: ["*"] };
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
    const { settings, secrets } = approvedSettings(plugin, manifest);
    const values = valuesFor(plugin, manifest, safeContext, projection, settings);
    for (const planned of starts.servers) {
      const server = serverConfig(plugin, values.expand, secrets, planned);
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
