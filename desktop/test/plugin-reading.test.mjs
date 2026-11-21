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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectPlugin, PluginCatalog, snapshotStamp, verifySnapshot } from "../desktop/plugin-catalog.mjs";
import { BUILT_IN_VALUES, envName, EVENTS, filesReader, LIMITS, lspNames, PLACEHOLDER, pluginStarts, startWarnings } from "../desktop/plugin-reading.mjs";
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
      if (server.type !== "stdio") return [sdkName, { kind: "remote", url: server.url, headers: Object.keys(server.headers) }];
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
  const asRun = ({ envNotSet: _notSet, ...item }) => (item.env ? { ...item, env: filled(item.env) } : item);
  assert.deepEqual(real.hooks, shown.hooks.map(asRun), "the hooks that run are the hooks that are shown");
  assert.deepEqual([...real.servers.keys()].sort(), shown.mcpServers.map((server) => pluginServerName("p", server.name)).sort(), "the tools that start are the tools that are shown");
  for (const { name, oauth: _signIn, ...server } of shown.mcpServers) assert.deepEqual(real.servers.get(pluginServerName("p", name)), asRun(server), "the tool " + name + " starts as it is shown");
  return { folder, shown, real };
}
const manifest = (more = {}) => ({ name: "fixture", version: "1.0.0", ...more });

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
    { name: "docs", kind: "remote", url: "https://docs.example/mcp", headers: ["Authorization"], oauth: true },
    { name: "files", kind: "local", command: "npx", args: ["-y", "@scope/pkg", "--root", "${PLUGIN_ROOT}"], env: [{ name: "TOKEN", value: "${API_KEY}" }, { name: "MODE", value: "fast" }], cwd: "/srv/data" },
  ]);
  assert.deepEqual(shown.hooks, [{ event: "sessionStart", command: "node \"${PLUGIN_ROOT}/start.mjs\"", env: [{ name: "LEVEL", value: "${API_KEY}" }, { name: "HERE", value: "${PLUGIN_ROOT}/x" }], timeoutSec: 3 }]);
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
  const set = [{ name: "GOOD", value: "1" }, { name: "MODE", value: "fast" }];
  assert.deepEqual([shown.hooks[0].env, shown.mcpServers[0].env], [set, set]);
  assert.deepEqual([shown.hooks[0].envNotSet, shown.mcpServers[0].envNotSet], [notSet, notSet]);
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
  for (const name of ["GOOD", "API_KEY", "_x", "LDAP_URL", "GIT_AUTHOR_NAME", "MODE"]) assert.equal(envName(name), true, name);
});

test("the plan has, for a local tool and for a hook, its env as name to written value and the names that are not set", () => {
  const plan = planOf({
    "plugin.json": manifest(),
    ".mcp.json": { mcpServers: { tool: { command: "node", args: ["a", 3, true], env: { MODE: "${A}-x", PATH: "/evil", N: 1 }, cwd: "server/bin" }, bare: { command: "node" } } },
    "hooks.json": { hooks: { sessionStart: [{ command: "true", env: { MODE: "fast", GIT_SSH_COMMAND: "x" }, timeoutSec: 2 }, { command: "false" }] } },
  });
  assert.deepEqual(plan.servers, [
    { name: "tool", kind: "local", command: "node", args: ["a", "3", "true"], env: { MODE: "${A}-x" }, envNotSet: ["PATH", "N"], cwd: "server/bin" },
    { name: "bare", kind: "local", command: "node", args: [], env: {}, envNotSet: [], cwd: null },
  ]);
  assert.deepEqual(plan.hooks, [
    { event: "sessionStart", command: "true", env: { MODE: "fast" }, envNotSet: ["GIT_SSH_COMMAND"], timeoutMs: 2_000 },
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
    assert.deepEqual(planOf(input).refused, [reason, reason]);
    assert.throws(() => inspectPlugin(plugin(t, input)), new RegExp("cannot be shown whole, so Botkins does not install it: " + reason));
    // An installed copy from before this rule: what cannot be shown is not started.
    const real = await started(t, plugin(t, input));
    assert.deepEqual([real.hooks.map((hook) => hook.command), [...real.servers.keys()]], [["first"], [pluginServerName("p", "ok")]]);
  }
  // A long value under a name that is not set is no value to show: the name is only said not to be set.
  const notSet = planOf(files({ PATH: "v".repeat(LIMITS.value + 1) }));
  assert.deepEqual([notSet.refused, notSet.servers[1].envNotSet], [[], ["PATH"]]);
});

test("an argument that is a number or true/false is its text; any other that is not text refuses the tool with a sentence that says so", async (t) => {
  const { shown } = await both(t, { "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", args: ["--port", 3000, true, false, 1.5, -2, "text"] } } } });
  assert.deepEqual(shown.mcpServers[0].args, ["--port", "3000", "true", "false", "1.5", "-2", "text"]);
  const refusing = (args) => planOf({ "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", args } } } }).refused;
  const notText = "a tool's argument is not text, a number or true/false";
  for (const bad of [null, {}, ["a"], "a\0b"]) assert.deepEqual(refusing(["ok", bad]), [notText]);
  assert.throws(() => inspectPlugin(plugin(t, { "plugin.json": manifest(), ".mcp.json": { mcpServers: { x: { command: "node", args: [null] } } } })), /does not install it: a tool's argument is not text, a number or true\/false/);
  assert.deepEqual(refusing(["a".repeat(LIMITS.arg + 1)]), ["a tool's argument is longer than 4000 characters"]);
  assert.deepEqual(refusing(Array.from({ length: LIMITS.args + 1 }, () => "a")), ["a tool has more than 200 arguments"]);
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
    assert.deepEqual(planOf(tool(leaves)).refused, ["a tool's folder leaves the plugin's own folder"], leaves);
    assert.throws(() => inspectPlugin(plugin(t, tool(leaves))), /does not install it: a tool's folder leaves the plugin's own folder/, leaves);
  }
  assert.deepEqual(planOf(tool("a".repeat(LIMITS.cwd + 1))).refused, ["a tool's folder is longer than 2000 characters"]);
});

test("a tool that a value of the person's would be a word of is not started, and no earlier tool runs under its name", async (t) => {
  // A plugin knows its own default values. A second tool with one in its line is dropped when it
  // starts; the first tool of that name must not come back in its place.
  const folder = plugin(t, { "plugin.json": manifest({ userConfig: { MODE: { default: "safe" } } }), ".mcp.json": { mcpServers: { x: { command: "sh", args: ["-c", "touch /tmp/hidden"] } } }, "mcp.json": { mcpServers: { x: { command: "safe" } } } });
  const { contents, config } = inspectPlugin(folder);
  assert.deepEqual(contents.mcpServers, [{ name: "x", kind: "local", command: "safe", args: [], env: [] }]);
  const real = await started(t, folder, { config, values: { MODE: "safe" } });
  assert.equal(real.servers.size, 0);
});

test("an event written two ways: the later one is shown and run. A hook with a matcher, or for no known event, is neither", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest({ hooks: { hooks: { sessionStart: [{ command: "first" }], "session-start": [{ command: "second" }], session_end: [{ matcher: "*", hooks: [{ command: "matched" }] }], whenever: [{ command: "never" }], preToolUse: [[{ commands: [{ bash: "nested" }] }]] } } }),
    // The manifest has the hooks itself, so no hooks file is read.
    "hooks.json": { hooks: { sessionEnd: [{ command: "from the file" }] } },
  });
  assert.deepEqual(shown.hooks.map((hook) => [hook.event, hook.command]), [["sessionStart", "second"], ["preToolUse", "nested"]]);
});

test("a matcher on any step down is a matcher: a hook with one never runs, whether its commands are in a list or in an object", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest(),
    "hooks.json": {
      hooks: {
        sessionStart: [
          { hooks: { matcher: "*", command: "touch /tmp/object-matcher" } },
          { hooks: { command: "plain" } },
          { match: "x", command: "touch /tmp/match" },
          { commands: { matcher: "a", bash: "touch /tmp/commands-matcher" } },
          { hooks: { hooks: { match: "deep", command: "touch /tmp/deeper" } } },
          { hooks: [{ matcher: "*", command: "touch /tmp/list-matcher" }, { command: "listed" }] },
        ],
      },
    },
  });
  assert.deepEqual(shown.hooks.map((hook) => hook.command), ["plain", "listed"]);
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
  // A header this code does not see as one is below the new header, where the runtime reads text and no keys.
  assert.equal(projected("odd.md"), "---\ndescription: \"\"\n---\n  ---\nmcp-servers: { hidden: { command: sh } }\n---\nBody");
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
