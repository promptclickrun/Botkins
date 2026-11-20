// The host side of plugins-v1. A plugin folder is untrusted input: its skills, agents and
// commands are projected into a manifest-free (except for a small safe manifest) directory while
// its MCP files and hooks are read by Botkins. This keeps the Copilot runtime from discovering and
// running the same file hook a second time.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_HOOK_COMMAND = 20_000;
const MAX_HOOK_OUTPUT = 256_000;
const MAX_CONTEXT = 12_000;
const MAX_PROMPT = 100_000;
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_PLUGIN_BYTES = 8_000_000;
const RESERVED = new Set([
  "HOME",
  "PATH",
  "NODE_PATH",
  "PWD",
  "OLDPWD",
  "PLUGIN_ROOT",
  "PLUGIN_DATA",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "PATHEXT",
  "COMSPEC",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SYSTEMDRIVE",
  "PROGRAMFILES",
  "PROGRAMW6432",
  "PROGRAMDATA",
  "ELECTRON_RUN_AS_NODE",
]);
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)/i;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MANIFESTS = [
  ".plugin/plugin.json",
  "plugin.json",
  ".github/plugin.json",
  ".github/plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];
const EVENTS = {
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
const MCP_LAUNCHER = fileURLToPath(new URL("./plugin-mcp-launcher.mjs", import.meta.url));

const text = (value, max) => (typeof value === "string" && value.length <= max && !value.includes("\0") ? value : null);
const safeId = (value, fallback = "plugin") => {
  const id = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return !id || id === "." || id === ".." ? fallback : id;
};
const readJson = (path) => {
  try {
    const source = readFileSync(path, "utf8");
    if (source.length > 1_000_000) return null;
    const value = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};
const pathIsRegular = (path) => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};
const inside = (base, path) => path === base || path.startsWith(base + "/") || path.startsWith(base + "\\");
const pluginFile = (folder, relative) => {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || relative.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relative)) return null;
  try {
    const base = realpathSync(folder);
    const candidate = resolve(base, relative);
    if (!inside(base, candidate)) return null;
    const real = realpathSync(candidate);
    if (!inside(base, real) || !lstatSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
};
const firstManifest = (folder) => {
  for (const relative of MANIFESTS) {
    const path = pluginFile(folder, relative);
    if (pathIsRegular(path)) return { path, manifest: readJson(path) ?? {} };
  }
  return { path: null, manifest: {} };
};
const listObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** The stable SDK key for one plugin MCP server. */
export function pluginServerName(id, name) {
  const hash = createHash("sha256").update(String(id ?? "") + "\0" + String(name ?? "")).digest("hex").slice(0, 10);
  return "plugin_" + safeId(id, "plugin") + "__" + safeId(name, "server") + "_" + hash;
}

const mcpDocuments = (folder, manifest) => {
  const found = [];
  const declared = manifest.mcpServers;
  if (typeof declared === "string") {
    const path = pluginFile(folder, declared);
    if (path) found.push(path);
    return found;
  }
  if (declaredObject(declared)) return found;
  for (const file of [".mcp.json", "mcp.json", ".claude-plugin/.mcp.json", ".claude-plugin/mcp.json"]) {
    const path = pluginFile(folder, file);
    if (path) found.push(path);
  }
  return [...new Set(found)];
};
const mcpEntries = (folder, manifest) => {
  const out = [];
  const add = (value) => {
    const source = value?.mcpServers ?? value?.servers ?? value;
    if (!source || typeof source !== "object" || Array.isArray(source)) return;
    for (const [name, config] of Object.entries(source)) {
      if (config && typeof config === "object" && !Array.isArray(config)) out.push({ name, config });
    }
  };
  for (const path of mcpDocuments(folder, manifest)) {
    const data = readJson(path);
    if (data) add(data);
  }
  if (declaredObject(manifest.mcpServers)) add(manifest.mcpServers);
  return out;
};
function declaredObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** OAuth metadata used by the manager before it invokes pluginSession. No values are read. */
export function pluginOAuthServers(plugin) {
  const folder = typeof plugin?.folder === "string" ? plugin.folder : "";
  if (!folder) return [];
  const { manifest } = firstManifest(folder);
  const out = [];
  for (const { name: manifestName, config } of mcpEntries(folder, manifest)) {
    // Keep this predicate in lockstep with catalog.parseMcp: OAuth may be a boolean marker,
    // an object carrying a client id, or nested below authentication.
    const declaredOAuth = config.oauth || config.authentication?.oauth;
    const oauth = declaredOAuth === true
      ? {}
      : declaredOAuth && typeof declaredOAuth === "object" && !Array.isArray(declaredOAuth)
        ? declaredOAuth
        : config.oauthClientId
          ? { clientId: config.oauthClientId }
          : null;
    if (!oauth) continue;
    const url = text(config.url ?? config.serverUrl, 4_000);
    if (!url) continue;
    const clientId = text(oauth?.clientId ?? config.oauthClientId, 1_000);
    out.push({ name: pluginServerName(plugin.id, manifestName), url, ...(clientId && { clientId }), manifestName });
  }
  return out;
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
const safeEnvName = (key) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) && ![...RESERVED].some((reserved) => reserved.toLowerCase() === key.toLowerCase());

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
  const expand = (value) => String(value).replace(PLACEHOLDER, (_match, key) => builtins[key] ?? settings[key] ?? "${" + key + "}");
  return { builtins, expand };
}

const safePath = () => {
  const dirs = [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set(dirs.filter(Boolean))].join(delimiter);
};

function hookEnvironment(plugin, context, builtins, settings, declared) {
  const environment = {
    PATH: safePath(),
    ...builtins,
  };
  for (const [key, value] of Object.entries(declared && typeof declared === "object" ? declared : {})) {
    if (!safeEnvName(key) || typeof value !== "string" || value.length > 8_000) continue;
    environment[key] = value.replace(PLACEHOLDER, (_match, name) => builtins[name] ?? settings[name] ?? "${" + name + "}");
  }
  return environment;
}

function commandFor(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  if (entry.hooks) return commandFor(entry.hooks);
  if (entry.commands) return commandFor(entry.commands);
  return [entry.command, entry.bash, entry.cmd, entry.shell, entry.powershell, entry.windows, entry.darwin, entry.macos, entry.linux].find((value) => typeof value === "string" && value.trim());
}

function hookEntries(folder, manifest) {
  if (manifest.hooks && typeof manifest.hooks === "object" && !Array.isArray(manifest.hooks)) return manifest.hooks.hooks && typeof manifest.hooks.hooks === "object" ? manifest.hooks.hooks : manifest.hooks;
  const paths = [];
  if (typeof manifest.hooks === "string") {
    const path = pluginFile(folder, manifest.hooks);
    if (path) paths.push(path);
    for (const candidate of paths) {
      const data = readJson(candidate);
      const hooks = data?.hooks;
      return hooks && typeof hooks === "object" && !Array.isArray(hooks) ? hooks : {};
    }
    return {};
  }
  for (const file of ["hooks.json", "hooks/hooks.json", ".claude-plugin/hooks.json", ".claude-plugin/hooks/hooks.json"]) {
    const path = pluginFile(folder, file);
    if (path) paths.push(path);
  }
  for (const path of [...new Set(paths)]) {
    const data = readJson(path);
    const hooks = data?.hooks;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) continue;
    return hooks;
  }
  return {};
}

const canonicalEvent = (name) => {
  const value = String(name ?? "").replace(/[-_ ]/g, "").toLowerCase();
  return Object.keys(EVENTS).find((event) => event.replace(/[-_]/g, "").toLowerCase() === value) ?? null;
};
const flattenHooks = (value) => {
  if (Array.isArray(value)) return value.flatMap(flattenHooks);
  if (value && typeof value === "object") {
    // Hook matchers are plugin-runtime policy, not a shell command hint. Until the host can
    // evaluate the documented matcher grammar faithfully, a constrained entry is fail-closed.
    if (Object.hasOwn(value, "matcher") || Object.hasOwn(value, "match")) return [];
    if (Array.isArray(value.hooks)) return flattenHooks(value.hooks);
    if (Array.isArray(value.commands)) return flattenHooks(value.commands);
  }
  return value ? [value] : [];
};

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
    const timeoutMs = Math.max(250, Math.min(30_000, Number(options.timeoutSec || 10) * 1_000));
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

function makeHandlers(plugin, context, manifest, settings, secrets, projection) {
  const hooks = hookEntries(plugin.folder, manifest);
  const handlers = {};
  const { builtins } = valuesFor(plugin, manifest, context, projection, settings);
  for (const [rawEvent, rawEntries] of Object.entries(hooks)) {
    const event = canonicalEvent(rawEvent);
    const sdkName = event && EVENTS[event];
    if (!sdkName) continue;
    const entries = flattenHooks(rawEntries)
      .map((entry) => ({ entry, command: commandFor(entry) }))
      .filter(({ command }) => typeof command === "string" && command.length <= MAX_HOOK_COMMAND && !command.includes("\0"));
    if (!entries.length) continue;
    handlers[sdkName] = async (input = {}, invocation = {}) => {
      let combined = {};
      let currentInput = {
        ...(input && typeof input === "object" ? input : {}),
        ...(context.chatId && !Object.hasOwn(input, "chatId") && { chatId: context.chatId }),
        ...(context.botId && !Object.hasOwn(input, "botId") && { botId: context.botId }),
      };
      for (const { entry, command } of entries) {
        const env = hookEnvironment(plugin, context, builtins, settings, entry?.env);
        // Built-ins are present in the child environment. Leave their shell placeholders intact
        // so a reviewed command can quote them correctly when paths contain spaces or metacharacters.
        const output = await runHook(command, currentInput, {
          cwd: plugin.folder,
          env,
          timeoutSec: entry?.timeoutSec,
        });
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

function copyPlainTree(source, destination) {
  let files = 0;
  let bytes = 0;
  const walk = (from, to, depth) => {
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
        walk(fromPath, toPath, depth + 1);
      } else if (info.isFile() && info.size <= MAX_FILE_BYTES) {
        mkdirSync(to, { recursive: true });
        try {
          copyFileSync(fromPath, toPath);
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
      walk(sourcePath, join(destination, name), 0);
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

function serverConfig(plugin, manifest, settings, expand, secrets, config) {
  const type = config.type === "local" ? "stdio" : config.type === "streamable-http" ? "http" : config.type ?? (config.url || config.serverUrl ? "http" : "stdio");
  if (type === "stdio") {
    const command = text(config.command, 2_000);
    // Settings never become command-line arguments, executable paths or working directories.
    const args = Array.isArray(config.args) ? config.args.filter((arg) => typeof arg === "string" && arg.length <= 8_000 && !arg.includes("\0")) : [];
    if (!command) return null;
    // A local credential must never become part of the launcher argv, even encoded in its
    // reviewed command spec. Literal values that match a supplied credential therefore fail closed.
    if ([command, ...args].some((part) => secrets.some((secret) => secret && part.includes(secret)))) return null;
    const env = {};
    for (const [key, value] of Object.entries(listObject(config.env))) if (safeEnvName(key) && typeof value === "string") env[key] = expand(value);
    const cwd = typeof config.cwd === "string" ? config.cwd : typeof config.workingDirectory === "string" ? config.workingDirectory : plugin.folder;
    const launcherSpec = Buffer.from(JSON.stringify({ command, args, envKeys: Object.keys(env) })).toString("base64url");
    const launcherEnv = process.versions.electron ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
    return { type: "stdio", command: process.execPath, args: [MCP_LAUNCHER, launcherSpec], env: launcherEnv, workingDirectory: cwd, tools: ["*"] };
  }
  if (type !== "http" && type !== "sse") return null;
  // A setting in a URL would become an accidental credential-bearing destination. URLs are
  // catalog metadata and stay literal; only headers receive approved values.
  const url = text(String(config.url ?? config.serverUrl ?? ""), 4_000);
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const headers = {};
  for (const [key, value] of Object.entries(listObject(config.headers))) if (typeof value === "string" && key.length <= 200) headers[key] = expand(value);
  return { type, url, headers, tools: ["*"] };
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
export function pluginSession(plugins, context = {}) {
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
    const { manifest } = firstManifest(plugin.folder);
    const projection = project(plugin, safeContext, manifest);
    directories.push(projection);
    if (context.skillsOnly === true) continue;
    const { settings, secrets } = approvedSettings(plugin, manifest);
    const { expand } = valuesFor(plugin, manifest, safeContext, projection, settings);
    for (const { name: manifestName, config } of mcpEntries(plugin.folder, manifest)) {
      const sdkName = pluginServerName(plugin.id, manifestName);
      const server = serverConfig(plugin, manifest, settings, expand, secrets, config);
      if (server) mcpServers[sdkName] = server;
    }
    const handlers = makeHandlers(plugin, safeContext, manifest, settings, secrets, projection);
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
