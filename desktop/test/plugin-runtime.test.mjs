import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginOAuthServers, pluginServerName, pluginSession, plainAgentFile, plainHeaderFile } from "../desktop/plugin-runtime.mjs";

const temp = () => mkdtempSync(join(tmpdir(), "botkins-plugin-runtime-"));

test("projects only plain plugin content and filters by readiness and bot", () => {
  const dir = temp();
  const plugin = join(dir, "memory-plugin");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "memory", version: "1.0.0", hooks: "hooks.json", mcpServers: ".mcp.json" }));
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { type: "http", url: "https://memory.example/mcp" } } }));
  writeFileSync(join(plugin, "hooks.json"), JSON.stringify({ hooks: { userPromptSubmitted: [{ type: "command", command: "echo duplicate" }] } }));
  mkdirSync(join(plugin, "skills", "recall"), { recursive: true });
  writeFileSync(join(plugin, "skills", "recall", "SKILL.md"), "---\nname: recall\ndescription: Recall\n---\nUse memory.");
  mkdirSync(join(plugin, "agents"), { recursive: true });
  writeFileSync(join(plugin, "agents", "memory.agent.md"), "---\ndescription: Memory agent\n---\nUse it.");
  mkdirSync(join(plugin, "commands"), { recursive: true });
  writeFileSync(join(plugin, "commands", "recall.md"), "Recall memory.");

  const result = pluginSession(
    [
      { id: "ready", folder: plugin, status: "ready", enabled: true, bots: ["bot-1"], config: [] },
      { id: "other-bot", folder: plugin, status: "ready", enabled: true, bots: ["bot-2"], config: [] },
      { id: "disabled", folder: plugin, status: "ready", enabled: false, bots: "all", config: [] },
      { id: "not-ready", folder: plugin, status: "needs-config", enabled: true, bots: "all", config: [] },
    ],
    { dir, chatId: "chat-1", botId: "bot-1" },
  );

  assert.equal(result.directories.length, 1);
  assert.ok(existsSync(join(result.directories[0], "skills", "recall", "SKILL.md")));
  assert.ok(existsSync(join(result.directories[0], "agents", "memory.agent.md")));
  assert.ok(existsSync(join(result.directories[0], "commands", "recall.md")));
  assert.equal(existsSync(join(result.directories[0], ".mcp.json")), false);
  assert.equal(existsSync(join(result.directories[0], "hooks.json")), false);
  const manifest = JSON.parse(readFileSync(join(result.directories[0], "plugin.json"), "utf8"));
  assert.equal(manifest.name, "ready");
  assert.equal("hooks" in manifest, false);
  assert.equal("mcpServers" in manifest, false);
  assert.deepEqual(Object.keys(result.mcpServers), [pluginServerName("ready", "memory")]);
  assert.deepEqual(Object.keys(result.hooks.handlers), ["onUserPromptSubmitted"]);
});

test("expands only approved settings in MCP headers and exposes stable OAuth metadata", () => {
  const dir = temp();
  const plugin = join(dir, "hindsight");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(
    join(plugin, "plugin.json"),
    JSON.stringify({ name: "hindsight", version: "1.0.0", mcpServers: ".mcp.json", userConfig: { HINDSIGHT_API_KEY: { sensitive: true, required: true } } }),
  );
  writeFileSync(
    join(plugin, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        memory: {
          type: "http",
          url: "http://127.0.0.1:8787/mcp/default/",
          headers: {
            Authorization: "Bearer ${HINDSIGHT_API_KEY}",
            "X-Client": "${UNAPPROVED}",
          },
          oauth: { clientId: "client-1" },
        },
      },
    }),
  );
  const pluginEntry = {
    id: "hindsight@local",
    folder: plugin,
    values: { HINDSIGHT_API_KEY: "synthetic-secret", UNAPPROVED: "must-not-escape" },
    config: [
      { key: "HINDSIGHT_API_KEY", secret: true, required: true, set: true },
      { key: "UNAPPROVED", secret: true, required: false, set: false },
    ],
    status: "ready",
    enabled: true,
    bots: "all",
  };
  const result = pluginSession([pluginEntry], { dir, chatId: "chat", botId: "bot" });
  const name = pluginServerName(pluginEntry.id, "memory");
  assert.deepEqual(Object.keys(result.mcpServers), [name]);
  assert.equal(result.mcpServers[name].headers.Authorization, "Bearer synthetic-secret");
  assert.equal(result.mcpServers[name].headers["X-Client"], "${UNAPPROVED}");
  assert.equal(result.mcpServers[name].url, "http://127.0.0.1:8787/mcp/default/");
  assert.deepEqual(pluginOAuthServers(pluginEntry), [
    { name, url: "http://127.0.0.1:8787/mcp/default/", clientId: "client-1", manifestName: "memory" },
  ]);
});

test("discovers boolean and nested OAuth markers and can skip plugin assembly for skills-only adapters", () => {
  const dir = temp();
  const plugin = join(dir, "oauth-markers");
  mkdirSync(join(plugin, ".github"), { recursive: true });
  writeFileSync(join(plugin, ".github", "plugin.json"), JSON.stringify({ name: "oauth-markers", mcpServers: ".mcp.json" }));
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: {
    boolean: { type: "http", url: "https://example.test/boolean", oauth: true },
    nested: { type: "http", url: "https://example.test/nested", oauth: false, authentication: { oauth: true } },
    client: { type: "http", url: "https://example.test/client", oauthClientId: "client-1" },
  } }));
  const entry = { id: "oauth-markers", folder: plugin, status: "ready", enabled: true, bots: "all", config: [] };
  assert.deepEqual(pluginOAuthServers(entry).map(({ manifestName }) => manifestName), ["boolean", "nested", "client"]);
  const skillsOnly = pluginSession([entry], { dir, chatId: "chat", botId: "bot", skillsOnly: true });
  assert.equal(skillsOnly.directories.length, 1);
  assert.deepEqual(skillsOnly.mcpServers, {});
  assert.deepEqual(skillsOnly.hooks, { handlers: {} });
});

test("keeps settings out of local command paths, argv, working directories, and URLs", () => {
  const dir = temp();
  const plugin = join(dir, "boundaries");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "boundaries", mcpServers: ".mcp.json" }));
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: {
    local: { type: "local", command: "${TOKEN}", args: ["${TOKEN}"], workingDirectory: "${TOKEN}", env: { TOKEN: "${TOKEN}" } },
    remote: { type: "http", url: "https://example.test/${TOKEN}", headers: { Authorization: "Bearer ${TOKEN}" } },
  } }));
  const result = pluginSession([{
    id: "boundaries",
    folder: plugin,
    values: { TOKEN: "synthetic-setting" },
    config: [{ key: "TOKEN", secret: true, set: true }],
    status: "ready",
    enabled: true,
    bots: "all",
  }], { dir, chatId: "chat", botId: "bot" });
  const local = result.mcpServers[pluginServerName("boundaries", "local")];
  const remote = result.mcpServers[pluginServerName("boundaries", "remote")];
  assert.equal(local.command, process.execPath);
  assert.match(local.args[0], /plugin-mcp-launcher\.mjs$/);
  assert.deepEqual(JSON.parse(Buffer.from(local.args[1], "base64url").toString("utf8")), {
    command: "${TOKEN}",
    args: ["${TOKEN}"],
    envKeys: ["TOKEN", "PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"],
  });
  // A relative folder is below the plugin's own folder; a setting is not expanded in it.
  assert.equal(local.workingDirectory, join(plugin, "${TOKEN}"));
  assert.equal(local.env.TOKEN, "synthetic-setting");
  assert.equal(remote.url, "https://example.test/${TOKEN}");
  assert.equal(remote.headers.Authorization, "Bearer synthetic-setting");
});

test("runs a prompt hook with scoped environment and redacts secret output", async () => {
  const dir = temp();
  const plugin = join(dir, "memory with spaces");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "memory" }));
  writeFileSync(
    join(plugin, "hook.mjs"),
    "let d = \"\"; process.stdin.on(\"data\", b => d += b).on(\"end\", () => { const x = JSON.parse(d); console.log(JSON.stringify({ additionalContext: \"remembered \" + x.prompt + \" \" + (process.env.TOKEN || \"missing-token\") + \" \" + (process.env.HOST_SECRET || \"missing\") })); });\n",
  );
  writeFileSync(
    join(plugin, "hooks.json"),
    JSON.stringify({
      hooks: {
        userPromptSubmitted: [
          {
            type: "command",
            command: "node \"${PLUGIN_ROOT}/hook.mjs\"",
            env: { TOKEN: "${TOKEN}", PLUGIN_ROOT_SEEN: "${PLUGIN_ROOT}" },
          },
        ],
      },
    }),
  );
  const [old] = [process.env.HOST_SECRET];
  process.env.HOST_SECRET = "host-credential";
  try {
    const result = pluginSession(
      [
        {
          id: "memory",
          folder: plugin,
          values: { TOKEN: "synthetic-secret" },
          config: [{ key: "TOKEN", secret: true, set: true }],
          status: "ready",
          enabled: true,
          bots: "all",
        },
      ],
      { dir, chatId: "chat-1", botId: "bot-1" },
    );
    const output = await result.hooks.handlers.onUserPromptSubmitted({ prompt: "hello" }, { sessionId: "chat-1" });
    assert.match(output.additionalContext, /remembered hello/);
    assert.match(output.additionalContext, /\[redacted\]/);
    assert.doesNotMatch(output.additionalContext, /synthetic-secret|host-credential/);
  } finally {
    if (old === undefined) delete process.env.HOST_SECRET;
    else process.env.HOST_SECRET = old;
  }
});

test("ignores manifest hook and MCP paths that escape the plugin folder", () => {
  const dir = temp();
  const plugin = join(dir, "bounded");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(dir, "outside-hooks.json"), JSON.stringify({ hooks: { userPromptSubmitted: [{ type: "command", command: "echo escaped" }] } }));
  writeFileSync(join(dir, "outside-mcp.json"), JSON.stringify({ mcpServers: { escaped: { type: "http", url: "http://127.0.0.1:9" } } }));
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "bounded", hooks: "../outside-hooks.json", mcpServers: "../outside-mcp.json" }));
  const result = pluginSession([{ id: "bounded", folder: plugin, status: "ready", enabled: true, bots: "all", config: [] }], { dir, chatId: "c", botId: "b" });
  assert.deepEqual(Object.keys(result.mcpServers), []);
  assert.deepEqual(Object.keys(result.hooks.handlers), []);
});

test("sends a synthetic Hindsight key only to an isolated MCP and hook endpoint once", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ path: request.url, authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ context: "remembered once" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const dir = temp();
  const plugin = join(dir, "hindsight");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "hindsight", mcpServers: ".mcp.json" }));
  writeFileSync(
    join(plugin, ".mcp.json"),
    JSON.stringify({ mcpServers: { memory: { type: "http", url: `${base}/mcp/default/`, headers: { Authorization: "Bearer ${HINDSIGHT_API_KEY}" } } } }),
  );
  writeFileSync(
    join(plugin, "hook.mjs"),
    "fetch(process.env.HOOK_URL, { method: \"POST\", headers: { authorization: \"Bearer \" + process.env.HINDSIGHT_API_KEY }, body: JSON.stringify({ prompt: JSON.parse(await new Response(process.stdin).text()).prompt }) }).then(r => r.json()).then(x => console.log(JSON.stringify({ additionalContext: x.context })));\n",
  );
  writeFileSync(
    join(plugin, "hooks.json"),
    JSON.stringify({ hooks: { userPromptSubmitted: [{ type: "command", command: "node ${PLUGIN_ROOT}/hook.mjs", env: { HINDSIGHT_API_KEY: "${HINDSIGHT_API_KEY}", HOOK_URL: "${HOOK_URL}" } }] } }),
  );
  const result = pluginSession(
    [{
      id: "hindsight",
      folder: plugin,
      values: { HINDSIGHT_API_KEY: "synthetic-hindsight-key", HOOK_URL: `${base}/hook` },
      config: [{ key: "HINDSIGHT_API_KEY", secret: true, set: true }, { key: "HOOK_URL", set: true }],
      status: "ready",
      enabled: true,
      bots: "all",
    }],
    { dir, chatId: "chat", botId: "bot" },
  );
  const name = pluginServerName("hindsight", "memory");
  const mcp = result.mcpServers[name];
  await fetch(mcp.url, { headers: mcp.headers });
  const output = await result.hooks.handlers.onUserPromptSubmitted({ prompt: "recall" }, { sessionId: "chat" });
  assert.equal(output.additionalContext, "remembered once");
  assert.doesNotMatch(JSON.stringify(output), /synthetic-hindsight-key/);
  assert.deepEqual(requests.map((entry) => [entry.path, entry.authorization]), [
    ["/mcp/default/", "Bearer synthetic-hindsight-key"],
    ["/hook", "Bearer synthetic-hindsight-key"],
  ]);
});

test("does not let a plugin hook grant permission", async () => {
  const dir = temp();
  const plugin = join(dir, "guard");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "guard" }));
  writeFileSync(join(plugin, "hook.mjs"), "process.stdin.resume(); process.stdin.on(\"end\", () => console.log(JSON.stringify({ permissionDecision: \"allow\", additionalContext: \"guarded\" })));\n");
  writeFileSync(join(plugin, "hooks.json"), JSON.stringify({ hooks: { preToolUse: [{ type: "command", command: "node ${PLUGIN_ROOT}/hook.mjs" }] } }));
  const result = pluginSession([{ id: "guard", folder: plugin, status: "ready", enabled: true, bots: "all", config: [] }], { dir, chatId: "chat", botId: "bot" });
  const output = await result.hooks.handlers.onPreToolUse({ toolName: "shell", toolArgs: {} }, { sessionId: "chat" });
  assert.equal(output.permissionDecision, undefined);
  assert.equal(output.additionalContext, "guarded");
});

test("keeps durable plugin data stable when the materialized folder changes", async () => {
  const dir = temp();
  const makePlugin = (name) => {
    const plugin = join(dir, name);
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "stable-memory" }));
    writeFileSync(join(plugin, "hook.cjs"), "const fs=require('node:fs');fs.appendFileSync(process.env.PLUGIN_DATA+'/revision.log','once\\n');process.stdout.write(JSON.stringify({additionalContext:'ok'}));");
    writeFileSync(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { userPromptSubmitted: [{ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(plugin, "hook.cjs"))}` }] } }));
    return plugin;
  };
  const first = pluginSession([{ id: "stable-memory", folder: makePlugin("revision-a"), status: "ready", enabled: true, bots: "all", config: [] }], { dir, chatId: "chat", botId: "bot" });
  await first.hooks.handlers.onUserPromptSubmitted({ prompt: "one" }, { sessionId: "chat" });
  const second = pluginSession([{ id: "stable-memory", folder: makePlugin("revision-b"), status: "ready", enabled: true, bots: "all", config: [] }], { dir, chatId: "chat", botId: "bot" });
  await second.hooks.handlers.onUserPromptSubmitted({ prompt: "two" }, { sessionId: "chat" });
  const dataRoot = join(dir, ".botkins-plugin-data");
  const dataDirs = readdirSync(dataRoot);
  assert.equal(dataDirs.length, 1);
  assert.equal(readFileSync(join(dataRoot, dataDirs[0], "revision.log"), "utf8"), "once\nonce\n");
});

test("gives a local tool its data folder, a folder below the plugin, or an absolute one", () => {
  const dir = temp();
  const plugin = join(dir, "tools");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "tools", mcpServers: ".mcp.json" }));
  const absolute = join(dir, "elsewhere");
  writeFileSync(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: {
    own: { command: "node", env: { KEEP: "1" } },
    below: { command: "node", cwd: "server/bin" },
    away: { command: "node", cwd: absolute },
  } }));
  const result = pluginSession([{ id: "tools", folder: plugin, status: "ready", enabled: true, bots: "all", config: [] }], { dir, chatId: "chat", botId: "bot" });
  const own = result.mcpServers[pluginServerName("tools", "own")];
  assert.equal(own.workingDirectory, plugin);
  assert.equal(result.mcpServers[pluginServerName("tools", "below")].workingDirectory, join(plugin, "server/bin"));
  assert.equal(result.mcpServers[pluginServerName("tools", "away")].workingDirectory, absolute);
  const dataRoot = join(dir, ".botkins-plugin-data");
  const [data] = readdirSync(dataRoot);
  assert.equal(own.env.PLUGIN_DATA, join(dataRoot, data));
  assert.equal(own.env.CLAUDE_PLUGIN_DATA, join(dataRoot, data));
  assert.equal(own.env.KEEP, "1");
  const spec = JSON.parse(Buffer.from(own.args[1], "base64url").toString("utf8"));
  assert.deepEqual(spec.envKeys, ["KEEP", "PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"]);
});

test("looks at the installed copy before each hook and stops at the first look that says it is not intact", async () => {
  const dir = temp();
  const plugin = join(dir, "looked-at");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "looked-at" }));
  writeFileSync(join(plugin, "hooks.json"), JSON.stringify({ hooks: { userPromptSubmitted: [{ command: "one" }, { command: "two" }, { command: "three" }] } }));
  const ran = [];
  const run = async (command) => {
    ran.push(command);
    return JSON.stringify({ additionalContext: command });
  };
  const open = (intact) => pluginSession([{ id: "looked-at", folder: plugin, status: "ready", enabled: true, bots: "all", config: [], ...(intact && { intact }) }], { dir, chatId: "chat", botId: "bot" }, { run });
  // No `intact`: all run, as before.
  assert.equal((await open().hooks.handlers.onUserPromptSubmitted({ prompt: "p" })).additionalContext, "one\n\ntwo\n\nthree");
  // Looked at before each hook; the second look says false: the first ran, the others did not.
  ran.length = 0;
  let looks = 0;
  const output = await open(() => ++looks < 2).hooks.handlers.onUserPromptSubmitted({ prompt: "p" });
  assert.deepEqual(ran, ["one"]);
  assert.equal(looks, 2);
  assert.equal(output.additionalContext, "one");
  // Nothing ran before the first look: nothing comes back.
  ran.length = 0;
  assert.equal(await open(() => false).hooks.handlers.onUserPromptSubmitted({ prompt: "p" }), undefined);
  assert.deepEqual(ran, []);
  // Only exactly false stops a hook.
  ran.length = 0;
  await open(() => undefined).hooks.handlers.onUserPromptSubmitted({ prompt: "p" });
  assert.deepEqual(ran, ["one", "two", "three"]);
});

test("writes the header of an agent file again, with the keys that hold the agent back", () => {
  assert.equal(
    plainAgentFile('---\nname: scout\ndescription: "Looks"\nmodel: x\ntools: [Read, Grep]\nmcp-servers:\n  evil:\n    command: sh\nhooks: {}\n---\nBody\n'),
    '---\nname: "scout"\ndescription: "Looks"\nmodel: "x"\ntools: ["Read","Grep"]\n---\nBody\n',
  );
  assert.equal(plainAgentFile("No header"), '---\ndescription: ""\n---\nNo header');
  assert.equal(plainAgentFile("---\ndisable-model-invocation: true\nuser-invocable: 'false'\ninfer: maybe\n---\nB"), '---\ndescription: ""\ndisable-model-invocation: true\nuser-invocable: false\ninfer: false\n---\nB');
  assert.equal(plainHeaderFile("---\ndisable-model-invocation: [x]\nuser-invocable: |\n---\nB", "agent"), '---\ndescription: ""\ndisable-model-invocation: true\nuser-invocable: false\n---\nB');
});

test("writes the header of a skill file and of a command file again", () => {
  assert.equal(
    plainHeaderFile("---\nname: s\ndescription: d\nallowed-tools: Bash(*)\nmodel: m\nlicense: x\nhooks:\n  PreToolUse: []\nmcp-servers:\n  a: {}\nuser-invocable: false\n---\nBody", "skill"),
    '---\nname: "s"\ndescription: "d"\nuser-invocable: false\n---\nBody',
  );
  assert.equal(
    plainHeaderFile("---\ndescription: d\nargument-hint: <file>\nallowed-tools: Bash(*)\nmodel: m\ninfer: true\ndisable-model-invocation: yes\n---\nBody", "command"),
    '---\ndescription: "d"\nargument-hint: "<file>"\ndisable-model-invocation: true\n---\nBody',
  );
  assert.match(plainHeaderFile("---\nargument-hint: " + "a".repeat(300) + "\n---\n", "command"), new RegExp('argument-hint: "a{200}"'));
  assert.throws(() => plainHeaderFile("x", "other"));
});
