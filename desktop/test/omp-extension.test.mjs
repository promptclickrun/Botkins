// Botkins' OMP extension against a stand-in extension API. It keeps OMP's MCP system in charge
// of server connections and only supplies plan providers, prompts and Botkins approvals.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "botkins-omp-extension-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, "session.json");
writeFileSync(file, JSON.stringify({
  providers: [{ name: "botkins-claude", config: { api: "anthropic-messages" } }],
  servers: { files: { type: "http", url: "https://mcp.example" } },
  prompt: "You are Testy.",
}));
process.env.BOTKINS_OMP_SESSION = file;
const { default: botkins, botkinsPrompt } = await import("../desktop/providers/omp/extension.mjs");

const OMP = [
  "You are an expert coding assistant operating inside omp.",
  "<tools>\n- read: Read file contents\n</tools>",
  "<docs>\nOMP documentation (read only when asked about omp itself):\n- docs/extensions.md\n</docs>",
  "- mcp://<uri>: MCP resource.\n- omp://: harness docs, AVOID unless asked.\n\n# Tool Inventory\nread, bash",
  "<cwd>\n/work\n</cwd>",
].join("\n\n");

test("OMP's extension registers plans, inventory hooks, and leaves MCP registration to OMP", async () => {
  const handlers = {};
  const providers = [];
  const registeredServers = [];
  const statuses = [];
  let tools = [{ name: "mcp__botkins_wiki_read", description: "Read wiki", mcpServerName: "botkins", mcpToolName: "wiki_read" }];
  let active = ["mcp__botkins_wiki_read"];
  botkins({
    registerProvider: (name, config) => providers.push([name, config]),
    registerMcpServer: (name, config) => registeredServers.push([name, config]),
    getAllTools: () => tools,
    getActiveTools: () => active,
    on: (name, handler) => (handlers[name] = handler),
  });
  assert.deepEqual(providers, [["botkins-claude", { api: "anthropic-messages" }]]);
  assert.deepEqual(registeredServers, [], "OMP owns MCP server registration via mcp.json, not registerMcpServer");
  assert.deepEqual(Object.keys(handlers).sort(), [
    "agent_end",
    "before_agent_start",
    "session_shutdown",
    "session_start",
    "tool_call",
    "tool_execution_end",
    "turn_end",
    "turn_start",
  ]);

  const ctx = { ui: { setStatus: (key, text) => statuses.push({ key, payload: JSON.parse(text) }) } };
  handlers.session_start({}, ctx);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].key, "botkins:inventory");
  assert.deepEqual(statuses[0].payload.tools, [
    { name: "mcp__botkins_wiki_read", description: "Read wiki", active: true, mcpServerName: "botkins", mcpToolName: "wiki_read" },
  ]);

  // Unchanged inventory does not spam duplicate status updates on turn lifecycle hooks.
  handlers.turn_start({}, ctx);
  handlers.turn_end({}, ctx);
  assert.equal(statuses.length, 1);

  // Mid-session MCP connection updates are published on lifecycle hooks without registering MCP servers.
  tools = [
    ...tools,
    { name: "mcp__files_get", description: "Fetch file", mcpServerName: "files", mcpToolName: "get" },
  ];
  handlers.tool_execution_end({}, ctx);
  assert.equal(statuses.length, 2);
  assert.deepEqual(
    statuses[1].payload.tools.map((t) => ({ name: t.name, active: t.active, server: t.mcpServerName })),
    [
      { name: "mcp__botkins_wiki_read", active: true, server: "botkins" },
      { name: "mcp__files_get", active: false, server: "files" },
    ],
  );

  // Activating the tool refreshes on agent_end / before_agent_start; OMP still never calls registerMcpServer.
  active = ["mcp__botkins_wiki_read", "mcp__files_get"];
  handlers.agent_end({}, ctx);
  assert.equal(statuses.length, 3);
  assert.equal(statuses[2].payload.tools[1].active, true);
  await handlers.before_agent_start({ systemPrompt: OMP.split("\n\n") }, ctx);
  assert.deepEqual(registeredServers, []);

  // session_shutdown clears the background watch interval cleanly.
  handlers.session_shutdown({}, ctx);
  tools = [];
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.equal(statuses.length, 3, "no background inventory updates fire after session_shutdown");
});

test("the extension removes OMP's docs and asks Botkins with MCP metadata", async () => {
  const handlers = {};
  const requests = [];
  botkins({
    registerProvider() {},
    getAllTools: () => [
      { name: "mcp__files_get", mcpServerName: "files", mcpToolName: "get", sourceInfo: { source: "mcp", path: "<mcp:mcp__files_get>" } },
      { name: "mcp__botkins_wiki_read", mcpServerName: "botkins", mcpToolName: "wiki_read", sourceInfo: { source: "mcp", path: "<mcp:mcp__botkins_wiki_read>" } },
    ],
    on: (name, handler) => (handlers[name] = handler),
  });
  const run = await handlers.before_agent_start({ systemPrompt: OMP.split("\n\n") });
  assert.equal(run.systemPrompt, [
    OMP.split("\n\n<docs>")[0],
    "- mcp://<uri>: MCP resource.\n\n# Tool Inventory\nread, bash",
    "<cwd>\n/work\n</cwd>",
    "You are Testy.",
  ].join("\n\n"));

  const ui = { select: async (title) => (requests.push(title), "allow") };
  const event = { toolCallId: "one", toolName: "mcp__files_get", input: { id: "x" } };
  assert.equal(await handlers.tool_call(event, { ui }), undefined);
  assert.match(requests[0], /^botkins:permission /);
  const payload = JSON.parse(requests[0].slice("botkins:permission ".length));
  assert.deepEqual(payload, { ...event, mcpServerName: "files", mcpToolName: "get", registryServer: "files", registryTool: "get" });

  assert.equal(await handlers.tool_call({ ...event, toolName: "mcp__botkins_wiki_read" }, { ui }), undefined);
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].slice("botkins:permission ".length)).registryServer, "botkins");
  assert.equal(botkinsPrompt("No docs."), "No docs.");
});
