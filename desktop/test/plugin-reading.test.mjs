// What a plugin is shown to start is what it starts.
//
// The description a person agrees to (desktop/plugin-catalog.mjs) and the runtime that starts a
// plugin's tools and hooks (desktop/plugin-runtime.mjs) take both from one reading of the
// plugin's files (desktop/plugin-reading.mjs). These tests go the two real ways for each
// fixture: the description as an install shows it, and a session as the runtime opens it, with
// the hooks' commands caught in place of being run. Everything the session would start must be
// in the description, word for word: the command, each argument, the folder, and the names of
// the environment values. A key that one side reads and the other does not fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectPlugin, PluginCatalog, snapshotStamp, verifySnapshot } from "../desktop/plugin-catalog.mjs";
import { BUILT_IN_VALUES, envName, EVENTS, LIMITS, RESERVED } from "../desktop/plugin-reading.mjs";
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

/** What a session starts for a plugin folder, in the description's own shape. The hooks' commands are caught, not run. */
async function started(t, folder, { config = [], values = {} } = {}) {
  const ran = [];
  const environments = [];
  const session = pluginSession([{ id: "p", folder, config, values }], { dir: temp(t), chatId: "c", botId: "b" }, { run: async (command, _input, options) => void ran.push({ command, options }) });
  const hooks = [];
  for (const [sdkName, handler] of Object.entries(session.hooks.handlers)) {
    ran.length = 0;
    await handler({});
    const event = Object.keys(EVENTS).find((name) => EVENTS[name] === sdkName);
    // (The names Botkins sets itself are not the plugin's: its own values, and the reserved names, which no plugin can set.)
    for (const { command, options } of ran) {
      hooks.push({ event, command, env: Object.keys(options.env).filter((name) => !RESERVED.has(name) && !BUILT_IN_VALUES.includes(name)), timeoutSec: options.timeoutMs / 1_000 });
      environments.push(options.env);
    }
  }
  const servers = new Map(
    Object.entries(session.mcpServers).map(([sdkName, server]) => {
      if (server.type !== "stdio") return [sdkName, { kind: "remote", url: server.url, headers: Object.keys(server.headers) }];
      const spec = JSON.parse(Buffer.from(server.args[1], "base64url").toString("utf8"));
      assert.deepEqual(Object.keys(server.env).filter((name) => name !== "ELECTRON_RUN_AS_NODE"), spec.envKeys, "the environment handed to the launcher is the list in its line");
      return [sdkName, { kind: "local", command: spec.command, args: spec.args, env: spec.envKeys, ...(server.workingDirectory !== folder && { cwd: server.workingDirectory }) }];
    }),
  );
  return { hooks, servers, environments, session };
}

/** The description of a folder and what a session starts for it. Fails unless they are the same, word for word. */
async function both(t, files, options) {
  const folder = plugin(t, files);
  const shown = inspectPlugin(folder).contents;
  const real = await started(t, folder, options);
  assert.deepEqual(real.hooks, shown.hooks, "the hooks that run are the hooks that are shown");
  assert.deepEqual([...real.servers.keys()].sort(), shown.mcpServers.map((server) => pluginServerName("p", server.name)).sort(), "the tools that start are the tools that are shown");
  for (const { name, oauth: _signIn, ...server } of shown.mcpServers) assert.deepEqual(real.servers.get(pluginServerName("p", name)), server, "the tool " + name + " starts as it is shown");
  return { folder, shown, real };
}
const manifest = (more = {}) => ({ name: "fixture", version: "1.0.0", ...more });

test("an ordinary plugin: a tool on the web, a program with its words, folder and value names, and a hook", async (t) => {
  const { shown } = await both(t, {
    "plugin.json": manifest({ userConfig: { API_KEY: { sensitive: true } } }),
    ".mcp.json": {
      mcpServers: {
        docs: { type: "http", url: "https://docs.example/mcp", headers: { Authorization: "Bearer ${API_KEY}" }, oauth: true },
        files: { command: "npx", args: ["-y", "@scope/pkg", "--root", "${PLUGIN_ROOT}"], env: { TOKEN: "${API_KEY}", MODE: "fast" }, cwd: "/srv/data" },
      },
    },
    "hooks/hooks.json": { hooks: { sessionStart: [{ type: "command", command: "node \"${PLUGIN_ROOT}/start.mjs\"", env: { LEVEL: "${API_KEY}" }, timeoutSec: 3 }] } },
  });
  // A program is shown with every word of its line, its folder and the names of its values: not "npx" alone.
  assert.deepEqual(shown.mcpServers, [
    { name: "docs", kind: "remote", url: "https://docs.example/mcp", headers: ["Authorization"], oauth: true },
    { name: "files", kind: "local", command: "npx", args: ["-y", "@scope/pkg", "--root", "${PLUGIN_ROOT}"], env: ["TOKEN", "MODE"], cwd: "/srv/data" },
  ]);
  assert.deepEqual(shown.hooks, [{ event: "sessionStart", command: "node \"${PLUGIN_ROOT}/start.mjs\"", env: ["LEVEL"], timeoutSec: 3 }]);
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

test("a plugin sets no name that makes a program load something more, and what it sets is shown by name", async (t) => {
  const env = { GOOD: "1", NODE_OPTIONS: "--require ./x.js", node_options: "--require ./x.js", BASH_ENV: "./x", ENV: "./x", DYLD_INSERT_LIBRARIES: "./x", LD_PRELOAD: "./x", PYTHONPATH: ".", PATH: "/evil", HOME: "/evil", "BAD NAME": "x", NUMBER: 3 };
  const { shown, real } = await both(t, { "plugin.json": manifest(), "hooks.json": { hooks: { sessionStart: [{ command: "node -v", env }] } }, ".mcp.json": { mcpServers: { tool: { command: "node", args: ["-v"], env } } } });
  assert.deepEqual([shown.hooks[0].env, shown.mcpServers[0].env], [["GOOD"], ["GOOD"]]);
  // The reserved names keep the values Botkins gives them, in the hook's environment and in the tool's.
  const [hookEnv] = real.environments;
  const [toolEnv] = Object.values(real.session.mcpServers).map((server) => server.env);
  for (const given of [hookEnv, toolEnv]) for (const name of ["NODE_OPTIONS", "node_options", "BASH_ENV", "ENV", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "PYTHONPATH", "HOME", "BAD NAME", "NUMBER"]) assert.equal(name in given, false, name);
  assert.notEqual(hookEnv.PATH, "/evil");
  assert.equal("PATH" in toolEnv, false);
  for (const name of ["NODE_OPTIONS", "Node_Options", "BASH_ENV", "ENV", "DYLD_LIBRARY_PATH", "LD_AUDIT", "PYTHONSTARTUP", "PERL5OPT", "RUBYOPT", "JAVA_TOOL_OPTIONS", "PATH", "HOME", "ELECTRON_RUN_AS_NODE", "A-B", ""]) assert.equal(envName(name), false, name);
  for (const name of ["GOOD", "API_KEY", "_x", "LDAP_URL"]) assert.equal(envName(name), true, name);
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

test("a file is taken by its exact name and path, on a disk that is not exact too", async (t) => {
  // On a disk that takes "HOOKS.JSON" for "hooks.json", a look by path would find this file. The description never would.
  const { shown } = await both(t, { "plugin.json": manifest({ mcpServers: "./config/../tools.json" }), "HOOKS.JSON": { hooks: { sessionStart: [{ command: "touch /tmp/case" }] } }, "tools.json": { mcpServers: { x: { command: "sh" } } } });
  assert.deepEqual([shown.hooks, shown.mcpServers], [[], []], "a path with .. is no path of the plugin, and another case is another name");
  const named = await both(t, { "plugin.json": manifest({ mcpServers: "./config//tools.json", hooks: "config/hooks.json" }), "config/tools.json": { mcpServers: { x: { command: "sh" } } }, "config/hooks.json": { hooks: { sessionStart: [{ command: "named" }] } }, "hooks.json": { hooks: { sessionStart: [{ command: "not this one" }] } } });
  assert.deepEqual([named.shown.hooks.map((hook) => hook.command), named.shown.mcpServers.map((server) => server.command)], [["named"], ["sh"]]);
  // Two names that such a disk would keep as one file are refused: the copy could not hold both.
  assert.throws(() => inspectPlugin(plugin(t, process.platform === "linux" ? { "plugin.json": manifest(), "skills/a/SKILL.md": "x", "Skills/a/SKILL.md": "y" } : { "plugin.json": manifest(), "bad\\name": "x" })), /differ only by case|unsafe name/);
});

test("the two files that start things read no plugin file by themselves", () => {
  // The names of a plugin's files and the keys of a command are in the one reading. If one of these comes back here, somebody reads a plugin a second way.
  for (const file of ["plugin-runtime.mjs", "plugin-catalog.mjs"]) {
    const source = readFileSync(new URL("../desktop/" + file, import.meta.url), "utf8");
    for (const word of ["hooks.json", "mcp.json", ".claude-plugin/plugin.json", "powershell", "timeoutSec", "serverUrl", "workingDirectory:"]) {
      if (word === "workingDirectory:" && file === "plugin-runtime.mjs") continue; // the name the runtime's own answer has
      assert.equal(source.includes(word), false, file + " has " + JSON.stringify(word));
    }
    assert.match(source, /plugin-reading\.mjs/);
  }
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
