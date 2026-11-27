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
writeFileSync(file, JSON.stringify({ providers: [{ name: "botkins-claude", config: { api: "anthropic-messages" } }], prompt: "You are Testy." }));
process.env.BOTKINS_OMP_SESSION = file;
const { default: botkins, botkinsPrompt } = await import("../desktop/providers/omp/extension.mjs");

const OMP = [
  "You are an expert coding assistant operating inside omp.",
  "<tools>\n- read: Read file contents\n</tools>",
  "<docs>\nOMP documentation (read only when asked about omp itself):\n- docs/extensions.md\n</docs>",
  "- mcp://<uri>: MCP resource.\n- omp://: harness docs, AVOID unless asked.\n\n# Tool Inventory\nread, bash",
  "<cwd>\n/work\n</cwd>",
].join("\n\n");

test("OMP's extension registers plans and leaves MCP registration to OMP", () => {
  const handlers = {};
  const providers = [];
  botkins({ registerProvider: (name, config) => providers.push([name, config]), on: (name, handler) => (handlers[name] = handler) });
  assert.deepEqual(providers, [["botkins-claude", { api: "anthropic-messages" }]]);
  assert.deepEqual(Object.keys(handlers).sort(), ["before_agent_start", "tool_call"]);
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
