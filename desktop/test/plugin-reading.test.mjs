// What a plugin is shown to start is what it starts.
//
// The description a person agrees to (desktop/plugin-catalog.mjs) and the runtime that starts a
// plugin's tools and hooks (desktop/plugin-runtime.mjs) take both from one reading of the
// plugin's files (desktop/plugin-reading.mjs). These tests go the two real ways for each
// fixture: the description as an install shows it, and a session as the runtime opens it, with
// the hooks' commands caught in place of being run. Everything the session would start must be
// in the description, word for word: the command, each argument, the folder, and each
// environment name with its value. A key that one side reads and the other does not fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectPlugin, PluginCatalog, snapshotStamp, verifySnapshot } from "../desktop/plugin-catalog.mjs";
import { BUILT_IN_VALUES, configFile, dependencyFolder, describeStarts, envName, EVENTS, filesReader, LIMITS, lineOf, lspNames, NAMES_NOT_SET, PLACEHOLDER, pluginStarts, startWarnings, STARTS, whyNotSet } from "../desktop/plugin-reading.mjs";
import { plainAgentFile, pluginServerName, pluginSession } from "../desktop/plugin-runtime.mjs";

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "botkins-plugin-reading-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
/** A plugin folder with these files (an object is written as JSON). */
const plugin = (t, files) => {
  const root = join(temp(t), "plugin");
  for (const [name, value] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  return root;
};

/**
 * The names Botkins sets itself, for a hook and for a tool. Such a name is left out of the
 * comparison only when its real value is not the one the plugin wrote for it: if the plugin got
 * its own value in, the name stays, and the comparison fails.
 */
const OWN_FOR_HOOK = ["PATH", "PYTHONDONTWRITEBYTECODE", ...BUILT_IN_VALUES];
const OWN_FOR_TOOL = ["PLUGIN_DATA", "CLAUDE_PLUGIN_DATA", "ELECTRON_RUN_AS_NODE"];
const listed = (env, own, written) => Object.entries(env).filter(([name, value]) => !(own.includes(name) && value !== written[name])).map(([name, value]) => ({ name, value }));
/** Every string the fixture's plugin wrote under an `env` key, name → value, in any file of it. */
function writtenEnv(files) {
  const out = {};
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "env" && item && typeof item === "object" && !Array.isArray(item)) for (const [name, text] of Object.entries(item)) if (typeof text === "string") out[name] = text;
      walk(item);
    }
  };
  Object.values(files).forEach(walk);
  return out;
}

/** What a session starts for a plugin folder, in the description's own shape. The hooks' commands are caught, not run. */
async function started(t, folder, { config = [], values = {}, written = {} } = {}) {
  const ran = [];
  const environments = [];
  const dir = temp(t);
  const session = pluginSession([{ id: "p", folder, config, values }], { dir, chatId: "c", botId: "b" }, { run: async (command, _input, options) => void ran.push({ command, options }) });
  // The values Botkins puts in place of ${NAME}: as the real environments hold them.
  const builtins = { PLUGIN_ROOT: folder, CLAUDE_PLUGIN_ROOT: folder, BOTKINS_DIR: dir, BOTKINS_CHAT_ID: "c", BOTKINS_BOT_ID: "b" };
  const hooks = [];
  for (const [sdkName, handler] of Object.entries(session.hooks.handlers)) {
    ran.length = 0;
    await handler({});
    const event = Object.keys(EVENTS).find((name) => EVENTS[name] === sdkName);
    for (const { command, options } of ran) {
      hooks.push({ event, command, env: listed(options.env, OWN_FOR_HOOK, written), timeoutSec: options.timeoutMs / 1_000 });
      environments.push(options.env);
      for (const name of BUILT_IN_VALUES) if (name in options.env) builtins[name] = options.env[name];
    }
  }
  const servers = new Map(
    Object.entries(session.mcpServers).map(([sdkName, server]) => {
      if (server.type !== "stdio") return [sdkName, { kind: "remote", type: server.type, url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) }];
      const spec = JSON.parse(Buffer.from(server.args[1], "base64url").toString("utf8"));
      assert.deepEqual(Object.keys(server.env).filter((name) => name !== "ELECTRON_RUN_AS_NODE"), spec.envKeys, "the environment handed to the launcher is the list in its line");
      for (const name of ["PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"]) if (name in server.env) builtins[name] ??= server.env[name];
      // The folder: the plugin's own (none shown), below it (the path below), or another (as it is).
      const at = server.workingDirectory;
      const cwd = at === folder ? null : at.startsWith(folder + "/") ? at.slice(folder.length + 1) : at;
      return [sdkName, { kind: "local", command: spec.command, args: spec.args, env: listed(server.env, OWN_FOR_TOOL, written), ...(cwd !== null && { cwd }) }];
    }),
  );
  return { hooks, servers, environments, session, builtins };
}

/** The description of a folder and what a session starts for it. Fails unless they are the same, word for word. */
async function both(t, files, options = {}) {
  const folder = plugin(t, files);
  const shown = inspectPlugin(folder).contents;
  const real = await started(t, folder, { ...options, written: writtenEnv(files) });
  // The description has each value as written; a session has ${NAME} filled in, from Botkins' own values and the person's.
  const given = options.values ?? {};
  const filled = (list) => list.map(({ name, value }) => ({ name, value: value.replace(PLACEHOLDER, (_match, key) => real.builtins[key] ?? given[key] ?? "${" + key + "}") }));
  // A tool on the web is compared the same way: its type and address as they are, its header names exactly, and each value as written or with its settings filled in.
  const asRun = ({ envNotSet: _notSet, ...item }) => ({ ...item, ...(item.env && { env: filled(item.env) }), ...(item.headers && { headers: filled(item.headers) }) });
  assert.deepEqual(real.hooks, shown.hooks.map(asRun), "the hooks that run are the hooks that are shown");
  // An event that is named as not run is never one that is shown: a hook is in one list or the other.
  for (const item of shown.notRun?.items ?? []) if (item.what === "hook" && item.why === NO_EVENT) assert.equal(shown.hooks.some((hook) => hook.event === item.name), false, item.name + " is shown and not run");
  assert.deepEqual([...real.servers.keys()].sort(), shown.mcpServers.map((server) => pluginServerName("p", server.name)).sort(), "the tools that start are the tools that are shown");
  for (const { name, oauth: _signIn, oauthClientId: _clientId, ...server } of shown.mcpServers) assert.deepEqual(real.servers.get(pluginServerName("p", name)), asRun(server), "the tool " + name + " starts as it is shown");
  return { folder, shown, real };
}
const manifest = (more = {}) => ({ name: "fixture", version: "1.0.0", ...more });
const NO_MATCHER = "Botkins runs no hook with a matcher.";
const NO_EVENT = "Botkins has no event with this name.";
const NO_COMMAND = "This hook has no command.";
const EARLIER = "Another spelling of this event comes later in the file, and only that one runs.";
/** A reason as the plan says it: a sentence. */
const said = (reason) => reason[0].toUpperCase() + reason.slice(1) + ".";
const RESERVED_WHY = "Botkins or the system sets this name.";

test("an ordinary plugin: a tool on the web, a program with its words, folder and values, and a hook", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest({ userConfig: { API_KEY: { sensitive: true } } }),
    ".mcp.json": {
      mcpServers: {
        docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer ${API_KEY}" }, oauth: true },
        files: { command: "npx", args: ["-y", "@scope/pkg", "--root", "${PLUGIN_ROOT}"], env: { TOKEN: "${API_KEY}", MODE: "fast" }, cwd: "/srv/data" },
      },
    },
    "hooks/hooks.json": { hooks: { sessionStart: [{ type: "command", command: "node \"${PLUGIN_ROOT}/start.mjs\"", env: { LEVEL: "${API_KEY}", HERE: "${PLUGIN_ROOT}/x" }, timeoutSec: 3 }] } },
  }, { values: { API_KEY: "k-123" } });
  // A program is shown with every word of its line, its folder and each environment value as written (a setting is the ${NAME}, never its value): not "npx" alone.
  assert.deepEqual(shown.mcpServers, [
    { name: "docs", kind: "remote", type: "http", url: "https://docs.example/mcp", headers: [{ name: "Authorization", value: "Bearer ${API_KEY}" }], oauth: true },
    { name: "files", kind: "local", command: "npx", args: ["-y", "@scope/pkg", "--root", "${PLUGIN_ROOT}"], env: [{ name: "TOKEN", value: "${API_KEY}" }, { name: "MODE", value: "fast" }], cwd: "/srv/data" },
  ]);
  assert.deepEqual(shown.hooks, [{ event: "sessionStart", command: "node \"${PLUGIN_ROOT}/start.mjs\"", env: [{ name: "LEVEL", value: "${API_KEY}" }, { name: "HERE", value: "${PLUGIN_ROOT}/x" }], timeoutSec: 3 }]);
});

test("a tool on the web is shown with its type, its address, each header with its written value, and its sign-in client's id", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest({ userConfig: { API_KEY: { sensitive: true } } }),
    ".mcp.json": {
      mcpServers: {
        stream: { type: "sse", url: "https://stream.example/sse", headers: { "X-Mode": "fast", "X-Key": "${API_KEY}" }, oauth: { clientId: "abc" } },
        flat: { type: "http", url: "https://flat.example/mcp", oauthClientId: "xyz" },
        plain: { url: "https://plain.example/mcp" },
      },
    },
  }, { values: { API_KEY: "k-123" } });
  // The secret is never in the description: the header has the ${NAME}, and the type and the client's id are as the plugin named them.
  assert.deepEqual(shown.mcpServers, [
    { name: "stream", kind: "remote", type: "sse", url: "https://stream.example/sse", headers: [{ name: "X-Mode", value: "fast" }, { name: "X-Key", value: "${API_KEY}" }], oauth: true, oauthClientId: "abc" },
    { name: "flat", kind: "remote", type: "http", url: "https://flat.example/mcp", headers: [], oauth: true, oauthClientId: "xyz" },
    { name: "plain", kind: "remote", type: "http", url: "https://plain.example/mcp", headers: [] },
  ]);
  assert.equal(JSON.stringify(shown).includes("k-123"), false);
});

test("a hook that runs now and did not run before is flagged in the description as a whole, not on the hook", () => {
  const flag = (hooks) => describeStarts(planOf({ "plugin.json": manifest(), "hooks.json": { hooks } }));
  for (const hooks of [
    { sessionStart: [{ matcher: "*", command: "a" }] },
    { sessionStart: [{ matcher: "", command: "a" }] },
    { sessionStart: [{ hooks: { matcher: "*", command: "a" } }] },
    { sessionStart: [{ matcher: "*", hooks: [{ command: "a" }] }] },
    { UserPromptSubmit: [{ command: "a" }] },
    { "stop": [{ command: "a" }] },
    { "user-prompt_submit": [{ command: "a" }] },
    { "user-prompt-submit": [{ command: "a" }] },
    { USER_PROMPT_SUBMIT: [{ command: "a" }] },
    { Stop: [{ command: "a" }] },
    // Every form of "every case", on the entry or a step above or below it.
    { sessionStart: [{ matcher: " * ", command: "a" }] },
    { sessionStart: [{ match: "*", command: "a" }] },
    { sessionStart: [{ match: "", command: "a" }] },
    { sessionStart: [{ matcher: [], command: "a" }] },
    { sessionStart: [{ matcher: ["*"], command: "a" }] },
    { sessionStart: [{ match: [], command: "a" }] },
    { sessionStart: [{ match: ["*"], command: "a" }] },
    { sessionStart: [{ matcher: [], hooks: [{ command: "a" }] }] },
    { sessionStart: [{ hooks: { matcher: ["*"], command: "a" } }] },
    { sessionStart: [{ commands: [{ match: [], bash: "a" }] }] },
  ]) {
    const shown = flag(hooks);
    assert.equal(shown.hooks.length, 1, JSON.stringify(hooks));
    assert.equal(shown.newlyRun, true, JSON.stringify(hooks));
    assert.equal("newlyRun" in shown.hooks[0], false, "the shown hook has no such key");
  }
  for (const hooks of [{ userPromptSubmitted: [{ command: "a" }] }, { agentStop: [{ command: "a" }] }, { sessionStart: [{ command: "a" }] }, { sessionStart: [{ matcher: "Bash", command: "a" }, { command: "b" }] }]) assert.equal(flag(hooks).newlyRun, false, JSON.stringify(hooks));
  // Any other list is a real matcher: the hook does not run, and it is said not to. The plan and the description agree.
  for (const matcher of [["Bash"], ["*", "Bash"], ["", ""], [" ", "*"], null, 0, false, {}]) {
    for (const key of ["matcher", "match"]) {
      const plan = planOf({ "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ [key]: matcher, command: "a" }] } } });
      assert.deepEqual([plan.hooks.length, plan.notRun], [0, [{ what: "hook", name: "sessionStart", why: NO_MATCHER }]], JSON.stringify(matcher));
      assert.equal(describeStarts(plan).newlyRun, false);
    }
  }
  // The plan has the flag on the hook that runs now and none on one that did before.
  const plan = planOf({ "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ matcher: "*", command: "new" }, { command: "old" }] } } });
  assert.deepEqual(plan.hooks.map((hook) => [hook.command, "newlyRun" in hook]), [["new", true], ["old", false]]);
  assert.equal(describeStarts(plan).newlyRun, true);
});

test("where a setting goes is in the description: the names and the address that get its value", async (t) => {
  const folder = plugin(t, {
    "plugin.json": manifest(),
    ".mcp.json": { mcpServers: { docs: { url: "https://docs.example/mcp", headers: { "X-Key": "${API_KEY}" } }, files: { command: "node", env: { TOKEN: "${API_KEY}", HOME_DIR: "${PLUGIN_ROOT}" } } } },
    "hooks.json": { hooks: { sessionEnd: [{ command: "true", env: { K: "a ${API_KEY} b ${OTHER}" } }] } },
  });
  const { config } = inspectPlugin(folder);
  // A value Botkins sets itself (${PLUGIN_ROOT}) is no setting of the plugin.
  assert.deepEqual(config.map((field) => [field.key, field.sentTo]), [
    ["API_KEY", [{ tool: "docs", header: "X-Key", url: "https://docs.example/mcp" }, { tool: "files", env: "TOKEN" }, { hook: "sessionEnd", env: "K" }]],
    ["OTHER", [{ hook: "sessionEnd", env: "K" }]],
  ]);
});

test("a tool with type stdio and an address is a program, and is shown as the program", async (t) => {
  const { shown } = await both(t, { "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { type: "stdio", url: "https://a.example", command: "sh", args: ["-c", "touch /tmp/x"] } } } });
  assert.deepEqual(shown.mcpServers, [{ name: "x", kind: "local", command: "sh", args: ["-c", "touch /tmp/x"], env: [] }]);
  assert.match(inspectPlugin(plugin(t, { "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { type: "stdio", url: "https://a.example", command: "sh" } } } })).warnings.join(" "), /Runs a local MCP server/);
});

test("a hook is read by its command keys, whatever its type says", async (t) => {
  const { shown } = await both(t, { "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ type: "x", darwin: "touch /tmp/darwin" }, { type: "prompt", shell: "touch /tmp/shell" }, "touch /tmp/text", { type: "command" }] } } });
  assert.deepEqual(shown.hooks.map((hook) => hook.command), ["touch /tmp/darwin", "touch /tmp/shell", "touch /tmp/text"]);
});

test("one manifest counts, the first of the list, for the description and for the session", async (t) => {
  const { shown } = await both(t, {
    ".github/plugin.json": manifest({ hooks: { sessionStart: [{ command: "touch /tmp/first" }] } }),
    ".github/plugin/plugin.json": manifest({ hooks: { sessionStart: [{ command: "touch /tmp/second" }] } }),
  });
  assert.deepEqual(shown.hooks.map((hook) => hook.command), ["touch /tmp/first"]);
});

test("every tool file is read, and the same name later takes the place of the earlier one", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest(),
    ".mcp.json": { mcpServers: { a: { command: "first" }, b: { command: "b" } } },
    "mcp.json": { mcpServers: { c: { command: "c" } } },
    ".claude-plugin/.mcp.json": { servers: { a: { command: "second" } } },
    ".claude-plugin/mcp.json": { d: { url: "https://d.example/mcp" } },
  });
  assert.deepEqual(shown.mcpServers.map((server) => [server.name, server.command ?? server.url]), [["a", "second"], ["b", "b"], ["c", "c"], ["d", "https://d.example/mcp"]]);
});

test("a hooks file with no hooks is passed over, and the next one is the one that is shown and run", async (t) => {
  const { shown } = await both(t, { "plugin.json": manifest(), "hooks.json": { note: "nothing here" }, "hooks/hooks.json": { hooks: { agentStop: [{ command: "touch /tmp/next" }] } } });
  assert.deepEqual(shown.hooks, [{ event: "agentStop", command: "touch /tmp/next", env: [], timeoutSec: 10 }]);
});

test("a long command is shown whole, and a plugin with one too long to show is not installed and not run", async (t) => {
  const long = "echo " + "a".repeat(3_000) + " && touch /tmp/tail";
  const { shown } = await both(t, { "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ command: long }] } } });
  assert.equal(shown.hooks[0].command, long, "nothing is cut");
  const tooLong = plugin(t, { "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ command: "true" }, { command: "echo " + "a".repeat(LIMITS.hookCommand) }] } }, ".mcp.json": { mcpServers: { big: { command: "node", args: ["a".repeat(LIMITS.arg + 1)] } } } });
  assert.throws(() => inspectPlugin(tooLong), /cannot be shown whole, so Botkins does not install it/);
  // An installed copy from before this rule: what cannot be shown is not started.
  const real = await started(t, tooLong);
  assert.deepEqual([real.hooks.map((hook) => hook.command), real.servers.size], [["true"], 0]);
});

/** The plan (`pluginStarts`) of a plugin's files, read through the same reader the description uses. */
const planOf = (files) => pluginStarts(filesReader(new Map(Object.entries(files).map(([name, value]) => [name, { bytes: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) }]))));

test("a plugin sets no name that makes a program load something more; what it sets is shown with its value and what is not set is said", async (t) => {
  const env = {
    GOOD: "1", MODE: "fast", NODE_OPTIONS: "--require ./x.js", node_options: "--require ./x.js", BASH_ENV: "./x", ENV: "./x", DYLD_INSERT_LIBRARIES: "./x", LD_PRELOAD: "./x", PYTHONPATH: ".", PATH: "/evil", HOME: "/evil",
    PLUGIN_DATA: "/evil", CLAUDE_PLUGIN_DATA: "/evil", PLUGIN_ROOT: "/evil", ELECTRON_RUN_AS_NODE: "0", GIT_SSH_COMMAND: "sh -c 'touch /tmp/x'", git_config_count: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", NPM_CONFIG_SCRIPT_SHELL: "/x", npm_config_script_shell: "/x", PAGER: "sh", "BAD NAME": "x", NUMBER: 3,
  };
  const { folder, shown, real } = await both(t, { "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ command: "node -v", env }] } }, ".mcp.json": { mcpServers: { tool: { command: "node", args: ["-v"], env } } } });
  // A harmless name is shown with its value as written. Every other key is named as not set: the person sees why a tool fails.
  const notSet = Object.keys(env).filter((name) => name !== "GOOD" && name !== "MODE");
  const names = (list) => list.map((item) => item.name);
  const set = [{ name: "GOOD", value: "1" }, { name: "MODE", value: "fast" }];
  assert.deepEqual([shown.hooks[0].env, shown.mcpServers[0].env], [set, set]);
  assert.deepEqual([names(shown.hooks[0].envNotSet), names(shown.mcpServers[0].envNotSet)], [notSet, notSet]);
  // Each has the sentence that says why.
  assert.deepEqual(shown.hooks[0].envNotSet, shown.mcpServers[0].envNotSet);
  const why = new Map(shown.hooks[0].envNotSet.map((item) => [item.name, item.why]));
  const family = (start) => "Botkins sets no name that starts with " + start + ". Such a name can make a program load or start more than its command says.";
  assert.deepEqual([why.get("NODE_OPTIONS"), why.get("node_options"), why.get("GIT_SSH_COMMAND"), why.get("NPM_CONFIG_SCRIPT_SHELL"), why.get("DYLD_INSERT_LIBRARIES"), why.get("BASH_ENV")], [family("NODE_"), family("NODE_"), family("GIT_"), family("NPM_"), family("DYLD_"), family("BASH")]);
  assert.deepEqual([why.get("PATH"), why.get("HOME"), why.get("PLUGIN_ROOT")], [RESERVED_WHY, RESERVED_WHY, RESERVED_WHY]);
  assert.deepEqual([why.get("ENV"), why.get("PAGER")], Array(2).fill("Botkins does not set this name. It can make a program load or start more than its command says."));
  assert.deepEqual([why.get("BAD NAME"), why.get("NUMBER")], ["This is not a name that can be set.", "Its value is not text."]);
  assert.equal(shown.hooks[0].env.some(({ name }) => name === "GIT_SSH_COMMAND"), false);
  // The names Botkins sets itself keep the values Botkins gives them, in the hook's environment and in the tool's.
  const [hookEnv] = real.environments;
  const [toolEnv] = Object.values(real.session.mcpServers).map((server) => server.env);
  for (const given of [hookEnv, toolEnv]) {
    for (const name of notSet) if (name in given) assert.notEqual(given[name], env[name], name + " has the plugin's value");
    for (const name of ["NODE_OPTIONS", "node_options", "BASH_ENV", "ENV", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "PYTHONPATH", "HOME", "GIT_SSH_COMMAND", "git_config_count", "GIT_CONFIG_KEY_0", "NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell", "PAGER", "BAD NAME", "NUMBER"]) assert.equal(name in given, false, name);
  }
  assert.notEqual(hookEnv.PATH, "/evil");
  assert.equal("PATH" in toolEnv, false);
  assert.notEqual(toolEnv.PLUGIN_DATA, "/evil");
  // The description says so once, and says it again the same way from its own lists.
  const { warnings } = inspectPlugin(folder);
  const says = "Botkins does not set some environment names that this plugin asks for. Its tools or hooks may not work.";
  assert.equal(warnings.filter((line) => line === says).length, 1);
  assert.deepEqual(startWarnings(shown.mcpServers, shown.hooks, warnings), warnings);
  assert.equal(startWarnings([{ kind: "local", env: [] }], [], []).includes(says), false);
  for (const name of ["NODE_OPTIONS", "Node_Options", "BASH_ENV", "ENV", "DYLD_LIBRARY_PATH", "LD_AUDIT", "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT", "JAVA_TOOL_OPTIONS", "PATH", "HOME", "ELECTRON_RUN_AS_NODE", "A-B", ""]) assert.equal(envName(name), false, name);
  for (const name of ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_PAGER", "GIT_EDITOR", "GIT_PROXY_COMMAND", "PAGER", "EDITOR", "VISUAL", "LESSOPEN", "LESSCLOSE", "DOTNET_STARTUP_HOOKS", "CLASSPATH", "BUNDLE_GEMFILE", "XDG_CONFIG_HOME", "NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell", "GIT_CONFIG_COUNT", "git_config_key_0", "NPM_CONFIG_REGISTRY"]) assert.equal(envName(name), false, name);
  for (const name of ["GOOD", "API_KEY", "_x", "LDAP_URL", "MODE"]) assert.equal(envName(name), true, name);
});

test("the plan has, for a local tool and for a hook, its env as name to written value and the names that are not set", () => {
  const plan = planOf({
    "plugin.json": manifest(),
    ".mcp.json": { mcpServers: { tool: { command: "node", args: ["a", 3, true], env: { MODE: "${A}-x", PATH: "/evil", N: 1 }, cwd: "server/bin" }, bare: { command: "node" } } },
    "hooks.json": { hooks: { sessionStart: [{ command: "true", env: { MODE: "fast", GIT_SSH_COMMAND: "x" }, timeoutSec: 2 }, { command: "false" }] } },
  });
  assert.deepEqual(plan.servers, [
    { name: "tool", kind: "local", command: "node", args: ["a", "3", "true"], env: { MODE: "${A}-x" }, envNotSet: [{ name: "PATH", why: RESERVED_WHY }, { name: "N", why: "Its value is not text." }], cwd: "server/bin" },
    { name: "bare", kind: "local", command: "node", args: [], env: {}, envNotSet: [], cwd: null },
  ]);
  assert.deepEqual(plan.hooks, [
    { event: "sessionStart", command: "true", env: { MODE: "fast" }, envNotSet: [{ name: "GIT_SSH_COMMAND", why: "Botkins sets no name that starts with GIT_. Such a name can make a program load or start more than its command says." }], timeoutMs: 2_000 },
    { event: "sessionStart", command: "false", env: {}, envNotSet: [], timeoutMs: 10_000 },
  ]);
  assert.deepEqual(plan.refused, []);
});

test("an environment value is shown whole or the plugin is refused: the thing with a value too long or a name too long is not started", async (t) => {
  const whole = "v".repeat(LIMITS.value);
  const { shown } = await both(t, { "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ command: "true", env: { WHOLE: whole } }] } }, ".mcp.json": { mcpServers: { tool: { command: "node", env: { WHOLE: whole } } } } });
  assert.deepEqual([shown.hooks[0].env[0].value.length, shown.mcpServers[0].env[0].value.length], [LIMITS.value, LIMITS.value], "nothing is cut");
  assert.equal(LIMITS.value, 4_000);
  const files = (env) => ({ "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ command: "first" }, { command: "second", env }] } }, ".mcp.json": { mcpServers: { ok: { command: "node" }, bad: { command: "node", env } } } });
  const cases = [
    [{ LONG: "v".repeat(LIMITS.value + 1) }, "an environment value is longer than 4000 characters"],
    [{ NUL: "a\0b" }, "an environment value has a NUL character"],
    [{ ["N".repeat(LIMITS.name + 1)]: "x" }, "an environment name is longer than 200 characters"],
  ];
  for (const [env, reason] of cases) {
    const input = files(env);
    assert.deepEqual(planOf(input).refused, [{ what: "tool", name: "bad", why: said(reason) }, { what: "hook", name: "sessionStart", why: said(reason) }]);
    assert.throws(() => inspectPlugin(plugin(t, input)), (error) => error.message === "This plugin cannot be shown whole, so Botkins does not install it. " + said(reason));
    // An installed copy from before this rule: what cannot be shown is not started.
    const real = await started(t, plugin(t, input));
    assert.deepEqual([real.hooks.map((hook) => hook.command), [...real.servers.keys()]], [["first"], [pluginServerName("p", "ok")]]);
  }
  // A long value under a name that is not set is no value to show: the name is only said not to be set.
  const notSet = planOf(files({ PATH: "v".repeat(LIMITS.value + 1) }));
  assert.deepEqual([notSet.refused, notSet.servers[1].envNotSet], [[], [{ name: "PATH", why: RESERVED_WHY }]]);
});

test("an argument that is a number or true/false is its text; any other that is not text refuses the tool with a sentence that says so", async (t) => {
  const { shown } = await both(t, { "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", args: ["--port", 3000, true, false, 1.5, -2, "text"] } } } });
  assert.deepEqual(shown.mcpServers[0].args, ["--port", "3000", "true", "false", "1.5", "-2", "text"]);
  const refusing = (args) => planOf({ "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", args } } } }).refused.map((item) => item.why);
  const notText = "A tool's argument is not text, a number or true/false.";
  for (const bad of [null, {}, ["a"], "a\0b"]) assert.deepEqual(refusing(["ok", bad]), [notText]);
  assert.throws(() => inspectPlugin(plugin(t, { "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", args: [null] } } } })), /does not install it\. A tool's argument is not text, a number or true\/false\./);
  assert.deepEqual(refusing(["a".repeat(LIMITS.arg + 1)]), ["A tool's argument is longer than 4000 characters."]);
  assert.deepEqual(refusing(Array.from({ length: LIMITS.args + 1 }, () => "a")), ["A tool has more than 200 arguments."]);
  assert.deepEqual(refusing(Array.from({ length: LIMITS.args }, () => "a")), []);
});

test("a tool's folder is the plugin's own, an absolute path as written, or a path below the plugin's own folder; one that leaves it refuses the tool", async (t) => {
  const tool = (cwd) => ({ "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", cwd } } } });
  const own = await both(t, tool("server/bin"));
  assert.equal(own.shown.mcpServers[0].cwd, "server/bin", "a relative path is below the plugin's folder");
  assert.equal(own.real.servers.get(pluginServerName("p", "x")).cwd, "server/bin");
  assert.equal((await both(t, tool("/srv/data"))).shown.mcpServers[0].cwd, "/srv/data");
  assert.equal((await both(t, { "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", workingDirectory: "./a//b/" } } } })).shown.mcpServers[0].cwd, "a/b", "the one form of a path");
  for (const same of [".", "./", "", ".//", "./."]) {
    const { shown, real } = await both(t, tool(same));
    assert.equal("cwd" in shown.mcpServers[0], false, JSON.stringify(same));
    assert.equal("cwd" in real.servers.get(pluginServerName("p", "x")), false, JSON.stringify(same));
  }
  for (const [cwd, as] of [["/srv/data", "/srv/data"], ["C:\\data", "C:\\data"], ["C:/data", "C:/data"], ["./x/y", "x/y"]]) assert.equal(planOf(tool(cwd)).servers[0].cwd, as, cwd);
  for (const leaves of ["..", "../x", "a/../b", "a\\b", "..\\x", "C:data", "x/..", "\\\\host\\share"]) {
    assert.deepEqual(planOf(tool(leaves)).refused, [{ what: "tool", name: "x", why: "A tool's folder leaves the plugin's own folder." }], leaves);
    assert.throws(() => inspectPlugin(plugin(t, tool(leaves))), /does not install it\. A tool's folder leaves the plugin's own folder\./, leaves);
  }
  assert.deepEqual(planOf(tool("a".repeat(LIMITS.cwd + 1))).refused.map((item) => item.why), ["A tool's folder is longer than 2000 characters."]);
});

test("a tool with a secret's value in its line is not started, and no earlier tool runs under its name", async (t) => {
  // The same name two times: the later tool is the one that is shown. When it is not started (a word of its line is
  // the value of a secret setting), the earlier tool of that name must not come back in its place.
  const folder = plugin(t, { "plugin.json": manifest({ userConfig: { ACCESS_TOKEN: { sensitive: true } } }), ".mcp.json": { mcpServers: { x: { command: "sh", args: ["-c", "touch /tmp/hidden"] } } }, "mcp.json": { mcpServers: { x: { command: "run", args: ["--key", "s3cret-value"] } } } });
  const { contents, config } = inspectPlugin(folder);
  assert.deepEqual(contents.mcpServers, [{ name: "x", kind: "local", command: "run", args: ["--key", "s3cret-value"], env: [] }]);
  const real = await started(t, folder, { config, values: { ACCESS_TOKEN: "s3cret-value" } });
  assert.equal(real.servers.size, 0);
  // A value that is no secret (a default such as a port) in a tool's line does not switch the tool off.
  const plain = plugin(t, { "plugin.json": manifest({ userConfig: { PORT: { default: "8080" } } }), ".mcp.json": { mcpServers: { web: { command: "serve", args: ["--port", "8080"] } } } });
  const seen = inspectPlugin(plain);
  assert.equal((await started(t, plain, { config: seen.config, values: { PORT: "8080" } })).servers.size, 1);
});

test("an event written two ways: the later one is shown and run. A hook for no known event is neither, and is said not to run", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest({ hooks: { hooks: { sessionStart: [{ command: "first" }], "session-start": [{ command: "second" }], session_end: [{ matcher: "*", hooks: [{ command: "matched" }] }], whenever: [{ command: "never" }], preToolUse: [[{ commands: [{ bash: "nested" }] }]] } } }),
    // The manifest has the hooks itself, so no hooks file is read.
    "hooks.json": { hooks: { sessionEnd: [{ command: "from the file" }] } },
  });
  // A matcher of "*" means all: that hook runs.
  assert.deepEqual(shown.hooks.map((hook) => [hook.event, hook.command]), [["sessionStart", "second"], ["sessionEnd", "matched"], ["preToolUse", "nested"]]);
  assert.deepEqual(shown.notRun, { count: 2, items: [{ what: "hook", name: "sessionStart", why: EARLIER }, { what: "hook", name: "whenever", why: NO_EVENT }] });
});

test("a matcher on any step down is a matcher: a hook with one never runs and is said not to, whether its commands are in a list or in an object; \"*\" and \"\" mean all", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest(),
    "hooks.json": {
      hooks: {
        sessionStart: [
          { hooks: { matcher: "*", command: "all-object" } },
          { hooks: { command: "plain" } },
          { match: "x", command: "touch /tmp/match" },
          { commands: { matcher: "a", bash: "touch /tmp/commands-matcher" } },
          { hooks: { hooks: { match: "deep", command: "touch /tmp/deeper" } } },
          { hooks: [{ matcher: "*", command: "all-list" }, { command: "listed" }, { matcher: "Bash", command: "touch /tmp/list-matcher" }] },
          { matcher: "", command: "all-empty" },
          { matcher: " * ", command: "all-padded" },
          { matcher: "Bash", hooks: [{ command: "touch /tmp/bash" }] },
        ],
      },
    },
  });
  assert.deepEqual(shown.hooks.map((hook) => hook.command), ["all-object", "plain", "all-list", "listed", "all-empty", "all-padded"]);
  // One line for the event, in the plan's words.
  assert.deepEqual(shown.notRun, { count: 1, items: [{ what: "hook", name: "sessionStart", why: NO_MATCHER }] });
  assert.match(inspectPlugin(plugin(t, { "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ matcher: "Bash", command: "x" }] } } })).warnings.join(" "), /does not run some hooks or tools/);
});

test("a Claude-format event name is the event it matches; an event with another name is not run and is said not to be", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest(),
    "hooks.json": { hooks: { UserPromptSubmit: [{ command: "prompt" }], Stop: [{ command: "stop" }], SubagentStop: [{ command: "sub" }], PreToolUse: [{ command: "pre" }], PostToolUse: [{ command: "post" }], SessionStart: [{ command: "start" }], SessionEnd: [{ command: "end" }], Notification: [{ command: "note" }], PreCompact: [{ command: "compact" }], MadeUp: [{ matcher: "Bash", command: "never" }], Empty: [] } },
  });
  assert.deepEqual(shown.hooks.map((hook) => [hook.event, hook.command]), [["userPromptSubmitted", "prompt"], ["agentStop", "stop"], ["subagentStop", "sub"], ["preToolUse", "pre"], ["postToolUse", "post"], ["sessionStart", "start"], ["sessionEnd", "end"]]);
  // An event with nothing under it has nothing to say.
  assert.deepEqual(shown.notRun.items, [{ what: "hook", name: "Notification", why: NO_EVENT }, { what: "hook", name: "PreCompact", why: NO_EVENT }, { what: "hook", name: "MadeUp", why: NO_EVENT }]);
});

test("the description never lists a hook that is not run, and the plan says each thing that is not run in its fixed words", () => {
  const plan = planOf({
    "plugin.json": manifest(),
    ".mcp.json": { mcpServers: { big: { command: "node", args: ["a".repeat(LIMITS.arg + 1)] } } },
    "hooks.json": { hooks: { preToolUse: [{ matcher: "Bash", command: "touch /tmp/never" }, { command: "runs" }], Notification: [{ command: "touch /tmp/other" }], ["x".repeat(LIMITS.name + 50)]: [{ command: "touch /tmp/long" }], sessionEnd: [{ command: "y".repeat(LIMITS.hookCommand + 1) }] } },
  });
  assert.deepEqual(plan.hooks.map((hook) => hook.command), ["runs"]);
  assert.deepEqual(plan.notRun, [{ what: "hook", name: "preToolUse", why: NO_MATCHER }, { what: "hook", name: "Notification", why: NO_EVENT }, { what: "hook", name: "x".repeat(LIMITS.name), why: NO_EVENT }]);
  assert.deepEqual(plan.refused, [{ what: "tool", name: "big", why: "A tool's argument is longer than 4000 characters." }, { what: "hook", name: "sessionEnd", why: "A hook's command is longer than 4000 characters." }]);
  const shown = describeStarts(plan);
  // `notRun` of the description is the plan's notRun, then its refused, with their number.
  assert.deepEqual(shown.notRun, { count: 5, items: [...plan.notRun, ...plan.refused] });
  assert.equal(plan.notRunCount, 3);
  assert.deepEqual(shown.hooks.map((hook) => hook.command), ["runs"]);
  for (const item of shown.notRun.items) if (item.what === "hook" && item.why === NO_EVENT) assert.equal(shown.hooks.some((hook) => hook.event === item.name), false);
  assert.equal("notRun" in describeStarts(planOf({ "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ command: "a" }] } } })), false, "nothing to say: no key");
});

test("what is not run is counted and its rows are limited: the plan stops adding rows at 2,000 and the description shows 40", (t) => {
  const hooks = Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => ["Unknown" + index, [{ command: "touch /tmp/never" }]]));
  const plan = planOf({ "plugin.json": manifest(), "hooks.json": { hooks } });
  assert.deepEqual([plan.notRunCount, plan.notRun.length, plan.hooks.length], [5_000, 2_000, 0]);
  const shown = describeStarts(plan);
  assert.equal(shown.notRun.count, 5_000);
  assert.deepEqual(shown.notRun.items, plan.notRun.slice(0, 40));
  assert.equal(shown.notRun.items.length, 40);
  assert.deepEqual(shown.notRun.items[0], { what: "hook", name: "Unknown0", why: NO_EVENT });
  // Whole description of such a plugin stays small in every state message.
  const { contents } = inspectPlugin(plugin(t, { "plugin.json": manifest(), "hooks.json": { hooks } }));
  assert.equal(contents.notRun.count, 5_000);
  assert.equal(contents.notRun.items.length, 40);
  assert.ok(JSON.stringify(contents).length < 20_000, String(JSON.stringify(contents).length));
  // Refused things are counted with them, and still come after the plan's rows.
  const withRefused = describeStarts({ ...planOf({ "plugin.json": manifest() }), notRun: [{ what: "hook", name: "a", why: NO_EVENT }], notRunCount: 1, refused: [{ what: "tool", name: "b", why: "Too long." }] });
  assert.deepEqual(withRefused.notRun, { count: 2, items: [{ what: "hook", name: "a", why: NO_EVENT }, { what: "tool", name: "b", why: "Too long." }] });
  // A plan from before the count (rows only) is counted by its rows.
  assert.equal(describeStarts({ servers: [], hooks: [], notRun: [{ what: "hook", name: "a", why: NO_EVENT }] }).notRun.count, 1);
  // The warning is made from the count or the rows, in either shape.
  const says = "Botkins does not run some hooks or tools of this plugin.";
  for (const shape of [[{ what: "hook" }], { count: 1, items: [] }, { count: 0, items: [{ what: "hook" }] }]) assert.equal(startWarnings([], [], [], shape).includes(says), true, JSON.stringify(shape));
  for (const shape of [[], { count: 0, items: [] }, undefined, null, {}]) assert.equal(startWarnings([], [], [], shape).includes(says), false, JSON.stringify(shape));
  assert.deepEqual(startWarnings([], [], [], shown.notRun), [says]);
});

test("each tool and hook that is not run is a row, with its fixed sentence", async (t) => {
  const NO_TYPE = "Botkins has no tool of this type.";
  const NO_TOOL_COMMAND = "This tool has no command.";
  const NO_ADDRESS = "This tool's address is not an http or https address.";
  const { shown } = await both(t, {
    "plugin.json": manifest(),
    ".mcp.json": {
      mcpServers: {
        socket: { type: "websocket", url: "wss://x.example" },
        numberType: { type: 5, command: "sh" },
        emptyType: { type: "", command: "sh" },
        bare: {},
        noCommand: { type: "stdio", args: ["-v"] },
        emptyCommand: { command: "" },
        numberCommand: { command: 7 },
        ftp: { type: "http", url: "ftp://x.example/mcp" },
        noUrl: { type: "sse" },
        noUrlHttp: { type: "streamable-http", url: 5 },
        socketUrl: { url: "wss://x.example/mcp" },
        fine: { command: "node" },
        local: { type: "local", command: "node" },
        web: { type: "streamable-http", url: "https://x.example/mcp" },
        eventsUrl: { type: "sse", serverUrl: "http://x.example/sse" },
      },
    },
  });
  assert.deepEqual(shown.mcpServers.map((server) => server.name), ["fine", "local", "web", "eventsUrl"]);
  assert.deepEqual(shown.notRun.items.map((item) => [item.what, item.name, item.why]), [
    ["tool", "socket", NO_TYPE],
    ["tool", "numberType", NO_TYPE],
    ["tool", "emptyType", NO_TYPE],
    ["tool", "bare", NO_TOOL_COMMAND],
    ["tool", "noCommand", NO_TOOL_COMMAND],
    ["tool", "emptyCommand", NO_TOOL_COMMAND],
    ["tool", "numberCommand", NO_TOOL_COMMAND],
    ["tool", "ftp", NO_ADDRESS],
    ["tool", "noUrl", NO_ADDRESS],
    ["tool", "noUrlHttp", NO_ADDRESS],
    ["tool", "socketUrl", NO_ADDRESS],
  ]);
  assert.equal(shown.notRun.count, 11);
  // An address too long to show whole is not run either, and the plugin is not installed, as for any value too long.
  const long = planOf({ "plugin.json": manifest(), ".mcp.json": { mcpServers: { far: { url: "https://x.example/" + "a".repeat(LIMITS.url) } } } });
  assert.deepEqual([long.servers.length, long.refused.map((item) => item.why)], [0, ["A tool's address is longer than 4000 characters."]]);
  // A tool that is not run takes nothing from an earlier one of its name: that one still starts.
  assert.deepEqual(planOf({ "plugin.json": manifest(), ".mcp.json": { mcpServers: { a: { command: "first" } } }, "mcp.json": { mcpServers: { a: { type: "websocket" } } } }).servers.map((server) => server.command), ["first"]);

  // A hook with no command: one row for the event, not one for each entry; a matcher stops it first, an unknown event says its own.
  const hooks = await both(t, {
    "plugin.json": manifest(),
    "hooks.json": { hooks: { sessionStart: [{ command: "runs" }, { type: "command" }, {}, 5, { hooks: {} }, { command: "  " }], sessionEnd: [{ type: "prompt", prompt: "x" }], agentStop: [{ matcher: "Bash", type: "command" }], "Made-Up": [{ type: "command" }], preToolUse: [] } },
  });
  assert.deepEqual(hooks.shown.hooks.map((hook) => [hook.event, hook.command]), [["sessionStart", "runs"]]);
  assert.deepEqual(hooks.shown.notRun.items, [{ what: "hook", name: "sessionStart", why: NO_COMMAND }, { what: "hook", name: "sessionEnd", why: NO_COMMAND }, { what: "hook", name: "agentStop", why: NO_MATCHER }]);

  // Two spellings of one event: a row for the earlier, as the plugin wrote it, and only the later runs.
  const spelling = await both(t, {
    "plugin.json": manifest(),
    "hooks.json": { hooks: { "session-start": [{ command: "first" }], SESSION_START: [{ command: "second" }], sessionStart: [{ command: "third" }], Stop: [{ command: "one" }], agentStop: [{ command: "two" }], preToolUse: [{ command: "alone" }] } },
  });
  assert.deepEqual(spelling.shown.hooks.map((hook) => [hook.event, hook.command]), [["sessionStart", "third"], ["agentStop", "two"], ["preToolUse", "alone"]]);
  assert.deepEqual(spelling.shown.notRun.items, [{ what: "hook", name: "session-start", why: EARLIER }, { what: "hook", name: "SESSION_START", why: EARLIER }, { what: "hook", name: "Stop", why: EARLIER }]);
  // The later spelling with nothing to run takes nothing from the earlier one.
  const kept = await both(t, { "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ command: "kept" }], "session-start": [{ matcher: "Bash", command: "no" }] } } });
  assert.deepEqual([kept.shown.hooks.map((hook) => hook.command), kept.shown.notRun.items.map((item) => item.why)], [["kept"], [NO_MATCHER]]);
});

test("lineOf is the command and each argument of a local tool, in the plan and in the description", () => {
  const plan = planOf({ "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", args: ["a", 3] }, y: { command: "sh" } } } });
  assert.deepEqual(plan.servers.map(lineOf), [["node", "a", "3"], ["sh"]]);
  assert.deepEqual(describeStarts(plan).mcpServers.map(lineOf), [["node", "a", "3"], ["sh"]]);
});

test("an environment name is refused by its family, and a short list is let back in, in any letter case", () => {
  const refused = ["PYTHONUSERBASE", "GEM_PATH", "GEM_HOME", "PHP_INI_SCAN_DIR", "PHPRC", "OPENSSL_CONF", "GCONV_PATH", "GIO_EXTRA_MODULES", "MAKEFILES", "MAKEFLAGS", "MAKELEVEL", "AWS_CONFIG_FILE", "KUBECONFIG", "GOFLAGS", "RUSTC_WRAPPER", "PUPPETEER_EXECUTABLE_PATH", "GIT_DIR", "GIT_WORK_TREE", "GIT_TEMPLATE_DIR", "GIT_AUTHOR_NAME", "SHELL", "BROWSER", "NODE_OPTIONS", "NPM_CONFIG_REGISTRY", "RUBYOPT", "PERL5LIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "DOTNET_STARTUP_HOOKS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "BASH_FUNC_x%%", "XDG_CONFIG_HOME", "LESSOPEN", "LUA_PATH", "ENV", "IFS", "PAGER", "EDITOR", "CLASSPATH", "PYTHONDONTWRITEBYTECODE", "NODE_PATH", "PATH", "HOME"];
  for (const name of refused) for (const form of [name, name.toLowerCase(), name[0] + name.slice(1).toLowerCase()]) assert.equal(envName(form), false, form);
  for (const name of ["NODE_ENV", "PYTHONUNBUFFERED", "PYTHONIOENCODING", "PYTHONUTF8", "NO_COLOR", "FORCE_COLOR", "LDAP_URL", "API_KEY", "MODE", "_x", "PHPSESSID", "MAKER_KEY"]) for (const form of [name, name.toLowerCase()]) assert.equal(envName(form), true, form);
  // The lists that the guide prints are these lists.
  assert.deepEqual(Object.keys(NAMES_NOT_SET).sort(), ["allowed", "names", "reserved", "starts"]);
  assert.deepEqual(NAMES_NOT_SET.allowed, ["NODE_ENV", "PYTHONUNBUFFERED", "PYTHONIOENCODING", "PYTHONUTF8", "NO_COLOR", "FORCE_COLOR"]);
  assert.equal(NAMES_NOT_SET.starts.includes("PYTHON"), true);
  assert.equal(NAMES_NOT_SET.names.includes("SHELL"), true);
  assert.equal(NAMES_NOT_SET.reserved.includes("PATH"), true);
  // PHP and make are no wide families: PHPSESSID and MAKER_KEY are nobody's loader.
  assert.deepEqual([NAMES_NOT_SET.starts.includes("PHP"), NAMES_NOT_SET.starts.includes("PHP_"), NAMES_NOT_SET.starts.includes("MAKE")], [false, true, false]);
  for (const name of ["PHPRC", "MAKEFLAGS", "MAKEFILES", "MAKELEVEL", "AWS_CONFIG_FILE", "KUBECONFIG", "GOFLAGS", "RUSTC_WRAPPER", "PUPPETEER_EXECUTABLE_PATH"]) assert.equal(NAMES_NOT_SET.names.includes(name), true, name);
});

test("whyNotSet says why a name is not set, in a fixed sentence, and null when it is set", () => {
  const loads = "can make a program load or start more than its command says.";
  assert.equal(whyNotSet("NPM_TOKEN"), "Botkins sets no name that starts with NPM_. Such a name " + loads);
  assert.equal(whyNotSet("java_home"), "Botkins sets no name that starts with JAVA_. Such a name " + loads);
  assert.equal(whyNotSet("PYTHONPATH"), "Botkins sets no name that starts with PYTHON. Such a name " + loads);
  assert.equal(whyNotSet("PHP_INI_SCAN_DIR"), "Botkins sets no name that starts with PHP_. Such a name " + loads);
  for (const name of ["PHPRC", "MAKEFLAGS", "kubeconfig", "GOFLAGS", "RUSTC_WRAPPER", "PAGER"]) assert.equal(whyNotSet(name), "Botkins does not set this name. It " + loads, name);
  for (const name of ["PATH", "home", "ELECTRON_RUN_AS_NODE"]) assert.equal(whyNotSet(name), "Botkins or the system sets this name.", name);
  for (const name of ["A-B", "", "1A", "N".repeat(129), 5, null]) assert.equal(whyNotSet(name), "This is not a name that can be set.", String(name));
  assert.equal(whyNotSet("MODE", 3), "Its value is not text.");
  assert.equal(whyNotSet("MODE", null), "Its value is not text.");
  // A name is judged before its value.
  assert.equal(whyNotSet("PATH", 3), "Botkins or the system sets this name.");
  for (const name of ["MODE", "NODE_ENV", "PHPSESSID", "MAKER_KEY"]) assert.equal(whyNotSet(name, "x"), null, name);
  assert.equal(envName("NPM_TOKEN"), false);
  assert.equal(envName("MODE"), true);
});

test("the files beside a command are in the description: the totals, the ones tools read by themselves first and marked, and not the skills", async (t) => {
  const files = {
    "plugin.json": manifest({ hooks: "hooks.json" }),
    "hooks.json": { hooks: { sessionStart: [{ command: "sh ${PLUGIN_ROOT}/scripts/run.sh" }] } },
    ".npmrc": "ignore-scripts=false",
    "node_modules/x/index.js": "x",
    Makefile: "all:",
    "scripts/run.sh": "#!/bin/sh",
    "skills/a/SKILL.md": "skill",
    "agents/a.md": "agent",
    "commands/run.md": "command",
  };
  const { contents, warnings } = inspectPlugin(plugin(t, files));
  const size = (name) => Buffer.byteLength(typeof files[name] === "string" ? files[name] : JSON.stringify(files[name]));
  const others = ["plugin.json", "hooks.json", ".npmrc", "node_modules/x/index.js", "Makefile", "scripts/run.sh"];
  assert.deepEqual(contents.otherFiles, {
    count: 6,
    bytes: others.reduce((total, name) => total + size(name), 0),
    files: [
      { path: ".npmrc", bytes: size(".npmrc"), config: true },
      { path: "Makefile", bytes: size("Makefile"), config: true },
      { path: "node_modules/", bytes: 1, files: 1, config: true },
      { path: "hooks.json", bytes: size("hooks.json") },
      { path: "plugin.json", bytes: size("plugin.json") },
      { path: "scripts/run.sh", bytes: size("scripts/run.sh") },
    ],
  });
  const own = "A command runs with the plugin's own files. Botkins shows each command it starts, and cannot show all that those files make it do. Install a plugin only from a source you trust.";
  assert.equal(warnings.filter((line) => line === own).length, 1);
  assert.deepEqual(startWarnings(contents.mcpServers, contents.hooks, warnings, contents.notRun), warnings, "made again from the lists, once");
  assert.equal(startWarnings([{ kind: "remote" }], [], []).includes(own), false, "a tool on the web runs no command of the plugin");
  // Many other files: all are counted, 40 are listed, the marked ones first.
  const many = { "plugin.json": manifest() };
  for (let index = 0; index < 60; index++) many["files/f" + String(index).padStart(2, "0") + ".txt"] = "x";
  many["zz/.nvmrc"] = "20";
  many["zz/vendor/lib.rb"] = "x";
  const big = inspectPlugin(plugin(t, many)).contents.otherFiles;
  assert.deepEqual([big.count, big.bytes, big.files.length], [63, 60 + 2 + 1 + Buffer.byteLength(JSON.stringify(many["plugin.json"])), 40]);
  assert.deepEqual(big.files.slice(0, 2).map((file) => [file.path, file.config]), [["zz/.nvmrc", true], ["zz/vendor/", true]]);
  assert.equal(big.files[2].path, "files/f00.txt");
  assert.deepEqual(inspectPlugin(plugin(t, { "plugin.json": manifest() })).contents.otherFiles.files.map((file) => file.path), ["plugin.json"]);
});

test("a folder of dependencies is one row and cannot crowd out the files beside it; a configuration file below skills is listed too", async (t) => {
  const files = { "plugin.json": manifest(), "package.json": "{}", "pyproject.toml": "[x]", "skills/x/SKILL.md": "s", "skills/x/package.json": "{}", "skills/x/notes.txt": "n" };
  for (let index = 0; index < 30; index++) {
    files["node_modules/a/f" + index + ".js"] = "xx";
    files["node_modules/b/f" + index + ".js"] = "xx";
  }
  const { contents } = inspectPlugin(plugin(t, files));
  const size = (name) => Buffer.byteLength(typeof files[name] === "string" ? files[name] : JSON.stringify(files[name]));
  const marked = contents.otherFiles.files.filter((file) => file.config);
  assert.deepEqual(marked, [
    { path: "node_modules/", bytes: 120, files: 60, config: true },
    { path: "package.json", bytes: 2, config: true },
    { path: "pyproject.toml", bytes: 3, config: true },
    { path: "skills/x/package.json", bytes: 2, config: true },
  ]);
  // The unmarked rest is the manifest alone: skills/x/SKILL.md and notes.txt are in the skills list.
  assert.deepEqual(contents.otherFiles.files.slice(4), [{ path: "plugin.json", bytes: size("plugin.json") }]);
  // The totals are over the files that are not in the lists: the 60 files, package.json, pyproject.toml and the manifest. skills/x/package.json is in a list.
  assert.deepEqual([contents.otherFiles.count, contents.otherFiles.bytes], [63, 120 + 2 + 3 + size("plugin.json")]);
  assert.equal(contents.skills.includes("skills/x/package.json"), true);
  // The top-most folder is the one: below it, a nested folder is no row of its own. A file's own name is no folder.
  assert.equal(dependencyFolder("a/node_modules/b/vendor/x.rb"), "a/node_modules/");
  assert.equal(dependencyFolder("Vendor/x.rb"), "Vendor/");
  assert.equal(dependencyFolder("vendor"), null);
  assert.equal(dependencyFolder("src/vendors/x.js"), null);
  for (const folder of ["node_modules", ".venv", "venv", "vendor", ".bundle", ".mvn", ".cargo"]) assert.equal(dependencyFolder("x/" + folder + "/y/z"), "x/" + folder + "/", folder);
  // Each row is a folder or a file, once: a Maven wrapper's settings and a Cargo config are in their folder's row.
  const more = inspectPlugin(plugin(t, { "plugin.json": manifest(), ".mvn/wrapper/a.properties": "a", ".mvn/jvm.config": "b", ".cargo/config.toml": "c", "src/.cargo/x": "d" })).contents.otherFiles.files;
  assert.deepEqual(more.filter((file) => file.config), [{ path: ".cargo/", bytes: 1, files: 1, config: true }, { path: ".mvn/", bytes: 2, files: 2, config: true }, { path: "src/.cargo/", bytes: 1, files: 1, config: true }]);
  // At most 40 rows, the marked first.
  const crowd = { "plugin.json": manifest() };
  for (let index = 0; index < 50; index++) crowd["d" + String(index).padStart(2, "0") + "/node_modules/x"] = "x";
  const rows = inspectPlugin(plugin(t, crowd)).contents.otherFiles;
  assert.deepEqual([rows.files.length, rows.count, rows.files.every((file) => file.config)], [40, 51, true]);
});

test("a file that tools read by themselves is marked: by its name in any letter case, or by a folder of packages", () => {
  for (const path of ["uv.toml", ".pnp.cjs", "pyvenv.cfg", "a/conftest.py", "pytest.ini", "mise.toml", "deno.jsonc", "DENO.JSONC", ".cargo/config.toml", "x/.mvn/maven.config", "a/.cargo/anything", ".npmrc", "package.json", "sub/Makefile", "GNUmakefile", "pyproject.toml", ".tool-versions", ".env", ".gitconfig", "a/b/.NVMRC", "php.ini", "node_modules/x/y.js", "a/.venv/bin/python", "venv/x", "vendor/x.rb", "a/.bundle/config", ".yarnrc.yml", ".pnpmfile.cjs"]) assert.equal(configFile(path), true, path);
  for (const path of ["run.sh", "scripts/run.sh", "plugin.json", "hooks.json", "README.md", "src/vendors/x.js", "node_modules.txt", "a/package.json.bak"]) assert.equal(configFile(path), false, path);
});

test("a description made by this reading has the mark, and a preview carries it", async (t) => {
  assert.equal(STARTS, 1);
  const catalog = new PluginCatalog(join(temp(t), "catalog"));
  const { preview } = await catalog.addFolder(plugin(t, { "plugin.json": manifest() }));
  assert.equal(preview.starts, 1);
});

test("a file is taken by its exact name and path, on a disk that is not exact too", async (t) => {
  // On a disk that takes "HOOKS.JSON" for "hooks.json", a look by path would find this file. The description never would.
  const { shown } = await both(t, { "plugin.json": manifest({ mcpServers: "./config/../tools.json" }), "HOOKS.JSON": { hooks: { sessionStart: [{ command: "touch /tmp/case" }] } }, "tools.json": { mcpServers: { x: { command: "sh" } } } });
  assert.deepEqual([shown.hooks, shown.mcpServers], [[], []], "a path with .. is no path of the plugin, and another case is another name");
  const named = await both(t, { "plugin.json": manifest({ mcpServers: "./config//tools.json", hooks: "config/hooks.json" }), "config/tools.json": { mcpServers: { x: { command: "sh" } } }, "config/hooks.json": { hooks: { sessionStart: [{ command: "named" }] } }, "hooks.json": { hooks: { sessionStart: [{ command: "not this one" }] } } });
  assert.deepEqual([named.shown.hooks.map((hook) => hook.command), named.shown.mcpServers.map((server) => server.command)], [["named"], ["sh"]]);
  // Two names that such a disk would keep as one file are refused: the copy could not hold both.
  assert.throws(() => inspectPlugin(plugin(t, process.platform === "linux" ? { "plugin.json": manifest(), "skills/a/SKILL.md": "x", "Skills/a/SKILL.md": "y" } : { "plugin.json": manifest(), "bad\\name": "x" })), /differ only by case|unsafe name/);
});

test("the files that start things read no plugin file by themselves: a list of words, and a limit", () => {
  // This is a list of strings over a few files, and it is no more. A reader in a third file, or a
  // name built from parts, passes it. What holds the rule is the tests above, which go the two
  // real ways (the description, and a session) for each fixture and compare them. This one only
  // catches the plain case: a file name or a key that comes back in a file that must not have it.
  // `plugins.mjs` and `integrations.mjs` are checked for the two file names alone: both have
  // other uses of other words (`workingDirectory:` is the SDK's name in the second), which are
  // not a reading of a plugin.
  const words = ["hooks.json", "mcp.json", ".claude-plugin/plugin.json", "powershell", "timeoutSec", "serverUrl", "workingDirectory:"];
  const files = { "plugin-runtime.mjs": words, "plugin-catalog.mjs": words, "plugins.mjs": ["hooks.json", "mcp.json"], "integrations.mjs": ["hooks.json", "mcp.json"] };
  for (const [file, checked] of Object.entries(files)) {
    const source = readFileSync(new URL("../desktop/" + file, import.meta.url), "utf8");
    for (const word of checked) {
      if (word === "workingDirectory:" && file === "plugin-runtime.mjs") continue; // the name the runtime's own answer has
      assert.equal(source.includes(word), false, file + " has " + JSON.stringify(word));
    }
    if (words === checked) assert.match(source, /plugin-reading\.mjs/);
  }
});

test("a plugin's language servers are only named: one reading, the first file that is there, and a file that is not JSON gives none", async (t) => {
  const named = (files) => inspectPlugin(plugin(t, { "plugin.json": manifest(), ...files })).lspServers;
  assert.deepEqual(named({ "lsp.json": { lspServers: { zeta: { command: "z" }, alpha: {} } } }), ["alpha", "zeta"]);
  assert.deepEqual(named({ ".lsp.json": { b: {}, a: {} } }), ["a", "b"]);
  assert.deepEqual(named({ ".claude-plugin/lsp.json": { only: {} } }), ["only"]);
  assert.deepEqual(inspectPlugin(plugin(t, { "plugin.json": manifest(), "lsp.json": "{ not json", "hooks.json": { hooks: {} } })).contents.lspServers, undefined, "no throw, no names");
  assert.equal(named({ "lsp.json": "[1,2]" }), undefined);
  assert.equal(named({ "lsp.json": "{ nope", ".lsp.json": { later: {} } }), undefined, "the first file that is there is the one that counts");
  assert.equal(named({ "lsp.json": { lspServers: ["a"] } }), undefined);
  const read = (value) => filesReader(new Map([["lsp.json", { bytes: Buffer.from(JSON.stringify(value)) }]]));
  assert.deepEqual(lspNames(read({ ["n".repeat(LIMITS.name + 1)]: {}, kept: {} })), ["kept"], "a name too long is dropped");
  assert.equal(lspNames(read(Object.fromEntries(Array.from({ length: 150 }, (_, index) => ["s" + String(index).padStart(3, "0"), {}])))).length, 100);
  assert.deepEqual(lspNames(filesReader(new Map())), []);
  // Nothing is started from them: no tool and no hook comes from a language-server file.
  const { contents } = inspectPlugin(plugin(t, { "plugin.json": manifest(), "lsp.json": { s: { command: "touch /tmp/lsp" } } }));
  assert.deepEqual([contents.mcpServers, contents.hooks], [[], []]);
});

test("the description lists exactly the skills, agents and commands that go on to the runtime", async (t) => {
  const big = "x".repeat(1_000_001);
  const deep = Array.from({ length: 9 }, (_, index) => "d" + index).join("/");
  const folder = plugin(t, {
    "plugin.json": manifest(),
    "skills/a/SKILL.md": "A",
    "skills/a/helper.py": "print()",
    "skills/.hidden/SKILL.md": "H",
    "skills/a/.secret": "S",
    "skills/node_modules/m/index.js": "M",
    "skills/a/huge.bin": big,
    ["skills/" + deep + "/f.md"]: "too deep",
    "agents/review.md": "R",
    "agents/notes.txt": "not Markdown",
    "agents/.draft.md": "dot",
    "agents/node_modules/x.md": "X",
    "agents/team/lead.md": "L",
    "commands/run.md": "C",
    "commands/run.sh": "#!/bin/sh",
    "commands/.hidden": "H",
    "commands/node_modules/c.md": "N",
    "other/skills/x.md": "not at the top",
  });
  const { contents } = inspectPlugin(folder);
  assert.deepEqual(contents.skills, ["skills/a/SKILL.md", "skills/a/helper.py"]);
  assert.deepEqual(contents.agents, ["agents/review.md", "agents/team/lead.md"]);
  assert.deepEqual(contents.commands, ["commands/run.md", "commands/run.sh"]);
  // The session's folder holds these files and no others.
  const session = pluginSession([{ id: "p", folder, config: [] }], { dir: temp(t), chatId: "c", botId: "b" });
  const held = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) (entry.isDirectory() ? walk(dir, prefix + entry.name + "/") : held.push(prefix + entry.name));
  };
  for (const top of ["skills", "agents", "commands"]) if (existsSync(join(session.directories[0], top))) walk(session.directories[0], top + "/");
  assert.deepEqual(held.sort(), [...contents.skills, ...contents.agents, ...contents.commands].sort());
});

test("an agent file's own tools and hooks do not reach the runtime: its header is written again", async (t) => {
  const folder = plugin(t, {
    "plugin.json": manifest(),
    "agents/review.agent.md": "---\nname: Reviewer\ndescription: >\n  Reviews code\n  with care\ntools: [\"read\", 'edit']\nmodel: fast-1\nmcp-servers:\n  hidden:\n    command: sh\n    args: [\"-c\", \"touch /tmp/agent\"]\nhooks:\n  sessionStart: [{ command: \"touch /tmp/agent-hook\" }]\n---\nReview the change.\n",
    "agents/odd.md": "  ---\nmcp-servers: { hidden: { command: sh } }\n---\nBody",
    "agents/other.yaml": "mcp-servers: { hidden: { command: sh } }",
    "agents/nested/deep.md": "---\ndescription: 'It''s deep'\nhooks: {}\n---\nDeep.",
  });
  const session = pluginSession([{ id: "p", folder, config: [] }], { dir: temp(t), chatId: "c", botId: "b" });
  const projected = (name) => readFileSync(join(session.directories[0], "agents", name), "utf8");
  assert.equal(projected("review.agent.md"), "---\nname: \"Reviewer\"\ndescription: \"Reviews code with care\"\nmodel: \"fast-1\"\ntools: [\"read\",\"edit\"]\n---\nReview the change.\n");
  // A header after blank space is a header too: it is taken away with the rest.
  assert.equal(projected("odd.md"), "---\ndescription: \"\"\n---\nBody");
  assert.equal(projected("nested/deep.md"), "---\ndescription: \"It's deep\"\n---\nDeep.");
  assert.throws(() => projected("other.yaml"), /ENOENT/, "only agent files in Markdown go on");
  assert.equal(plainAgentFile("No header at all."), "---\ndescription: \"\"\n---\nNo header at all.");
});

test("an installed copy is the reviewed bytes or it is not: a file changed, added or taken away is seen", async (t) => {
  const source = plugin(t, { "plugin.json": manifest(), "hooks.json": { hooks: {} }, "skills/a/SKILL.md": "A" });
  const { folder, revision } = await new PluginCatalog(join(temp(t), "catalog")).addFolder(source);
  assert.equal(verifySnapshot(folder, revision), true);
  assert.equal(verifySnapshot(folder, "0".repeat(64)), false);
  const before = snapshotStamp(folder);
  assert.equal(snapshotStamp(folder), before, "nothing changed: the same mark, and no file is read again");
  // The copy's files are read-only, and its folders are the user's own: a file can be added, and one can be put in a file's place.
  writeFileSync(join(folder, "skills", "a", "extra.md"), "new");
  assert.notEqual(snapshotStamp(folder), before);
  assert.equal(verifySnapshot(folder, revision), false);
  rmSync(join(folder, "skills", "a", "extra.md"));
  assert.equal(verifySnapshot(folder, revision), true);
  rmSync(join(folder, "hooks.json"));
  writeFileSync(join(folder, "hooks.json"), JSON.stringify({ hooks: { sessionStart: [{ command: "touch /tmp/later" }] } }));
  assert.notEqual(snapshotStamp(folder), before);
  assert.equal(verifySnapshot(folder, revision), false);
  symlinkSync(source, join(folder, "link"));
  assert.equal(verifySnapshot(folder, revision), false, "a link in the copy");
  assert.equal(snapshotStamp(join(folder, "missing")), null);
});

test("a .git entry in an installed copy is seen: the copy is not the reviewed bytes", async (t) => {
  // A source folder a person works in has a .git, and it is left out of what is reviewed. A copy
  // has none, so one that appears is not Botkins' own: a hook shown as `git status` would take its config.
  const source = plugin(t, { "plugin.json": manifest(), ".git/config": "[core]", "hooks.json": { hooks: { sessionStart: [{ command: "git status" }] } }, "skills/a/SKILL.md": "A" });
  const { folder, revision } = await new PluginCatalog(join(temp(t), "catalog")).addFolder(source);
  assert.equal(existsSync(join(folder, ".git")), false, "the source's .git is not copied");
  assert.equal(verifySnapshot(folder, revision), true);
  const before = snapshotStamp(folder);
  for (const planted of [".git", "skills/a/.git", "skills/.GIT"]) {
    const path = join(folder, ...planted.split("/"));
    mkdirSync(path);
    assert.notEqual(snapshotStamp(folder), before, planted + " is in the mark of the copy");
    assert.equal(verifySnapshot(folder, revision), false, "a .git folder: " + planted);
    rmSync(path, { recursive: true });
    writeFileSync(path, "gitdir: /elsewhere");
    assert.equal(verifySnapshot(folder, revision), false, "a .git file: " + planted);
    rmSync(path);
    assert.equal(verifySnapshot(folder, revision), true, planted + " taken away");
  }
});

test("a check that could not be done is not \"changed\": a missing folder is false, a file that cannot be read is null", async (t) => {
  const source = plugin(t, { "plugin.json": manifest(), "hooks.json": { hooks: {} } });
  const { folder, revision } = await new PluginCatalog(join(temp(t), "catalog")).addFolder(source);
  assert.equal(verifySnapshot(join(temp(t), "missing"), revision), false);
  assert.equal(verifySnapshot(join(folder, "hooks.json"), revision), false, "a file is no folder");
  assert.equal(verifySnapshot(folder, undefined), false);
  assert.equal(verifySnapshot(folder, revision), true);
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const file = join(folder, "hooks.json");
  chmodSync(file, 0o000);
  // The folder may be gone by then: the temporary folder is taken away first.
  t.after(() => { try { chmodSync(file, 0o644); } catch {} });
  assert.equal(verifySnapshot(folder, revision), null, "unreadable: the check says nothing about the copy");
  chmodSync(file, 0o444);
  assert.equal(verifySnapshot(folder, revision), true);
});
