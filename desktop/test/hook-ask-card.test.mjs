// The card for a plugin hook's question (a permission request of the kind "hook"): the first line
// is the command that the person agrees to, and the hook's own words are the label.
import test from "node:test";
import assert from "node:assert/strict";
import { describeRequest } from "../desktop/providers/copilot/permissions.mjs";

test("a hook's question shows the command in the first line, the hook's words as the label, and says that a plugin asks", () => {
  const card = describeRequest({ kind: "hook", toolName: "bash", toolArgs: { command: "rm -rf build && npm run deploy", description: "Deploy the site" }, hookMessage: "The plugin release-guard asks you before a deploy." });
  assert.equal(card.kind, "hook");
  assert.equal(card.preview, "rm -rf build && npm run deploy", "the command, whole, where a client looks for what is run");
  assert.equal(card.label, "The plugin release-guard asks you before a deploy.");
  assert.equal(card.title, "A plugin asks before bash runs");
  // The detail stays whole, and nothing can be remembered for such a question.
  assert.match(card.detail, /rm -rf build && npm run deploy/);
  assert.match(card.detail, /release-guard/);
  assert.equal(card.remember, null);
  assert.equal(card.readOnly, false);
});

test("a hook's question for a tool with no command shows the tool's arguments, and one with no words has a plain label", () => {
  const card = describeRequest({ kind: "hook", toolName: "create", toolArgs: { path: "/work/a.txt", file_text: "hello" } });
  assert.match(card.preview, /\/work\/a\.txt/);
  assert.match(card.preview, /hello/);
  assert.equal(card.label, "A plugin's hook asks you first");
  assert.equal(card.title, "A plugin asks before create runs");
  assert.equal(describeRequest({ kind: "hook", toolName: "bash" }).preview, "");
  // A long message is cut; the command never is.
  const long = describeRequest({ kind: "hook", toolName: "bash", toolArgs: { command: "x".repeat(5000) }, hookMessage: "m".repeat(1000) });
  assert.equal(long.preview.length, 5000);
  assert.equal(long.label.length, 300);
});

test("the other kinds are as they were", () => {
  assert.deepEqual([describeRequest({ kind: "shell", fullCommandText: "ls" }).preview, describeRequest({ kind: "shell", fullCommandText: "ls" }).label], ["ls", "Shell command"]);
  assert.equal(describeRequest({ kind: "shell", fullCommandText: "ls", intention: "List files" }).title, "List files");
});
