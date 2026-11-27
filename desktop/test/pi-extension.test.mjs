// Botkins' extension inside Pi (desktop/providers/pi/extension.mjs), against a stand-in for Pi's
// extension API. Nothing here starts Pi or reaches a model.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "botkins-pi-extension-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, "session.json");
writeFileSync(file, JSON.stringify({ providers: [], servers: {}, prompt: "You are Testy." }));
process.env.BOTKINS_PI_SESSION = file;
const { default: botkins, botkinsPrompt } = await import("../desktop/providers/pi/extension.mjs");

// Pi 1.0.0's own prompt, cut short: preamble, then each section in its tag.
const PI = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "<tools>\n- read: Read file contents\n</tools>",
  "<rules>\n- Be concise in your responses\n</rules>",
  "<docs>\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- When asked about: extensions (docs/extensions.md), themes (docs/themes.md)\n</docs>",
  "<cwd>\n/work\n</cwd>",
].join("\n\n");

test("botkinsPrompt leaves out Pi's documentation section and keeps the rest in order", () => {
  const out = botkinsPrompt(PI, "You are Testy.");
  assert.ok(!out.includes("<docs>") && !out.includes("Pi documentation"));
  assert.equal(out, [PI.split("\n\n<docs>")[0], "<cwd>\n/work\n</cwd>", "You are Testy."].join("\n\n"));
  assert.equal(botkinsPrompt("No sections here."), "No sections here.", "a prompt without the section is as it was");
});

test("the extension sends its own prompt on every run, with no bot instructions as well", async () => {
  const handlers = {};
  botkins({ registerProvider() {}, registerMcpServer() {}, unregisterMcpServer() {}, on: (name, handler) => (handlers[name] = handler) });
  const result = await handlers.before_agent_start({ systemPrompt: PI });
  assert.ok(result.systemPrompt.endsWith("You are Testy."));
  assert.ok(!result.systemPrompt.includes("<docs>"));
  writeFileSync(file, JSON.stringify({ providers: [], servers: {}, prompt: "" }));
  const bare = await handlers.before_agent_start({ systemPrompt: PI });
  assert.ok(bare && !bare.systemPrompt.includes("<docs>"), "the section goes even when the bot has no instructions");
});

test("a server a turn leaves out stays registered, and only a changed server is registered again", async () => {
  // Taking a server's tools away for a turn and bringing them back would change the tool list the
  // model is sent (and its order), and with it everything a model caches after the tools.
  const crm = { url: "https://crm.example/mcp", headers: { Authorization: "Bearer one" }, exposure: "direct" };
  const docs = { command: "docs-server", args: [], exposure: "direct" };
  writeFileSync(file, JSON.stringify({ providers: [], servers: { crm, docs }, prompt: "You are Testy." }));
  const handlers = {};
  const registered = [];
  const unregistered = [];
  botkins({ registerProvider() {}, registerMcpServer: (name, config) => registered.push([name, config.headers?.Authorization ?? null]), unregisterMcpServer: (name) => unregistered.push(name), on: (name, handler) => (handlers[name] = handler) });
  assert.deepEqual(registered, [["crm", "Bearer one"], ["docs", null]]);
  // A turn without docs (a member who may not use it): nothing is taken away.
  writeFileSync(file, JSON.stringify({ providers: [], servers: { crm }, prompt: "You are Testy." }));
  await handlers.before_agent_start({ systemPrompt: PI });
  // docs is back, unchanged: nothing is registered again.
  writeFileSync(file, JSON.stringify({ providers: [], servers: { crm, docs }, prompt: "You are Testy." }));
  await handlers.before_agent_start({ systemPrompt: PI });
  assert.deepEqual(unregistered, []);
  assert.equal(registered.length, 2);
  // A renewed sign-in token changes crm: it alone is registered again.
  writeFileSync(file, JSON.stringify({ providers: [], servers: { crm: { ...crm, headers: { Authorization: "Bearer two" } }, docs }, prompt: "You are Testy." }));
  await handlers.before_agent_start({ systemPrompt: PI });
  assert.deepEqual(registered.slice(2), [["crm", "Bearer two"]]);
  writeFileSync(file, JSON.stringify({ providers: [], servers: {}, prompt: "You are Testy." }));
});

test("arguments a plugin's hook changed replace the call's input in place, and a refusal carries its reason", async () => {
  const handlers = {};
  botkins({ registerProvider() {}, registerMcpServer() {}, on: (name, handler) => (handlers[name] = handler) });
  const ui = (choice, detail) => ({ ui: { select: async (_title, options) => (assert.ok(options.includes("more")), choice), input: async (title) => (assert.match(title, /^botkins:detail "c1"$/), JSON.stringify(detail)) } });
  const event = { toolCallId: "c1", toolName: "bash", input: { command: "ls", timeout: 5 } };
  // Pi runs the object it passed in; OMP runs the `input` a handler returns. Both are the hook's.
  const result = await handlers.tool_call(event, ui("more", { input: { command: "ls -la" } }));
  assert.deepEqual(event.input, { command: "ls -la" });
  assert.deepEqual(result, { input: { command: "ls -la" } });
  assert.deepEqual(await handlers.tool_call({ toolCallId: "c1", toolName: "bash", input: {} }, ui("more", { deny: true, reason: "Not rm." })), { block: true, reason: "Not rm." });
  assert.equal((await handlers.tool_call({ toolCallId: "c1", toolName: "bash", input: {} }, ui("deny"))).block, true);
  assert.equal(await handlers.tool_call({ toolCallId: "c1", toolName: "bash", input: {} }, ui("allow")), undefined);
});

test("Botkins' own tools ask only when a plugin's preToolUse hook is to see every call", async () => {
  const handlers = {};
  botkins({ registerProvider() {}, registerMcpServer() {}, on: (name, handler) => (handlers[name] = handler) });
  let asked = 0;
  const ctx = { ui: { select: async () => (asked++, "allow") } };
  await handlers.tool_call({ toolCallId: "c1", toolName: "mcp__botkins__wiki_read", input: {} }, ctx);
  assert.equal(asked, 0);
  writeFileSync(file, JSON.stringify({ providers: [], servers: {}, prompt: "You are Testy.", preToolUse: true }));
  await handlers.tool_call({ toolCallId: "c1", toolName: "mcp__botkins__wiki_read", input: {} }, ctx);
  assert.equal(asked, 1);
  writeFileSync(file, JSON.stringify({ providers: [], servers: {}, prompt: "You are Testy." }));
});

test("a configured server whose name starts with botkins_ still asks", async () => {
  const handlers = {};
  botkins({ on: (name, handler) => (handlers[name] = handler) });
  const result = await handlers.tool_call({
    toolName: "mcp__botkins_example__echo", mcpServerName: "botkins_example", mcpToolName: "echo", input: {},
  }, { ui: { select: async () => "deny" } });
  assert.equal(result?.block, true);
});
