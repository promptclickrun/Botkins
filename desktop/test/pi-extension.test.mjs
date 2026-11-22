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
